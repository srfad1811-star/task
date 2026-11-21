import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import { getDb, logAudit } from './db.ts';
import {
  decryptSecret,
  encryptSecret,
  redactStreamCredentials,
  verifyPlaybackToken,
} from './cryptoUtils.ts';
import {
  generateTimeLimitedPlaybackUrl,
  getPublicCloudStorageConfig,
  getStorageAnalytics,
  testCloudStorageConnection,
  updateCloudStorageConfig,
  type StorageProviderType,
} from './cloudStorage.ts';
import {
  checkFfmpegAvailable,
  getLiveRecordingMonitorData,
  getWorkerIdentity,
  importAuthorizedHistoricalVideo,
  installRuntimeFfmpeg,
  matchAutosaveEntriesToVideoArchive,
  probeStreamUrl,
  restartChannelRecording,
  retryFailedCloudUploads,
  startChannelRecording,
  stopChannelRecording,
} from './recordingEngine.ts';

const router = express.Router();

interface AuthedRequest extends Request {
  authUser?: { id: string; username: string; role: string };
}

function resolveAuthUser(req: AuthedRequest) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    const sess = getDb()
      .prepare(
        `SELECT s.user_id, s.username, u.role, s.expires_at
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND u.is_active = 1`
      )
      .get(token) as
      | { user_id: string; username: string; role: string; expires_at: string }
      | undefined;
    if (sess && new Date(sess.expires_at).getTime() > Date.now()) {
      return { id: sess.user_id, username: sess.username, role: sess.role };
    }
  }
  return null;
}

function requireRole(allowedRoles: Array<'SUPER_ADMIN' | 'ADMIN' | 'OPERATOR'>) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const u = resolveAuthUser(req);
    if (!u) {
      res.status(401).json({ error: 'Authentication required for recording control operations.' });
      return;
    }
    if (!allowedRoles.includes(u.role as any)) {
      res.status(403).json({ error: `Role "${u.role}" is not permitted to perform this operation.` });
      return;
    }
    req.authUser = u;
    next();
  };
}

// ---------------------------------------------------------------------------
// 1. LIVE 24/7 RECORDING MONITOR & WORKER HEALTH
// ---------------------------------------------------------------------------
router.get('/api/recording/monitor', async (_req, res) => {
  const ffmpeg = await checkFfmpegAvailable();
  const data = getLiveRecordingMonitorData();
  res.json({
    ...data,
    ffmpeg,
  });
});

router.get('/api/recording/health', async (_req, res) => {
  const ffmpeg = await checkFfmpegAvailable();
  const storage = getPublicCloudStorageConfig();
  res.json({
    worker: getWorkerIdentity(),
    ffmpeg,
    cloudStorageConfigured: storage.isConfigured,
    cloudStorageProvider: storage.provider,
    timestamp: new Date().toISOString(),
  });
});

router.post('/api/recording/install-ffmpeg', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), async (_req, res) => {
  const result = await installRuntimeFfmpeg();
  if (!result.ok) {
    res.status(500).json({ error: result.error || 'Failed to install FFmpeg runtime.' });
    return;
  }
  res.json(result);
});

// ---------------------------------------------------------------------------
// 2. RECORDING SOURCES (AUTHORIZED STREAMS — CREDENTIALS ENCRYPTED AT REST)
// ---------------------------------------------------------------------------
router.get('/api/recording/sources', (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT
         id, channel_key, channel_name, source_type, stream_url_redacted,
         historical_archive_endpoint, recording_permission, segment_duration_seconds,
         is_enabled, auto_record_24_7, reconnect_delay_sec, last_probe_status,
         last_probe_at, last_probe_error, video_codec, resolution, notes, created_at, updated_at
       FROM recording_sources
       ORDER BY channel_name ASC`
    )
    .all();
  res.json(rows);
});

router.post('/api/recording/sources', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req: AuthedRequest, res) => {
  const {
    channelKey,
    sourceType,
    streamUrl,
    historicalArchiveEndpoint,
    recordingPermission,
    segmentDurationSeconds,
    isEnabled,
    autoRecord247,
    reconnectDelaySec,
    notes,
  } = req.body as {
    channelKey?: string;
    sourceType?: string;
    streamUrl?: string;
    historicalArchiveEndpoint?: string;
    recordingPermission?: string;
    segmentDurationSeconds?: number;
    isEnabled?: boolean;
    autoRecord247?: boolean;
    reconnectDelaySec?: number;
    notes?: string;
  };

  if (!channelKey || !streamUrl || !streamUrl.trim()) {
    res.status(400).json({ error: 'channelKey and authorized streamUrl are required.' });
    return;
  }

  const db = getDb();
  const channel = db
    .prepare(`SELECT id, channel_name FROM channels WHERE id = ?`)
    .get(channelKey) as { id: string; channel_name: string } | undefined;

  if (!channel) {
    res.status(404).json({ error: 'Selected channel does not exist.' });
    return;
  }

  const perm = ['AUTHORIZED', 'PLAYBACK_ONLY', 'RESTRICTED'].includes(recordingPermission || '')
    ? recordingPermission!
    : 'AUTHORIZED';
  const cleanUrl = streamUrl.trim();
  const encrypted = encryptSecret(cleanUrl);
  const redacted = redactStreamCredentials(cleanUrl);
  const now = new Date().toISOString();

  const existing = db
    .prepare(`SELECT id FROM recording_sources WHERE channel_key = ? LIMIT 1`)
    .get(channel.id) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE recording_sources SET
         channel_name = ?,
         source_type = ?,
         stream_url_encrypted = ?,
         stream_url_redacted = ?,
         historical_archive_endpoint = ?,
         recording_permission = ?,
         segment_duration_seconds = ?,
         is_enabled = ?,
         auto_record_24_7 = ?,
         reconnect_delay_sec = ?,
         notes = ?,
         updated_at = ?
       WHERE id = ?`
    ).run(
      channel.channel_name,
      sourceType || 'HLS_M3U8',
      encrypted,
      redacted,
      historicalArchiveEndpoint?.trim() || null,
      perm,
      Math.max(30, Math.min(7200, Number(segmentDurationSeconds) || 3600)),
      isEnabled === false ? 0 : 1,
      autoRecord247 ? 1 : 0,
      Math.max(3, Math.min(120, Number(reconnectDelaySec) || 10)),
      notes?.trim() || null,
      now,
      existing.id
    );

    logAudit({
      entityType: 'RECORDING_SOURCE',
      entityId: existing.id,
      action: 'RECORDING_SOURCE_UPDATED',
      notes: `Updated stream source for ${channel.channel_name} (${perm}) by ${req.authUser?.username}`,
    });
    res.json({ ok: true, id: existing.id, streamUrlRedacted: redacted });
    return;
  }

  const id = `rsrc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT INTO recording_sources (
       id, channel_key, channel_name, source_type, stream_url_encrypted, stream_url_redacted,
       historical_archive_endpoint, recording_permission, segment_duration_seconds,
       is_enabled, auto_record_24_7, reconnect_delay_sec, notes, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    channel.id,
    channel.channel_name,
    sourceType || 'HLS_M3U8',
    encrypted,
    redacted,
    historicalArchiveEndpoint?.trim() || null,
    perm,
    Math.max(30, Math.min(7200, Number(segmentDurationSeconds) || 3600)),
    isEnabled === false ? 0 : 1,
    autoRecord247 ? 1 : 0,
    Math.max(3, Math.min(120, Number(reconnectDelaySec) || 10)),
    notes?.trim() || null,
    now,
    now
  );

  logAudit({
    entityType: 'RECORDING_SOURCE',
    entityId: id,
    action: 'RECORDING_SOURCE_CREATED',
    notes: `Configured authorized recording source for ${channel.channel_name} by ${req.authUser?.username}`,
  });

  res.status(201).json({ ok: true, id, streamUrlRedacted: redacted });
});

router.patch('/api/recording/sources/:id', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req: AuthedRequest, res) => {
  const { isEnabled, autoRecord247, recordingPermission, segmentDurationSeconds } = req.body as {
    isEnabled?: boolean;
    autoRecord247?: boolean;
    recordingPermission?: string;
    segmentDurationSeconds?: number;
  };
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE recording_sources SET
       is_enabled = COALESCE(?, is_enabled),
       auto_record_24_7 = COALESCE(?, auto_record_24_7),
       recording_permission = COALESCE(?, recording_permission),
       segment_duration_seconds = COALESCE(?, segment_duration_seconds),
       updated_at = ?
     WHERE id = ?`
  ).run(
    isEnabled !== undefined ? (isEnabled ? 1 : 0) : null,
    autoRecord247 !== undefined ? (autoRecord247 ? 1 : 0) : null,
    recordingPermission || null,
    segmentDurationSeconds !== undefined
      ? Math.max(30, Math.min(7200, Number(segmentDurationSeconds)))
      : null,
    now,
    req.params.id
  );
  res.json({ ok: true });
});

router.post('/api/recording/sources/:id/probe', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), async (req, res) => {
  const db = getDb();
  const src = db
    .prepare(`SELECT id, stream_url_encrypted FROM recording_sources WHERE id = ?`)
    .get(req.params.id) as { id: string; stream_url_encrypted: string } | undefined;

  if (!src) {
    res.status(404).json({ error: 'Recording source not found.' });
    return;
  }

  const rawUrl = decryptSecret(src.stream_url_encrypted);
  const result = await probeStreamUrl(rawUrl);
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE recording_sources SET
       last_probe_status = ?,
       last_probe_at = ?,
       last_probe_error = ?,
       video_codec = COALESCE(?, video_codec),
       resolution = COALESCE(?, resolution),
       updated_at = ?
     WHERE id = ?`
  ).run(
    result.reachable ? 'ONLINE' : 'UNREACHABLE',
    now,
    result.error,
    result.videoCodec,
    result.resolution,
    now,
    src.id
  );

  res.json(result);
});

router.delete('/api/recording/sources/:id', requireRole(['SUPER_ADMIN', 'ADMIN']), (req: AuthedRequest, res) => {
  getDb().prepare(`DELETE FROM recording_sources WHERE id = ?`).run(req.params.id);
  logAudit({
    entityType: 'RECORDING_SOURCE',
    entityId: req.params.id,
    action: 'RECORDING_SOURCE_DELETED',
    notes: `Deleted by ${req.authUser?.username}`,
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 3. RECORDING ENGINE CONTROLS (START / STOP / RESTART / SCHEDULES)
// ---------------------------------------------------------------------------
router.post('/api/recording/start', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), async (req: AuthedRequest, res) => {
  const { channelKey, sourceId } = req.body as { channelKey?: string; sourceId?: string };
  if (!channelKey) {
    res.status(400).json({ error: 'channelKey is required.' });
    return;
  }
  const result = await startChannelRecording({
    channelKey,
    sourceId,
    triggeredBy: req.authUser?.username || 'operator',
    autoRecover: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result);
});

router.post('/api/recording/stop', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), async (req: AuthedRequest, res) => {
  const { channelKey } = req.body as { channelKey?: string };
  if (!channelKey) {
    res.status(400).json({ error: 'channelKey is required.' });
    return;
  }
  const result = await stopChannelRecording(channelKey, req.authUser?.username || 'operator');
  res.json(result);
});

router.post('/api/recording/restart', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), async (req: AuthedRequest, res) => {
  const { channelKey } = req.body as { channelKey?: string };
  if (!channelKey) {
    res.status(400).json({ error: 'channelKey is required.' });
    return;
  }
  const result = await restartChannelRecording(channelKey, req.authUser?.username || 'operator');
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result);
});

router.post('/api/recording/start-all', requireRole(['SUPER_ADMIN', 'ADMIN']), async (req: AuthedRequest, res) => {
  const sources = getDb()
    .prepare(
      `SELECT id, channel_key, channel_name FROM recording_sources
       WHERE is_enabled = 1 AND recording_permission = 'AUTHORIZED'`
    )
    .all() as Array<{ id: string; channel_key: string; channel_name: string }>;

  const results: Array<{ channelName: string; ok: boolean; error?: string }> = [];
  for (const s of sources) {
    const r = await startChannelRecording({
      channelKey: s.channel_key,
      sourceId: s.id,
      triggeredBy: req.authUser?.username || 'admin',
      autoRecover: true,
    });
    results.push({ channelName: s.channel_name, ok: r.ok, error: r.error });
  }
  res.json({ started: results.filter((r) => r.ok).length, total: sources.length, results });
});

router.get('/api/recording/schedules', (_req, res) => {
  const rows = getDb()
    .prepare(`SELECT * FROM recording_schedules ORDER BY channel_name ASC`)
    .all();
  res.json(rows);
});

router.post('/api/recording/schedules', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req: AuthedRequest, res) => {
  const { channelKey, mode, startTime, endTime, daysOfWeek, isEnabled } = req.body as {
    channelKey?: string;
    mode?: 'CONTINUOUS_24_7' | 'SCHEDULED';
    startTime?: string;
    endTime?: string;
    daysOfWeek?: string;
    isEnabled?: boolean;
  };
  if (!channelKey) {
    res.status(400).json({ error: 'channelKey is required.' });
    return;
  }
  const db = getDb();
  const src = db
    .prepare(`SELECT id, channel_name FROM recording_sources WHERE channel_key = ? LIMIT 1`)
    .get(channelKey) as { id: string; channel_name: string } | undefined;

  if (!src) {
    res.status(400).json({ error: 'Configure an authorized recording source for this channel first.' });
    return;
  }

  const id = `sch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO recording_schedules (
       id, channel_key, channel_name, source_id, mode, start_time, end_time,
       days_of_week, is_enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    channelKey,
    src.channel_name,
    src.id,
    mode || 'CONTINUOUS_24_7',
    startTime || null,
    endTime || null,
    daysOfWeek || 'MON,TUE,WED,THU,FRI,SAT,SUN',
    isEnabled === false ? 0 : 1,
    now,
    now
  );
  res.status(201).json({ ok: true, id });
});

router.delete('/api/recording/schedules/:id', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req, res) => {
  getDb().prepare(`DELETE FROM recording_schedules WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 4. CHANNEL-WISE VIDEO ARCHIVE (Channel -> Year -> Month -> Date -> Segments)
// ---------------------------------------------------------------------------
router.get('/api/archive/tree', (req, res) => {
  const { channelKey, date, time } = req.query as {
    channelKey?: string;
    date?: string;
    time?: string;
  };
  const db = getDb();

  const where: string[] = ['is_verified = 1'];
  const params: unknown[] = [];

  if (channelKey && channelKey !== 'ALL') {
    where.push('channel_key = ?');
    params.push(channelKey);
  }
  if (date) {
    where.push('record_date = ?');
    params.push(date);
  }
  if (time) {
    const parts = time.split(':').map(Number);
    if (!Number.isNaN(parts[0])) {
      const sec = parts[0] * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
      where.push('start_seconds <= ? AND end_seconds >= ?');
      params.push(sec, sec);
    }
  }

  const segments = db
    .prepare(
      `SELECT
         id, channel_key, channel_name, record_date, year, month, day,
         start_time_iso, end_time_iso, start_seconds, end_seconds, duration_seconds,
         file_size_bytes, storage_provider, bucket, object_key, source_origin, created_at
       FROM video_archive
       WHERE ${where.join(' AND ')}
       ORDER BY channel_name ASC, year DESC, month DESC, day DESC, start_seconds ASC`
    )
    .all(...params) as Array<any>;

  // Build hierarchical tree: Channel -> Year -> Month -> Date -> Segments + missing hours
  const treeMap = new Map<string, any>();

  for (const seg of segments) {
    if (!treeMap.has(seg.channel_key)) {
      treeMap.set(seg.channel_key, {
        channelKey: seg.channel_key,
        channelName: seg.channel_name,
        totalSegments: 0,
        totalBytes: 0,
        years: new Map<number, any>(),
      });
    }
    const chNode = treeMap.get(seg.channel_key);
    chNode.totalSegments++;
    chNode.totalBytes += seg.file_size_bytes || 0;

    if (!chNode.years.has(seg.year)) {
      chNode.years.set(seg.year, { year: seg.year, months: new Map<number, any>() });
    }
    const yNode = chNode.years.get(seg.year);

    if (!yNode.months.has(seg.month)) {
      yNode.months.set(seg.month, { month: seg.month, dates: new Map<string, any>() });
    }
    const mNode = yNode.months.get(seg.month);

    if (!mNode.dates.has(seg.record_date)) {
      mNode.dates.set(seg.record_date, {
        recordDate: seg.record_date,
        day: seg.day,
        segments: [],
        coveredHours: new Set<number>(),
      });
    }
    const dNode = mNode.dates.get(seg.record_date);
    dNode.segments.push(seg);

    const startHr = Math.max(0, Math.min(23, Math.floor(seg.start_seconds / 3600)));
    const endHr = Math.max(startHr, Math.min(23, Math.floor(Math.max(seg.start_seconds, seg.end_seconds - 1) / 3600)));
    for (let h = startHr; h <= endHr; h++) {
      dNode.coveredHours.add(h);
    }
  }

  const tree = Array.from(treeMap.values()).map((ch) => ({
    channelKey: ch.channelKey,
    channelName: ch.channelName,
    totalSegments: ch.totalSegments,
    totalBytes: ch.totalBytes,
    years: Array.from(ch.years.values()).map((y: any) => ({
      year: y.year,
      months: Array.from(y.months.values()).map((m: any) => ({
        month: m.month,
        dates: Array.from(m.dates.values()).map((d: any) => {
          const missingHours: number[] = [];
          for (let h = 0; h < 24; h++) {
            if (!d.coveredHours.has(h)) missingHours.push(h);
          }
          return {
            recordDate: d.recordDate,
            day: d.day,
            coveredHoursCount: d.coveredHours.size,
            missingHours,
            segments: d.segments,
          };
        }),
      })),
    })),
  }));

  res.json({ totalSegments: segments.length, tree, segments });
});

// ---------------------------------------------------------------------------
// 5. SECURE TIME-LIMITED PLAYBACK URL & RANGE STREAMING
// ---------------------------------------------------------------------------
router.get('/api/archive/:id/playback-url', async (req, res) => {
  const db = getDb();
  const seg = db
    .prepare(
      `SELECT
         id, channel_key, channel_name, record_date, start_time_iso, end_time_iso,
         start_seconds, end_seconds, duration_seconds, file_size_bytes, storage_provider, source_origin
       FROM video_archive WHERE id = ? AND is_verified = 1`
    )
    .get(req.params.id) as any;

  if (!seg) {
    res.status(404).json({ error: 'Verified video segment not found.' });
    return;
  }

  const playback = await generateTimeLimitedPlaybackUrl(seg.id);
  if (!playback) {
    res.status(404).json({
      error: 'Video file is currently unavailable in cloud object storage or local staging.',
    });
    return;
  }

  // Find adjacent previous & next segments for seamless auto-continuation
  const prevSegment = db
    .prepare(
      `SELECT id, start_time_iso, end_time_iso, start_seconds, end_seconds, record_date
       FROM video_archive
       WHERE channel_key = ? AND is_verified = 1
         AND (record_date < ? OR (record_date = ? AND start_seconds < ?))
       ORDER BY record_date DESC, start_seconds DESC
       LIMIT 1`
    )
    .get(seg.channel_key, seg.record_date, seg.record_date, seg.start_seconds);

  const nextSegment = db
    .prepare(
      `SELECT id, start_time_iso, end_time_iso, start_seconds, end_seconds, record_date
       FROM video_archive
       WHERE channel_key = ? AND is_verified = 1
         AND (record_date > ? OR (record_date = ? AND start_seconds > ?))
       ORDER BY record_date ASC, start_seconds ASC
       LIMIT 1`
    )
    .get(seg.channel_key, seg.record_date, seg.record_date, seg.start_seconds);

  // Also fetch matched autosave entries inside this video segment
  const matchedEntries = db
    .prepare(
      `SELECT
         m.entry_id, m.offset_seconds, e.entry_type, e.caption_name, e.brand_name,
         e.start_time, e.end_time, e.duration_seconds, e.qa_status
       FROM video_timestamp_matches m
       JOIN entries e ON e.id = m.entry_id
       WHERE m.archive_id = ? AND m.match_status = 'MATCHED'
       ORDER BY m.offset_seconds ASC`
    )
    .all(seg.id);

  res.json({
    segment: seg,
    playbackUrl: playback.url,
    expiresAt: playback.expiresAt,
    storageProvider: playback.storageProvider,
    prevSegment: prevSegment ?? null,
    nextSegment: nextSegment ?? null,
    matchedEntries,
  });
});

// HMAC-signed range-capable media streaming for verified local-staged segments
router.get('/api/video/stream/:id', (req, res) => {
  const exp = Number(req.query.exp);
  const token = String(req.query.token || '');
  if (!verifyPlaybackToken(req.params.id, exp, token)) {
    res.status(403).json({ error: 'Playback URL expired or invalid signature.' });
    return;
  }

  const row = getDb()
    .prepare(`SELECT local_fallback_path FROM video_archive WHERE id = ? AND is_verified = 1`)
    .get(req.params.id) as { local_fallback_path: string | null } | undefined;

  if (!row?.local_fallback_path || !fs.existsSync(row.local_fallback_path)) {
    res.status(404).json({ error: 'Video segment file not found.' });
    return;
  }

  const filePath = row.local_fallback_path;
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'private, max-age=60',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=60',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ---------------------------------------------------------------------------
// 6. HISTORICAL VIDEO SEARCH & AUTHORIZED IMPORT
// ---------------------------------------------------------------------------
router.get('/api/historical/search', (req, res) => {
  const { channelKey, dateFrom, dateTo } = req.query as {
    channelKey?: string;
    dateFrom?: string;
    dateTo?: string;
  };
  const db = getDb();

  if (!channelKey) {
    res.status(400).json({ error: 'channelKey is required.' });
    return;
  }

  const channel = db
    .prepare(`SELECT id, channel_name FROM channels WHERE id = ?`)
    .get(channelKey) as { id: string; channel_name: string } | undefined;

  if (!channel) {
    res.status(404).json({ error: 'Channel not found.' });
    return;
  }

  const source = db
    .prepare(
      `SELECT id, recording_permission, historical_archive_endpoint FROM recording_sources WHERE channel_key = ? LIMIT 1`
    )
    .get(channelKey) as
    | { id: string; recording_permission: string; historical_archive_endpoint: string | null }
    | undefined;

  const end = dateTo ? new Date(`${dateTo}T00:00:00Z`) : new Date();
  const start = dateFrom
    ? new Date(`${dateFrom}T00:00:00Z`)
    : new Date(end.getTime() - 6 * 86400_000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    res.status(400).json({ error: 'Invalid date range.' });
    return;
  }

  // Cap search window to 60 days per query
  const maxDays = 60;
  const days: Array<{
    date: string;
    status: 'COMPLETE_24H' | 'PARTIAL' | 'UNAVAILABLE';
    coveredHours: number;
    availableHourList: number[];
    missingHourList: number[];
    segmentCount: number;
    totalBytes: number;
    autosaveEntryCount: number;
    segments: Array<{ id: string; start_seconds: number; end_seconds: number; duration_seconds: number }>;
  }> = [];

  const archiveStmt = db.prepare(
    `SELECT id, start_seconds, end_seconds, duration_seconds, file_size_bytes
     FROM video_archive
     WHERE channel_key = ? AND record_date = ? AND is_verified = 1
     ORDER BY start_seconds ASC`
  );
  const entryCountStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM entries WHERE channel_key = ? AND trans_date = ? AND is_deleted_record = 0`
  );

  const cursor = new Date(start.getTime());
  let iter = 0;
  while (cursor <= end && iter < maxDays) {
    iter++;
    const dateStr = cursor.toISOString().slice(0, 10);
    const segs = archiveStmt.all(channelKey, dateStr) as Array<{
      id: string;
      start_seconds: number;
      end_seconds: number;
      duration_seconds: number;
      file_size_bytes: number;
    }>;

    const hourSet = new Set<number>();
    let totalBytes = 0;
    for (const s of segs) {
      totalBytes += s.file_size_bytes || 0;
      const sh = Math.max(0, Math.min(23, Math.floor(s.start_seconds / 3600)));
      const eh = Math.max(sh, Math.min(23, Math.floor(Math.max(s.start_seconds, s.end_seconds - 1) / 3600)));
      for (let h = sh; h <= eh; h++) hourSet.add(h);
    }

    const availableHourList = Array.from(hourSet).sort((a, b) => a - b);
    const missingHourList: number[] = [];
    for (let h = 0; h < 24; h++) {
      if (!hourSet.has(h)) missingHourList.push(h);
    }

    let status: 'COMPLETE_24H' | 'PARTIAL' | 'UNAVAILABLE' = 'UNAVAILABLE';
    if (availableHourList.length === 24) status = 'COMPLETE_24H';
    else if (availableHourList.length > 0) status = 'PARTIAL';

    const autosaveEntryCount = (entryCountStmt.get(channelKey, dateStr) as { c: number }).c;

    days.push({
      date: dateStr,
      status,
      coveredHours: availableHourList.length,
      availableHourList,
      missingHourList,
      segmentCount: segs.length,
      totalBytes,
      autosaveEntryCount,
      segments: segs.map((s) => ({
        id: s.id,
        start_seconds: s.start_seconds,
        end_seconds: s.end_seconds,
        duration_seconds: s.duration_seconds,
      })),
    });

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  days.reverse(); // Newest date first

  res.json({
    channel,
    recordingPermission: source?.recording_permission ?? 'NOT_CONFIGURED',
    historicalArchiveEndpoint: source?.historical_archive_endpoint ?? null,
    notice:
      'Autosave XML files contain schedule/broadcast metadata only — never video. Dates marked UNAVAILABLE have no verified recording in cloud storage.',
    days,
  });
});

router.post('/api/historical/import', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), async (req: AuthedRequest, res) => {
  const { channelKey, recordDate, startHour, sourceUrl } = req.body as {
    channelKey?: string;
    recordDate?: string;
    startHour?: number;
    sourceUrl?: string;
  };
  if (!channelKey || !recordDate || !sourceUrl) {
    res.status(400).json({ error: 'channelKey, recordDate (YYYY-MM-DD), and authorized sourceUrl are required.' });
    return;
  }

  const result = await importAuthorizedHistoricalVideo({
    channelKey,
    recordDate,
    startHour: Number(startHour) || 0,
    sourceUrl,
    triggeredBy: req.authUser?.username || 'operator',
  });

  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result);
});

// ---------------------------------------------------------------------------
// 7. AUTOSAVE IMPORT -> CLOUD VIDEO ARCHIVE TIMESTAMP MATCHING
// ---------------------------------------------------------------------------
router.post('/api/autosave/match-video', (req, res) => {
  const { channelKey, recordDate, batchId } = req.body as {
    channelKey?: string;
    recordDate?: string;
    batchId?: string;
  };
  const summary = matchAutosaveEntriesToVideoArchive({ channelKey, recordDate, batchId });
  res.json({ ok: true, ...summary });
});

router.get('/api/autosave/matches', (req, res) => {
  const { channelKey, recordDate, batchId } = req.query as {
    channelKey?: string;
    recordDate?: string;
    batchId?: string;
  };
  const db = getDb();
  const where: string[] = ['e.is_deleted_record = 0'];
  const params: unknown[] = [];

  if (channelKey && channelKey !== 'ALL') {
    where.push('e.channel_key = ?');
    params.push(channelKey);
  }
  if (recordDate) {
    where.push('e.trans_date = ?');
    params.push(recordDate);
  }
  if (batchId) {
    where.push('e.batch_id = ?');
    params.push(batchId);
  }

  const rows = db
    .prepare(
      `SELECT
         e.id AS entry_id, e.channel_key, e.channel_name, e.trans_date,
         e.entry_type, e.caption_name, e.brand_name, e.start_time, e.end_time,
         e.start_seconds, e.duration_seconds, e.qa_status,
         COALESCE(m.match_status, 'VIDEO_NOT_AVAILABLE') AS match_status,
         m.archive_id, m.offset_seconds, m.matched_at
       FROM entries e
       LEFT JOIN video_timestamp_matches m ON m.entry_id = e.id
       WHERE ${where.join(' AND ')}
       ORDER BY e.trans_date DESC, e.start_seconds ASC
       LIMIT 300`
    )
    .all(...params);

  res.json(rows);
});

// ---------------------------------------------------------------------------
// 8. CLOUD STORAGE ANALYTICS, CONFIGURATION & UPLOAD RETRIES
// ---------------------------------------------------------------------------
router.get('/api/storage/analytics', (_req, res) => {
  res.json(getStorageAnalytics());
});

router.get('/api/storage/config', (_req, res) => {
  res.json(getPublicCloudStorageConfig());
});

router.put('/api/storage/config', requireRole(['SUPER_ADMIN', 'ADMIN']), (req: AuthedRequest, res) => {
  const body = req.body as {
    provider?: StorageProviderType;
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    publicBaseUrl?: string;
    retentionDays?: number;
    storageBudgetGb?: number;
    warningThresholdPct?: number;
    costPerGbMonthUsd?: number;
    defaultSegmentSeconds?: number;
    deleteLocalAfterVerifiedUpload?: boolean;
    signedUrlExpirySeconds?: number;
  };
  const updated = updateCloudStorageConfig(body);
  res.json(updated);
});

router.post('/api/storage/test', requireRole(['SUPER_ADMIN', 'ADMIN']), async (_req, res) => {
  const result = await testCloudStorageConnection();
  res.json(result);
});

router.post('/api/storage/retry-uploads', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), async (_req, res) => {
  const result = await retryFailedCloudUploads();
  res.json(result);
});

// ---------------------------------------------------------------------------
// 9. RECORDING LOGS (ERRORS, SESSIONS, CLOUD UPLOADS)
// ---------------------------------------------------------------------------
router.get('/api/recording/logs', (req, res) => {
  const { channelKey, limit } = req.query as { channelKey?: string; limit?: string };
  const lim = Math.min(Number(limit) || 150, 500);
  const db = getDb();

  const errWhere = channelKey && channelKey !== 'ALL' ? 'WHERE channel_key = ?' : '';
  const errParams = channelKey && channelKey !== 'ALL' ? [channelKey, lim] : [lim];

  const errors = db
    .prepare(`SELECT * FROM recording_errors ${errWhere} ORDER BY created_at DESC LIMIT ?`)
    .all(...errParams);

  const sessions = db
    .prepare(`SELECT * FROM recording_sessions ${errWhere} ORDER BY started_at DESC LIMIT ?`)
    .all(...errParams);

  const uploads = db
    .prepare(
      `SELECT u.*, s.file_name, s.channel_name, s.record_date
       FROM cloud_uploads u
       LEFT JOIN recording_segments s ON s.id = u.segment_id
       ${channelKey && channelKey !== 'ALL' ? 'WHERE u.channel_key = ?' : ''}
       ORDER BY u.created_at DESC
       LIMIT ?`
    )
    .all(...errParams);

  res.json({ errors, sessions, uploads });
});

router.patch('/api/recording/errors/:id/resolve', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req, res) => {
  getDb().prepare(`UPDATE recording_errors SET resolved = 1 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

export default router;
