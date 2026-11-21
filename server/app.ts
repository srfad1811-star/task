import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import type {
  ChannelEntry,
  ChannelSummary,
  CustomFieldMapping,
  DashboardMetrics,
  QaThresholds,
} from '../src/types.ts';
import {
  DB_PATH,
  XML_ARCHIVE_DIR,
  createDatabaseBackup,
  getCustomEntryTypeMappings,
  getCustomFieldMappings,
  getDb,
  getQaThresholds,
  logAudit,
  reopenDatabase,
} from './db.ts';
import { type ReportType, generateExcelReport } from './excelExport.ts';
import { type UploadedFileInput, commitAutosaveImport, inspectAutosaveFiles } from './importService.ts';
import { runAutomaticQa } from './qaEngine.ts';
import { reclassifyStoredEntries } from './reclassify.ts';
import { normalizeEntryType, parseDurationToSeconds, parseTimeToSeconds } from './xmlParser.ts';
import mediaRouter, { requireAuth, requireRole } from './mediaRouter.ts';
import cloudRecordingRouter from './cloudRecordingRouter.ts';
import {
  matchAutosaveEntriesToVideoArchive
} from './recordingEngine.ts';

export function createApiApp(): express.Express {
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(mediaRouter);
app.use(cloudRecordingRouter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB per file
    files: 500,
  },
});

function extractUploadedFiles(req: express.Request): UploadedFileInput[] {
  const files = (req.files as Express.Multer.File[]) ?? [];
  let relPaths: string[] = [];
  if (typeof req.body?.relativePaths === 'string') {
    try {
      const parsed = JSON.parse(req.body.relativePaths);
      if (Array.isArray(parsed)) relPaths = parsed;
    } catch {
      relPaths = [];
    }
  }
  return files.map((f, idx) => ({
    originalName: f.originalname,
    relativePath: relPaths[idx] || f.originalname,
    buffer: f.buffer,
  }));
}

function getDirectorySize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) total += getDirectorySize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 1. DASHBOARD
// ---------------------------------------------------------------------------
app.get('/api/dashboard', requireAuth, (_req, res) => {
  const db = getDb();

  const totalChannels = (db.prepare(`SELECT COUNT(*) AS c FROM channels`).get() as { c: number }).c;
  const importedChannels = (
    db.prepare(`SELECT COUNT(DISTINCT channel_key) AS c FROM entries WHERE is_deleted_record = 0`).get() as {
      c: number;
    }
  ).c;

  const entryCounts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN entry_type = 'PROGRAM' THEN 1 ELSE 0 END) AS programs,
         SUM(CASE WHEN entry_type = 'SPOT/TVC' THEN 1 ELSE 0 END) AS spot_tvcs,
         SUM(CASE WHEN entry_type = 'MEDIA' THEN 1 ELSE 0 END) AS media,
         SUM(CASE WHEN entry_type = 'SPONSORSHIP' THEN 1 ELSE 0 END) AS sponsorships,
         ROUND(COALESCE(SUM(CASE WHEN entry_type = 'PROGRAM' THEN duration_seconds ELSE 0 END), 0), 2) AS program_duration_sec,
         ROUND(COALESCE(SUM(CASE WHEN entry_type = 'SPOT/TVC' THEN duration_seconds ELSE 0 END), 0), 2) AS spot_tvc_duration_sec,
         ROUND(COALESCE(SUM(CASE WHEN entry_type = 'MEDIA' THEN duration_seconds ELSE 0 END), 0), 2) AS media_duration_sec,
         ROUND(COALESCE(SUM(CASE WHEN entry_type = 'SPONSORSHIP' THEN duration_seconds ELSE 0 END), 0), 2) AS sponsorship_duration_sec,
         SUM(CASE WHEN qa_status = 'YELLOW' THEN 1 ELSE 0 END) AS yellow_entries,
         SUM(CASE WHEN qa_status = 'RED' THEN 1 ELSE 0 END) AS red_entries,
         SUM(CASE WHEN qa_status = 'GREEN' THEN 1 ELSE 0 END) AS green_entries,
         SUM(CASE WHEN qa_status = 'PENDING' THEN 1 ELSE 0 END) AS pending_qa,
         SUM(CASE WHEN is_reviewed_caption = 1 THEN 1 ELSE 0 END) AS reviewed_captions
       FROM entries WHERE is_deleted_record = 0`
    )
    .get() as Record<string, number | null>;

  const deletedRecordsCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE is_deleted_record = 1`).get() as { c: number }
  ).c;

  const issueBreakdown = db
    .prepare(
      `SELECT
         SUM(CASE WHEN rule_code IN ('TL_MISSING_MASTER_ID', 'TL_INDEX_SEQUENCE_JUMP', 'TL_SUSPECTED_GAP', 'TL_DELETED_RECORD_GAP', 'PROG_SUSPICIOUS_SEQUENCE') THEN 1 ELSE 0 END) AS missing_seq,
         SUM(CASE WHEN rule_code LIKE '%DUPLICATE%' THEN 1 ELSE 0 END) AS duplicates,
         SUM(CASE WHEN rule_code LIKE '%DURATION%' THEN 1 ELSE 0 END) AS duration_errors
       FROM qa_issues`
    )
    .get() as Record<string, number | null>;

  let storageUsageBytes = 0;
  try {
    if (fs.existsSync(DB_PATH)) storageUsageBytes += fs.statSync(DB_PATH).size;
    if (fs.existsSync(XML_ARCHIVE_DIR)) storageUsageBytes += getDirectorySize(XML_ARCHIVE_DIR);
  } catch {}

  const metrics: DashboardMetrics = {
    totalChannels,
    importedChannels,
    storageUsageBytes,
    totalEntries: entryCounts.total ?? 0,
    programs: entryCounts.programs ?? 0,
    spotTvcs: entryCounts.spot_tvcs ?? 0,
    media: entryCounts.media ?? 0,
    sponsorships: entryCounts.sponsorships ?? 0,
    programDurationSec: entryCounts.program_duration_sec ?? 0,
    spotTvcDurationSec: entryCounts.spot_tvc_duration_sec ?? 0,
    mediaDurationSec: entryCounts.media_duration_sec ?? 0,
    sponsorshipDurationSec: entryCounts.sponsorship_duration_sec ?? 0,
    suspiciousEntries: entryCounts.yellow_entries ?? 0,
    redErrorEntries: entryCounts.red_entries ?? 0,
    greenEntries: entryCounts.green_entries ?? 0,
    missingSequenceWarnings: issueBreakdown.missing_seq ?? 0,
    duplicateEntries: issueBreakdown.duplicates ?? 0,
    durationErrors: issueBreakdown.duration_errors ?? 0,
    pendingQa: entryCounts.pending_qa ?? 0,
    deletedRecordsCount,
    reviewedCaptionsCount: entryCounts.reviewed_captions ?? 0,
  };

  const recentImports = db
    .prepare(`SELECT * FROM import_batches ORDER BY imported_at DESC LIMIT 8`)
    .all();

  const latestQaRun = db
    .prepare(`SELECT * FROM qa_runs ORDER BY completed_at DESC LIMIT 1`)
    .get() ?? null;

  const recentIssues = db
    .prepare(
      `SELECT q.*, COALESCE(e.entry_type, q.entry_type) AS entry_type,
              e.master_entry_id, e.brand_name, e.caption_name, e.start_time, e.end_time, e.duration_seconds
       FROM qa_issues q
       LEFT JOIN entries e ON e.id = q.entry_id
       ORDER BY CASE q.severity WHEN 'RED' THEN 1 WHEN 'YELLOW' THEN 2 ELSE 3 END, q.created_at DESC
       LIMIT 12`
    )
    .all();

  const recentActivity = db
    .prepare(`SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 8`)
    .all();

  res.json({ metrics, recentImports, latestQaRun, recentIssues, recentActivity });
});

// ---------------------------------------------------------------------------
// 2. IMPORT AUTOSAVE & XML INSPECTOR
// ---------------------------------------------------------------------------
app.post('/api/import/inspect', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), upload.array('files', 500), (req, res) => {
  try {
    const files = extractUploadedFiles(req);
    if (files.length === 0) {
      res.status(400).json({ error: 'No files provided for inspection.' });
      return;
    }
    const result = inspectAutosaveFiles(files);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Inspection failed' });
  }
});

app.post('/api/import/commit', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), upload.array('files', 500), async (req, res) => {
  try {
    const files = extractUploadedFiles(req);
    if (files.length === 0) {
      res.status(400).json({ error: 'No files provided for import.' });
      return;
    }
    const forceReprocessDuplicates = req.body?.forceReprocessDuplicates === 'true';
    const runQaAfter = req.body?.runQaAfter === 'true';
    const folderName = typeof req.body?.folderName === 'string' ? req.body.folderName : undefined;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : undefined;

    const importSummary = await commitAutosaveImport({
      files,
      folderName,
      notes,
      forceReprocessDuplicates,
    });

    let qaSummary = null;
    if (runQaAfter) {
      qaSummary = runAutomaticQa();
    }

    const videoMatchSummary = matchAutosaveEntriesToVideoArchive({
      batchId: importSummary.batchId,
    });

    res.json({ ...importSummary, qaSummary, videoMatchSummary });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Import failed' });
  }
});

app.get('/api/import/batches', requireAuth, (_req, res) => {
  const batches = getDb()
    .prepare(`SELECT * FROM import_batches ORDER BY imported_at DESC`)
    .all();
  res.json(batches);
});

app.get('/api/import/batches/:batchId/files', requireAuth, (req, res) => {
  const files = getDb()
    .prepare(`SELECT * FROM xml_archive_files WHERE batch_id = ? ORDER BY file_name ASC`)
    .all(req.params.batchId);
  res.json(files);
});

app.get('/api/import/files/:fileId/raw', requireAuth, (req, res) => {
  const file = getDb()
    .prepare(`SELECT file_name, archive_path FROM xml_archive_files WHERE id = ?`)
    .get(req.params.fileId) as { file_name: string; archive_path: string } | undefined;

  if (!file || !fs.existsSync(file.archive_path)) {
    res.status(404).json({ error: 'Archived XML file not found.' });
    return;
  }
  const content = fs.readFileSync(file.archive_path);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${file.file_name}"`);
  res.send(content);
});

// ---------------------------------------------------------------------------
// 3. CHANNELS & CHANNEL VIEWER
// ---------------------------------------------------------------------------
app.get('/api/channels', requireAuth, (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         c.*,
         COUNT(CASE WHEN e.is_deleted_record = 0 THEN 1 END) AS entry_count,
         SUM(CASE WHEN e.is_deleted_record = 0 AND e.entry_type = 'PROGRAM' THEN 1 ELSE 0 END) AS program_count,
         SUM(CASE WHEN e.is_deleted_record = 0 AND e.entry_type = 'SPOT/TVC' THEN 1 ELSE 0 END) AS spot_tvc_count,
         SUM(CASE WHEN e.is_deleted_record = 0 AND e.entry_type = 'MEDIA' THEN 1 ELSE 0 END) AS media_count,
         SUM(CASE WHEN e.is_deleted_record = 0 AND e.entry_type = 'SPONSORSHIP' THEN 1 ELSE 0 END) AS sponsorship_count,
         ROUND(COALESCE(SUM(CASE WHEN e.is_deleted_record = 0 AND e.entry_type = 'PROGRAM' THEN e.duration_seconds ELSE 0 END), 0), 2) AS program_duration_sec,
         ROUND(COALESCE(SUM(CASE WHEN e.is_deleted_record = 0 AND e.entry_type = 'SPOT/TVC' THEN e.duration_seconds ELSE 0 END), 0), 2) AS spot_tvc_duration_sec,
         ROUND(COALESCE(SUM(CASE WHEN e.is_deleted_record = 0 AND e.entry_type = 'MEDIA' THEN e.duration_seconds ELSE 0 END), 0), 2) AS media_duration_sec,
         ROUND(COALESCE(SUM(CASE WHEN e.is_deleted_record = 0 AND e.entry_type = 'SPONSORSHIP' THEN e.duration_seconds ELSE 0 END), 0), 2) AS sponsorship_duration_sec,
         SUM(CASE WHEN e.is_deleted_record = 0 AND e.qa_status = 'RED' THEN 1 ELSE 0 END) AS red_count,
         SUM(CASE WHEN e.is_deleted_record = 0 AND e.qa_status = 'YELLOW' THEN 1 ELSE 0 END) AS yellow_count,
         SUM(CASE WHEN e.is_deleted_record = 0 AND e.qa_status = 'GREEN' THEN 1 ELSE 0 END) AS green_count,
         SUM(CASE WHEN e.is_deleted_record = 0 AND e.qa_status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count
       FROM channels c
       LEFT JOIN entries e ON e.channel_key = c.id
       GROUP BY c.id
       ORDER BY entry_count DESC, c.channel_name ASC`
    )
    .all() as Array<Omit<ChannelSummary, 'dates'>>;

  const dateRows = db
    .prepare(
      `SELECT DISTINCT channel_key, trans_date
       FROM entries
       WHERE trans_date IS NOT NULL
       ORDER BY trans_date DESC`
    )
    .all() as Array<{ channel_key: string; trans_date: string }>;

  const datesByChannel = new Map<string, string[]>();
  for (const r of dateRows) {
    const arr = datesByChannel.get(r.channel_key) ?? [];
    arr.push(r.trans_date);
    datesByChannel.set(r.channel_key, arr);
  }

  const result: ChannelSummary[] = rows.map((r) => ({
    ...r,
    dates: datesByChannel.get(r.id) ?? [],
  }));

  res.json(result);
});

app.post('/api/channels', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req, res) => {
  const { channelName, channelId, category, notes } = req.body as {
    channelName?: string;
    channelId?: string;
    category?: string;
    notes?: string;
  };

  const nameClean = (channelName ?? '').trim();
  const idClean = (channelId ?? '').trim();

  if (!nameClean) {
    res.status(400).json({ error: 'Channel name is required.' });
    return;
  }

  const channelKey = idClean
    ? `ch_id_${idClean.toLowerCase()}`
    : `ch_name_${nameClean.toLowerCase().replace(/\s+/g, '_')}`;

  const db = getDb();
  const existing = db.prepare(`SELECT id, channel_name FROM channels WHERE id = ?`).get(channelKey) as
    | { id: string; channel_name: string }
    | undefined;

  if (existing) {
    res.status(409).json({
      error: `Channel "${existing.channel_name}" with this ID/name already exists.`,
    });
    return;
  }

  const now = new Date().toISOString();
  const metadata = JSON.stringify({
    category: (category ?? 'General').trim() || 'General',
    notes: (notes ?? '').trim() || undefined,
  });

  db.prepare(
    `INSERT INTO channels (id, channel_id, channel_name, is_selected, source_file, first_seen_at, last_updated_at, metadata_json)
     VALUES (?, ?, ?, 1, 'manual', ?, ?, ?)`
  ).run(channelKey, idClean || null, nameClean, now, now, metadata);

  logAudit({
    entityType: 'CHANNEL',
    entityId: channelKey,
    action: 'CHANNEL_CREATED',
    notes: `Added channel "${nameClean}"${idClean ? ` (ID: ${idClean})` : ''}`,
  });

  res.status(201).json({
    ok: true,
    channel: {
      id: channelKey,
      channel_id: idClean || null,
      channel_name: nameClean,
    },
  });
});

app.post('/api/channels/bulk', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req, res) => {
  const { items } = req.body as {
    items?: Array<{ channelName?: string; channelId?: string; category?: string }>;
  };

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Provide at least one channel to add.' });
    return;
  }

  const db = getDb();
  const now = new Date().toISOString();
  let added = 0;
  let skipped = 0;

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO channels (id, channel_id, channel_name, is_selected, source_file, first_seen_at, last_updated_at, metadata_json)
     VALUES (?, ?, ?, 1, 'manual', ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (const item of items) {
      const nameClean = (item.channelName ?? '').trim();
      const idClean = (item.channelId ?? '').trim();
      if (!nameClean) continue;

      const channelKey = idClean
        ? `ch_id_${idClean.toLowerCase()}`
        : `ch_name_${nameClean.toLowerCase().replace(/\s+/g, '_')}`;

      const info = insertStmt.run(
        channelKey,
        idClean || null,
        nameClean,
        now,
        now,
        JSON.stringify({ category: (item.category ?? 'General').trim() || 'General' })
      );
      if (info.changes > 0) added++;
      else skipped++;
    }
  });
  tx();

  if (added > 0) {
    logAudit({
      entityType: 'CHANNEL',
      entityId: 'bulk',
      action: 'CHANNELS_BULK_CREATED',
      notes: `Added ${added} channels manually (${skipped} skipped as duplicates).`,
    });
  }

  res.status(201).json({ ok: true, added, skipped });
});

app.post('/api/channels/sync', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req, res) => {
  const { channels } = req.body as {
    channels?: Array<{
      id: string;
      channelId?: string | null;
      channelName: string;
      category?: string;
      notes?: string | null;
    }>;
  };

  if (!Array.isArray(channels)) {
    res.status(400).json({ error: 'channels array is required.' });
    return;
  }

  const db = getDb();
  const now = new Date().toISOString();
  const activeCloudIds = new Set<string>();

  const upsertStmt = db.prepare(
    `INSERT INTO channels (id, channel_id, channel_name, is_selected, source_file, first_seen_at, last_updated_at, metadata_json)
     VALUES (?, ?, ?, 1, 'cloud_sync', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       channel_id = COALESCE(excluded.channel_id, channels.channel_id),
       channel_name = excluded.channel_name,
       last_updated_at = excluded.last_updated_at,
       metadata_json = excluded.metadata_json`
  );

  const tx = db.transaction(() => {
    for (const ch of channels) {
      if (!ch.id || !ch.channelName) continue;
      activeCloudIds.add(ch.id);
      upsertStmt.run(
        ch.id,
        ch.channelId || null,
        ch.channelName.trim(),
        now,
        now,
        JSON.stringify({
          category: ch.category || 'General',
          notes: ch.notes || undefined,
          syncedFromCloud: true,
        })
      );
    }

    // Prune channels previously synced from cloud that were deleted in cloud (only if they have 0 autosave entries)
    const cloudRows = db
      .prepare(`SELECT id FROM channels WHERE source_file = 'cloud_sync'`)
      .all() as Array<{ id: string }>;
    const countEntriesStmt = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE channel_key = ?`);
    const deleteStmt = db.prepare(`DELETE FROM channels WHERE id = ? AND source_file = 'cloud_sync'`);

    for (const row of cloudRows) {
      if (!activeCloudIds.has(row.id)) {
        const count = (countEntriesStmt.get(row.id) as { c: number }).c;
        if (count === 0) {
          deleteStmt.run(row.id);
        }
      }
    }
  });
  tx();

  res.json({ ok: true, syncedCount: activeCloudIds.size });
});

app.delete('/api/channels/:channelKey', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req, res) => {
  const db = getDb();
  const channelKey = req.params.channelKey;
  const channel = db.prepare(`SELECT channel_name FROM channels WHERE id = ?`).get(channelKey) as
    | { channel_name: string }
    | undefined;

  if (!channel) {
    res.status(404).json({ error: 'Channel not found.' });
    return;
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM qa_issues WHERE channel_key = ?`).run(channelKey);
    db.prepare(`DELETE FROM entries WHERE channel_key = ?`).run(channelKey);
    db.prepare(`DELETE FROM channels WHERE id = ?`).run(channelKey);
  });
  tx();

  logAudit({
    entityType: 'CHANNEL',
    entityId: channelKey,
    action: 'CHANNEL_DELETED',
    notes: `Deleted channel "${channel.channel_name}" and all associated entries and QA findings.`,
  });

  res.json({ ok: true });
});

app.get('/api/channels/:channelKey/entries', requireAuth, (req, res) => {
  const db = getDb();
  const { date, entryType, includeDeleted, search } = req.query;

  const where = ['channel_key = ?'];
  const params: unknown[] = [req.params.channelKey];

  if (includeDeleted !== 'true') {
    where.push('is_deleted_record = 0');
  }
  if (typeof date === 'string' && date.trim()) {
    where.push('trans_date = ?');
    params.push(date.trim());
  }
  if (typeof entryType === 'string' && entryType.trim() && entryType !== 'ALL') {
    const normalizedType = normalizeEntryType(entryType) ?? entryType.trim();
    where.push('entry_type = ?');
    params.push(normalizedType);
  }
  if (typeof search === 'string' && search.trim()) {
    const q = `%${search.trim()}%`;
    where.push(
      `(COALESCE(caption_name,'') LIKE ? OR COALESCE(brand_name,'') LIKE ? OR COALESCE(category_name,'') LIKE ? OR COALESCE(master_entry_id,'') LIKE ? OR COALESCE(commercial_id,'') LIKE ?)`
    );
    params.push(q, q, q, q, q);
  }

  const entries = db
    .prepare(
      `SELECT * FROM entries
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(trans_date, '') ASC, COALESCE(start_seconds, 999999) ASC, COALESCE(start_index, 999999) ASC, id ASC`
    )
    .all(...params) as ChannelEntry[];

  const issues = db
    .prepare(`SELECT * FROM qa_issues WHERE channel_key = ? ORDER BY created_at DESC`)
    .all(req.params.channelKey);

  res.json({ entries, issues });
});

// ---------------------------------------------------------------------------
// 4. ALL ENTRIES & ENTRY DETAILS / EDITING
// ---------------------------------------------------------------------------
app.get('/api/entries', requireAuth, (req, res) => {
  const db = getDb();
  const {
    search,
    channelKey,
    date,
    entryType,
    qaStatus,
    includeDeleted,
    limit = '100',
    offset = '0',
  } = req.query;

  const where: string[] = [];
  const params: unknown[] = [];

  if (includeDeleted !== 'true') {
    where.push('is_deleted_record = 0');
  }
  if (typeof channelKey === 'string' && channelKey && channelKey !== 'ALL') {
    where.push('channel_key = ?');
    params.push(channelKey);
  }
  if (typeof date === 'string' && date) {
    where.push('trans_date = ?');
    params.push(date);
  }
  if (typeof entryType === 'string' && entryType && entryType !== 'ALL') {
    const normalizedType = normalizeEntryType(entryType) ?? entryType.trim();
    where.push('entry_type = ?');
    params.push(normalizedType);
  }
  if (typeof qaStatus === 'string' && qaStatus && qaStatus !== 'ALL') {
    where.push('qa_status = ?');
    params.push(qaStatus);
  }
  if (typeof search === 'string' && search.trim()) {
    const q = `%${search.trim()}%`;
    where.push(
      `(COALESCE(channel_name,'') LIKE ? OR COALESCE(caption_name,'') LIKE ? OR COALESCE(brand_name,'') LIKE ? OR COALESCE(category_name,'') LIKE ? OR COALESCE(master_entry_id,'') LIKE ? OR COALESCE(commercial_id,'') LIKE ?)`
    );
    params.push(q, q, q, q, q, q);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM entries ${whereSql}`)
    .get(...params) as { c: number };

  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);

  const rows = db
    .prepare(
      `SELECT * FROM entries ${whereSql}
       ORDER BY COALESCE(trans_date, '') DESC, channel_name ASC, COALESCE(start_seconds, 999999) ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, lim, off);

  res.json({ total: totalRow.c, entries: rows });
});

app.get('/api/entries/type-diagnostics', requireAuth, (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT
         source_role,
         entry_type,
         raw_entry_type,
         commercial_type_name,
         category_name,
         COUNT(*) AS count
       FROM entries
       WHERE is_deleted_record = 0
       GROUP BY source_role, entry_type, raw_entry_type, commercial_type_name, category_name
       ORDER BY count DESC
       LIMIT 100`
    )
    .all();
  res.json(rows);
});

app.post('/api/entries/reclassify', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req, res) => {
  const db = getDb();
  const { rawValue, targetType } = (req.body ?? {}) as { rawValue?: string; targetType?: string };
  if (rawValue && targetType) {
    const normalizedTarget = normalizeEntryType(targetType);
    if (!normalizedTarget) {
      res.status(400).json({ error: 'Invalid targetType. Must be MEDIA, SPONSORSHIP, SPOT/TVC, or PROGRAM.' });
      return;
    }
    const current = getCustomEntryTypeMappings();
    const filtered = current.filter(
      (m) => m.rawValue.trim().toUpperCase() !== rawValue.trim().toUpperCase()
    );
    filtered.push({ rawValue: rawValue.trim(), targetType: normalizedTarget });
    db.prepare(
      `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('custom_entry_type_mappings', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(JSON.stringify(filtered), new Date().toISOString());
  }
  const result = reclassifyStoredEntries({ log: true });
  res.json(result);
});

app.get('/api/entries/:id', requireAuth, (req, res) => {
  const db = getDb();
  const entry = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: 'Entry not found.' });
    return;
  }
  const issues = db.prepare(`SELECT * FROM qa_issues WHERE entry_id = ?`).all(req.params.id);
  const auditLogs = db
    .prepare(`SELECT * FROM audit_logs WHERE entity_type = 'ENTRY' AND entity_id = ? ORDER BY timestamp DESC`)
    .all(req.params.id);
  res.json({ entry, issues, auditLogs });
});

app.patch('/api/entries/:id', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req, res) => {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(req.params.id) as
    | ChannelEntry
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Entry not found.' });
    return;
  }

  const {
    entry_type,
    category_name,
    subcategory_name,
    brand_name,
    caption_name,
    start_time,
    end_time,
    duration_seconds,
    edit_notes,
  } = req.body as Record<string, unknown>;

  const nextEntryType =
    typeof entry_type === 'string'
      ? (normalizeEntryType(entry_type) ?? existing.entry_type)
      : existing.entry_type;
  const nextCategory = category_name !== undefined ? (category_name ? String(category_name) : null) : existing.category_name;
  const nextSubcategory =
    subcategory_name !== undefined ? (subcategory_name ? String(subcategory_name) : null) : existing.subcategory_name;
  const nextBrand = brand_name !== undefined ? (brand_name ? String(brand_name) : null) : existing.brand_name;
  const nextCaption = caption_name !== undefined ? (caption_name ? String(caption_name) : null) : existing.caption_name;

  let nextStartTime = existing.start_time;
  let nextStartSeconds = existing.start_seconds;
  if (start_time !== undefined) {
    const raw = start_time ? String(start_time) : '';
    const parsed = parseTimeToSeconds(raw);
    nextStartTime = parsed.normalized;
    nextStartSeconds = parsed.seconds;
  }

  let nextEndTime = existing.end_time;
  let nextEndSeconds = existing.end_seconds;
  if (end_time !== undefined) {
    const raw = end_time ? String(end_time) : '';
    const parsed = parseTimeToSeconds(raw);
    nextEndTime = parsed.normalized;
    nextEndSeconds = parsed.seconds;
  }

  let nextDuration = existing.duration_seconds;
  if (duration_seconds !== undefined && duration_seconds !== null && duration_seconds !== '') {
    nextDuration = parseDurationToSeconds(String(duration_seconds)) ?? Number(duration_seconds);
  }

  const changes: Array<[string, string | null, string | null]> = [
    ['entry_type', existing.entry_type, nextEntryType],
    ['category_name', existing.category_name, nextCategory],
    ['subcategory_name', existing.subcategory_name, nextSubcategory],
    ['brand_name', existing.brand_name, nextBrand],
    ['caption_name', existing.caption_name, nextCaption],
    ['start_time', existing.start_time, nextStartTime],
    ['end_time', existing.end_time, nextEndTime],
    [
      'duration_seconds',
      existing.duration_seconds !== null ? String(existing.duration_seconds) : null,
      nextDuration !== null ? String(nextDuration) : null,
    ],
  ];

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE entries SET
         entry_type = ?, category_name = ?, subcategory_name = ?,
         brand_name = ?, caption_name = ?,
         start_time = ?, end_time = ?, start_seconds = ?, end_seconds = ?,
         duration_seconds = ?, is_manually_edited = 1, updated_at = ?
       WHERE id = ?`
    ).run(
      nextEntryType,
      nextCategory,
      nextSubcategory,
      nextBrand,
      nextCaption,
      nextStartTime,
      nextEndTime,
      nextStartSeconds,
      nextEndSeconds,
      nextDuration,
      now,
      existing.id
    );

    // Reflect manual category correction everywhere, including existing QA issue records
    if (nextEntryType !== existing.entry_type) {
      db.prepare(`UPDATE qa_issues SET entry_type = ? WHERE entry_id = ?`).run(nextEntryType, existing.id);
    }

    for (const [field, oldV, newV] of changes) {
      if (oldV !== newV) {
        logAudit({
          entityType: 'ENTRY',
          entityId: existing.id,
          action: 'ENTRY_EDITED',
          fieldName: field,
          oldValue: oldV,
          newValue: newV,
          notes: typeof edit_notes === 'string' && edit_notes.trim() ? edit_notes.trim() : null,
        });
      }
    }
  });
  tx();

  const updated = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(existing.id);
  const issues = db.prepare(`SELECT * FROM qa_issues WHERE entry_id = ?`).all(existing.id);
  const auditLogs = db
    .prepare(`SELECT * FROM audit_logs WHERE entity_type = 'ENTRY' AND entity_id = ? ORDER BY timestamp DESC`)
    .all(existing.id);
  res.json({ entry: updated, issues, auditLogs });
});

app.post('/api/entries/:id/reset', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req, res) => {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(req.params.id) as
    | ChannelEntry
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Entry not found.' });
    return;
  }

  const orig = JSON.parse(existing.original_values_json) as {
    entryType: string;
    categoryName: string | null;
    subcategoryName: string | null;
    brandName: string | null;
    captionName: string | null;
    startTime: string | null;
    endTime: string | null;
    durationSeconds: number | null;
  };

  const restoredType = normalizeEntryType(orig.entryType) ?? 'PROGRAM';
  const startParsed = parseTimeToSeconds(orig.startTime ?? undefined);
  const endParsed = parseTimeToSeconds(orig.endTime ?? undefined);
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE entries SET
         entry_type = ?, category_name = ?, subcategory_name = ?,
         brand_name = ?, caption_name = ?,
         start_time = ?, end_time = ?, start_seconds = ?, end_seconds = ?,
         duration_seconds = ?, is_manually_edited = 0, updated_at = ?
       WHERE id = ?`
    ).run(
      restoredType,
      orig.categoryName,
      orig.subcategoryName,
      orig.brandName,
      orig.captionName,
      orig.startTime,
      orig.endTime,
      startParsed.seconds,
      endParsed.seconds,
      orig.durationSeconds,
      now,
      existing.id
    );

    db.prepare(`UPDATE qa_issues SET entry_type = ? WHERE entry_id = ?`).run(restoredType, existing.id);
  });
  tx();

  logAudit({
    entityType: 'ENTRY',
    entityId: existing.id,
    action: 'ENTRY_RESTORED_ORIGINAL',
    notes: 'Reverted manual edits back to immutable original XML snapshot.',
  });

  const restored = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(existing.id);
  const issues = db.prepare(`SELECT * FROM qa_issues WHERE entry_id = ?`).all(existing.id);
  res.json({ entry: restored, issues });
});

// ---------------------------------------------------------------------------
// 5 & 6. AUTOMATIC QA ENGINE & QA RESULTS
// ---------------------------------------------------------------------------
app.post('/api/qa/run', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req, res) => {
  try {
    const { channelKey, transDate, thresholdsOverride } = (req.body ?? {}) as {
      channelKey?: string;
      transDate?: string;
      thresholdsOverride?: Partial<QaThresholds>;
    };
    const result = runAutomaticQa({
      channelKey: channelKey && channelKey !== 'ALL' ? channelKey : undefined,
      transDate: transDate || undefined,
      thresholdsOverride,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'QA execution failed' });
  }
});

app.get('/api/qa/runs', requireAuth, (_req, res) => {
  const runs = getDb().prepare(`SELECT * FROM qa_runs ORDER BY completed_at DESC LIMIT 20`).all();
  res.json(runs);
});

app.get('/api/qa/issues', requireAuth, (req, res) => {
  const db = getDb();
  const {
    severity = 'ALL',
    channelKey,
    date,
    entryType,
    resolutionStatus,
    search,
  } = req.query;

  // If user specifically asks for GREEN (clean entries with no issues detected)
  if (severity === 'GREEN') {
    const where = ['is_deleted_record = 0', `qa_status = 'GREEN'`];
    const params: unknown[] = [];
    if (typeof channelKey === 'string' && channelKey && channelKey !== 'ALL') {
      where.push('channel_key = ?');
      params.push(channelKey);
    }
    if (typeof date === 'string' && date) {
      where.push('trans_date = ?');
      params.push(date);
    }
    if (typeof entryType === 'string' && entryType && entryType !== 'ALL') {
      const normalizedType = normalizeEntryType(entryType) ?? entryType.trim();
      where.push('entry_type = ?');
      params.push(normalizedType);
    }
    if (typeof search === 'string' && search.trim()) {
      const q = `%${search.trim()}%`;
      where.push(
        `(COALESCE(caption_name,'') LIKE ? OR COALESCE(brand_name,'') LIKE ? OR COALESCE(channel_name,'') LIKE ?)`
      );
      params.push(q, q, q);
    }
    const cleanEntries = db
      .prepare(
        `SELECT id AS entry_id, channel_key, channel_name, trans_date, entry_type,
                master_entry_id, segment_detail_id, category_name, subcategory_name,
                brand_name, caption_name, start_time, end_time, duration_seconds, raw_xml
         FROM entries
         WHERE ${where.join(' AND ')}
         ORDER BY channel_name ASC, COALESCE(trans_date, '') DESC, COALESCE(start_seconds, 0) ASC
         LIMIT 300`
      )
      .all(...params) as Array<Record<string, unknown>>;

    const mapped = cleanEntries.map((e) => ({
      id: `green_${e.entry_id}`,
      qa_run_id: 'clean',
      entry_id: e.entry_id,
      related_entry_id: null,
      channel_key: e.channel_key,
      channel_name: e.channel_name,
      trans_date: e.trans_date,
      entry_type: e.entry_type,
      severity: 'GREEN',
      error_type: 'No Issue Detected',
      rule_code: 'PASS_ALL_CHECKS',
      reason: 'Entry passed all configured structural, category, duration, and timeline checks.',
      confidence_level: 'VERIFIED (Available Checks)',
      evidence_json: null,
      resolution_status: 'RESOLVED',
      created_at: '',
      master_entry_id: e.master_entry_id,
      segment_detail_id: e.segment_detail_id,
      category_name: e.category_name,
      subcategory_name: e.subcategory_name,
      brand_name: e.brand_name,
      caption_name: e.caption_name,
      start_time: e.start_time,
      end_time: e.end_time,
      duration_seconds: e.duration_seconds,
      raw_xml: e.raw_xml,
    }));

    res.json({ issues: mapped });
    return;
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof severity === 'string' && (severity === 'RED' || severity === 'YELLOW')) {
    where.push('q.severity = ?');
    params.push(severity);
  }
  if (typeof channelKey === 'string' && channelKey && channelKey !== 'ALL') {
    where.push('q.channel_key = ?');
    params.push(channelKey);
  }
  if (typeof date === 'string' && date) {
    where.push('q.trans_date = ?');
    params.push(date);
  }
  if (typeof entryType === 'string' && entryType && entryType !== 'ALL') {
    const normalizedType = normalizeEntryType(entryType) ?? entryType.trim();
    where.push('COALESCE(e.entry_type, q.entry_type) = ?');
    params.push(normalizedType);
  }
  if (typeof resolutionStatus === 'string' && resolutionStatus && resolutionStatus !== 'ALL') {
    where.push('q.resolution_status = ?');
    params.push(resolutionStatus);
  }
  if (typeof search === 'string' && search.trim()) {
    const q = `%${search.trim()}%`;
    where.push(
      `(q.channel_name LIKE ? OR q.error_type LIKE ? OR q.reason LIKE ? OR COALESCE(e.brand_name,'') LIKE ? OR COALESCE(e.caption_name,'') LIKE ? OR COALESCE(e.master_entry_id,'') LIKE ?)`
    );
    params.push(q, q, q, q, q, q);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const issues = db
    .prepare(
      `SELECT q.*, COALESCE(e.entry_type, q.entry_type) AS entry_type,
              e.master_entry_id, e.segment_detail_id, e.category_name, e.subcategory_name,
              e.brand_name, e.caption_name, e.start_time, e.end_time, e.duration_seconds, e.raw_xml
       FROM qa_issues q
       LEFT JOIN entries e ON e.id = q.entry_id
       ${whereSql}
       ORDER BY CASE q.severity WHEN 'RED' THEN 1 WHEN 'YELLOW' THEN 2 ELSE 3 END,
                q.channel_name ASC, COALESCE(q.trans_date, '') DESC, COALESCE(e.start_seconds, 999999) ASC
       LIMIT 500`
    )
    .all(...params);

  res.json({ issues });
});

app.patch('/api/qa/issues/:id', requireRole(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']), (req, res) => {
  const db = getDb();
  const { resolution_status, notes } = req.body as { resolution_status?: string; notes?: string };
  const valid = new Set(['OPEN', 'REVIEWED', 'RESOLVED', 'IGNORED']);
  if (!resolution_status || !valid.has(resolution_status)) {
    res.status(400).json({ error: 'Invalid resolution_status.' });
    return;
  }

  const existing = db.prepare(`SELECT id, resolution_status FROM qa_issues WHERE id = ?`).get(req.params.id) as
    | { id: string; resolution_status: string }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'QA Issue not found.' });
    return;
  }

  db.prepare(`UPDATE qa_issues SET resolution_status = ? WHERE id = ?`).run(
    resolution_status,
    req.params.id
  );

  logAudit({
    entityType: 'QA_ISSUE',
    entityId: req.params.id,
    action: 'QA_RESOLUTION_CHANGED',
    fieldName: 'resolution_status',
    oldValue: existing.resolution_status,
    newValue: resolution_status,
    notes: notes ?? null,
  });

  res.json({ id: req.params.id, resolution_status });
});

// ---------------------------------------------------------------------------
// 7. REPORTS & EXCEL EXPORT
// ---------------------------------------------------------------------------
app.get('/api/reports/preview', requireAuth, (req, res) => {
  const db = getDb();
  const { channelKey, dateFrom, dateTo } = req.query;

  const entryWhere = ['is_deleted_record = 0'];
  const entryArgs: unknown[] = [];
  const issueWhere: string[] = [];
  const issueArgs: unknown[] = [];

  if (typeof channelKey === 'string' && channelKey && channelKey !== 'ALL') {
    entryWhere.push('channel_key = ?');
    entryArgs.push(channelKey);
    issueWhere.push('channel_key = ?');
    issueArgs.push(channelKey);
  }
  if (typeof dateFrom === 'string' && dateFrom) {
    entryWhere.push('trans_date >= ?');
    entryArgs.push(dateFrom);
    issueWhere.push('trans_date >= ?');
    issueArgs.push(dateFrom);
  }
  if (typeof dateTo === 'string' && dateTo) {
    entryWhere.push('trans_date <= ?');
    entryArgs.push(dateTo);
    issueWhere.push('trans_date <= ?');
    issueArgs.push(dateTo);
  }

  const entrySql = entryWhere.join(' AND ');
  const issueSql = issueWhere.length > 0 ? `AND ${issueWhere.join(' AND ')}` : '';

  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS complete,
         SUM(CASE WHEN entry_type = 'SPOT/TVC' THEN 1 ELSE 0 END) AS spot_tvc,
         SUM(CASE WHEN entry_type = 'PROGRAM' THEN 1 ELSE 0 END) AS programs,
         SUM(CASE WHEN entry_type = 'MEDIA' THEN 1 ELSE 0 END) AS media,
         SUM(CASE WHEN entry_type = 'SPONSORSHIP' THEN 1 ELSE 0 END) AS sponsorship,
         ROUND(COALESCE(SUM(CASE WHEN entry_type = 'SPOT/TVC' THEN duration_seconds ELSE 0 END), 0), 2) AS spot_tvc_duration_sec,
         ROUND(COALESCE(SUM(CASE WHEN entry_type = 'PROGRAM' THEN duration_seconds ELSE 0 END), 0), 2) AS programs_duration_sec,
         ROUND(COALESCE(SUM(CASE WHEN entry_type = 'MEDIA' THEN duration_seconds ELSE 0 END), 0), 2) AS media_duration_sec,
         ROUND(COALESCE(SUM(CASE WHEN entry_type = 'SPONSORSHIP' THEN duration_seconds ELSE 0 END), 0), 2) AS sponsorship_duration_sec
       FROM entries WHERE ${entrySql}`
    )
    .get(...entryArgs) as Record<string, number | null>;

  const dailyGroups = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT channel_name, COALESCE(trans_date, 'Unspecified') FROM entries WHERE ${entrySql} GROUP BY 1, 2
         )`
      )
      .get(...entryArgs) as { c: number }
  ).c;

  const qaErrors = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM qa_issues WHERE severity = 'RED' ${issueSql}`)
      .get(...issueArgs) as { c: number }
  ).c;

  const suspicious = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM qa_issues WHERE severity = 'YELLOW' ${issueSql}`)
      .get(...issueArgs) as { c: number }
  ).c;

  res.json({
    complete: counts.complete ?? 0,
    spot_tvc: counts.spot_tvc ?? 0,
    advertisements: counts.spot_tvc ?? 0,
    programs: counts.programs ?? 0,
    media: counts.media ?? 0,
    promos: counts.media ?? 0,
    sponsorship: counts.sponsorship ?? 0,
    spns: counts.sponsorship ?? 0,
    spot_tvc_duration_sec: counts.spot_tvc_duration_sec ?? 0,
    programs_duration_sec: counts.programs_duration_sec ?? 0,
    media_duration_sec: counts.media_duration_sec ?? 0,
    sponsorship_duration_sec: counts.sponsorship_duration_sec ?? 0,
    qa_errors: qaErrors,
    suspicious,
    daily_summary: dailyGroups,
  });
});

app.get('/api/reports/export', requireAuth, async (req, res) => {
  try {
    const reportType = (req.query.reportType as ReportType) || 'complete';
    const channelKey =
      typeof req.query.channelKey === 'string' && req.query.channelKey !== 'ALL'
        ? req.query.channelKey
        : undefined;
    const dateFrom = typeof req.query.dateFrom === 'string' && req.query.dateFrom ? req.query.dateFrom : undefined;
    const dateTo = typeof req.query.dateTo === 'string' && req.query.dateTo ? req.query.dateTo : undefined;

    const { buffer, fileName } = await generateExcelReport({
      reportType,
      channelKey,
      dateFrom,
      dateTo,
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Excel export failed' });
  }
});

app.get('/api/reports/export/csv', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const reportType = (req.query.reportType as string) || 'complete';
    const channelKey = typeof req.query.channelKey === 'string' && req.query.channelKey !== 'ALL' ? req.query.channelKey : undefined;
    const dateFrom = typeof req.query.dateFrom === 'string' && req.query.dateFrom ? req.query.dateFrom : undefined;
    const dateTo = typeof req.query.dateTo === 'string' && req.query.dateTo ? req.query.dateTo : undefined;

    const where: string[] = ['is_deleted_record = 0'];
    const args: unknown[] = [];
    if (channelKey) { where.push('channel_key = ?'); args.push(channelKey); }
    if (dateFrom) { where.push('trans_date >= ?'); args.push(dateFrom); }
    if (dateTo) { where.push('trans_date <= ?'); args.push(dateTo); }

    if (reportType === 'daily_summary') {
      const rows = db.prepare(`
        SELECT channel_name, COALESCE(trans_date, '') AS trans_date,
               COUNT(*) AS total_entries,
               SUM(CASE WHEN entry_type = 'PROGRAM' THEN 1 ELSE 0 END) AS program_count,
               ROUND(COALESCE(SUM(CASE WHEN entry_type = 'PROGRAM' THEN duration_seconds ELSE 0 END), 0), 2) AS program_duration_sec,
               SUM(CASE WHEN entry_type = 'SPOT/TVC' THEN 1 ELSE 0 END) AS spot_tvc_count,
               ROUND(COALESCE(SUM(CASE WHEN entry_type = 'SPOT/TVC' THEN duration_seconds ELSE 0 END), 0), 2) AS spot_tvc_duration_sec,
               SUM(CASE WHEN entry_type = 'MEDIA' THEN 1 ELSE 0 END) AS media_count,
               ROUND(COALESCE(SUM(CASE WHEN entry_type = 'MEDIA' THEN duration_seconds ELSE 0 END), 0), 2) AS media_duration_sec,
               SUM(CASE WHEN entry_type = 'SPONSORSHIP' THEN 1 ELSE 0 END) AS sponsorship_count,
               ROUND(COALESCE(SUM(CASE WHEN entry_type = 'SPONSORSHIP' THEN duration_seconds ELSE 0 END), 0), 2) AS sponsorship_duration_sec,
               ROUND(COALESCE(SUM(duration_seconds), 0), 2) AS total_duration,
               SUM(CASE WHEN qa_status = 'RED' THEN 1 ELSE 0 END) AS red_count,
               SUM(CASE WHEN qa_status = 'YELLOW' THEN 1 ELSE 0 END) AS yellow_count
        FROM entries WHERE ${where.join(' AND ')}
        GROUP BY channel_name, trans_date
        ORDER BY channel_name, trans_date
      `).all(...args) as any[];

      const headers = [
        'Channel Name',
        'Broadcast Date',
        'Total Entries',
        'PROGRAM Count',
        'PROGRAM Duration (sec)',
        'SPOT/TVC Count',
        'SPOT/TVC Duration (sec)',
        'MEDIA Count',
        'MEDIA Duration (sec)',
        'SPONSORSHIP Count',
        'SPONSORSHIP Duration (sec)',
        'Total Airtime (sec)',
        'RED Errors',
        'YELLOW Warnings',
      ];
      const csvLines = [headers.join(',')];
      for (const r of rows) {
        csvLines.push([
          `"${r.channel_name.replace(/"/g, '""')}"`,
          `"${r.trans_date}"`,
          r.total_entries,
          r.program_count,
          r.program_duration_sec,
          r.spot_tvc_count,
          r.spot_tvc_duration_sec,
          r.media_count,
          r.media_duration_sec,
          r.sponsorship_count,
          r.sponsorship_duration_sec,
          r.total_duration || 0,
          r.red_count,
          r.yellow_count,
        ].join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="Daily_Summary_${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csvLines.join('\r\n'));
      return;
    }

    if (reportType === 'qa_errors' || reportType === 'suspicious') {
      const sev = reportType === 'qa_errors' ? 'RED' : 'YELLOW';
      const issWhere = ['q.severity = ?'];
      const issArgs: unknown[] = [sev];
      if (channelKey) { issWhere.push('q.channel_key = ?'); issArgs.push(channelKey); }
      if (dateFrom) { issWhere.push('q.trans_date >= ?'); issArgs.push(dateFrom); }
      if (dateTo) { issWhere.push('q.trans_date <= ?'); issArgs.push(dateTo); }

      const issues = db.prepare(`
        SELECT q.*, COALESCE(e.entry_type, q.entry_type) AS entry_type
        FROM qa_issues q
        LEFT JOIN entries e ON e.id = q.entry_id
        WHERE ${issWhere.join(' AND ')}
        ORDER BY q.created_at DESC
      `).all(...issArgs) as any[];
      const headers = ['Issue ID', 'Severity', 'Content Category', 'Rule Code', 'Error Type', 'Channel', 'Date', 'Reason', 'Status', 'Timestamp'];
      const csvLines = [headers.join(',')];
      for (const i of issues) {
        csvLines.push([
          `"${i.id}"`,
          `"${i.severity}"`,
          `"${(i.entry_type || '').replace(/"/g, '""')}"`,
          `"${i.rule_code}"`,
          `"${(i.error_type || '').replace(/"/g, '""')}"`,
          `"${(i.channel_name || '').replace(/"/g, '""')}"`,
          `"${i.trans_date || ''}"`,
          `"${(i.reason || '').replace(/"/g, '""')}"`,
          `"${i.resolution_status}"`,
          `"${i.created_at}"`,
        ].join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="QA_${sev}_Report_${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csvLines.join('\r\n'));
      return;
    }

    if (reportType === 'spot_tvc' || reportType === 'advertisements') where.push("entry_type = 'SPOT/TVC'");
    else if (reportType === 'programs') where.push("entry_type = 'PROGRAM'");
    else if (reportType === 'media' || reportType === 'promos') where.push("entry_type = 'MEDIA'");
    else if (reportType === 'sponsorship' || reportType === 'spns') where.push("entry_type = 'SPONSORSHIP'");

    const entries = db.prepare(`
      SELECT channel_name, trans_date, start_time, end_time, duration_seconds, entry_type,
             caption_name, brand_name, category_name, subcategory_name, commercial_id, master_entry_id, qa_status
      FROM entries WHERE ${where.join(' AND ')}
      ORDER BY channel_name, trans_date, start_seconds
    `).all(...args) as any[];

    const headers = ['Channel', 'Date', 'Start Time', 'End Time', 'Duration (sec)', 'Content Category', 'Caption', 'Brand', 'XML Category', 'Subcategory', 'Commercial ID', 'Master Entry ID', 'QA Status'];
    const csvLines = [headers.join(',')];
    for (const e of entries) {
      csvLines.push([
        `"${(e.channel_name || '').replace(/"/g, '""')}"`,
        `"${e.trans_date || ''}"`,
        `"${e.start_time || ''}"`,
        `"${e.end_time || ''}"`,
        e.duration_seconds || 0,
        `"${e.entry_type || ''}"`,
        `"${(e.caption_name || '').replace(/"/g, '""')}"`,
        `"${(e.brand_name || '').replace(/"/g, '""')}"`,
        `"${(e.category_name || '').replace(/"/g, '""')}"`,
        `"${(e.subcategory_name || '').replace(/"/g, '""')}"`,
        `"${e.commercial_id || ''}"`,
        `"${e.master_entry_id || ''}"`,
        `"${e.qa_status || ''}"`,
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Broadcast_Report_${reportType}_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csvLines.join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'CSV export failed' });
  }
});

// ---------------------------------------------------------------------------
// 8 & 9. BACKUP, RESTORE & AUDIT LOGS
// ---------------------------------------------------------------------------
app.get('/api/backups', requireRole(['SUPER_ADMIN', 'ADMIN']), (_req, res) => {
  const db = getDb();
  const backups = db.prepare(`SELECT * FROM backups ORDER BY created_at DESC`).all();
  const dbSizeBytes = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  const xmlArchiveBytes = getDirectorySize(XML_ARCHIVE_DIR);
  const archiveFileCount = (db.prepare(`SELECT COUNT(*) AS c FROM xml_archive_files`).get() as { c: number }).c;
  const totalEntries = (db.prepare(`SELECT COUNT(*) AS c FROM entries`).get() as { c: number }).c;

  res.json({
    backups,
    storage: {
      dbPath: DB_PATH,
      dbSizeBytes,
      xmlArchiveBytes,
      archiveFileCount,
      totalEntries,
    },
  });
});

app.post('/api/backups', requireRole(['SUPER_ADMIN', 'ADMIN']), async (_req, res) => {
  try {
    const backup = await createDatabaseBackup('MANUAL');
    res.json(backup);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Backup creation failed' });
  }
});

app.get('/api/backups/:id/download', requireRole(['SUPER_ADMIN', 'ADMIN']), (req, res) => {
  const backup = getDb()
    .prepare(`SELECT file_name, file_path FROM backups WHERE id = ?`)
    .get(req.params.id) as { file_name: string; file_path: string } | undefined;
  if (!backup || !fs.existsSync(backup.file_path)) {
    res.status(404).json({ error: 'Backup file not found.' });
    return;
  }
  res.download(backup.file_path, backup.file_name);
});

app.post('/api/backups/:id/restore', requireRole(['SUPER_ADMIN', 'ADMIN']), async (req, res) => {
  try {
    const db = getDb();
    const backup = db
      .prepare(`SELECT id, file_name, file_path FROM backups WHERE id = ?`)
      .get(req.params.id) as { id: string; file_name: string; file_path: string } | undefined;

    if (!backup || !fs.existsSync(backup.file_path)) {
      res.status(404).json({ error: 'Backup file not found.' });
      return;
    }

    await createDatabaseBackup('PRE_RESTORE');
    db.close();
    fs.copyFileSync(backup.file_path, DB_PATH);
    reopenDatabase();

    logAudit({
      entityType: 'BACKUP',
      entityId: backup.id,
      action: 'DATABASE_RESTORED',
      newValue: backup.file_name,
    });

    res.json({ ok: true, restoredFrom: backup.file_name });
  } catch (err) {
    reopenDatabase();
    res.status(500).json({ error: err instanceof Error ? err.message : 'Restore failed' });
  }
});

app.post('/api/backups/upload-restore', requireRole(['SUPER_ADMIN', 'ADMIN']), upload.single('backupFile'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No .db backup file uploaded.' });
      return;
    }
    const header = file.buffer.subarray(0, 16).toString('utf8');
    if (!header.startsWith('SQLite format 3')) {
      res.status(400).json({ error: 'Uploaded file is not a valid SQLite 3 database.' });
      return;
    }

    await createDatabaseBackup('PRE_RESTORE');
    getDb().close();
    fs.writeFileSync(DB_PATH, file.buffer);
    reopenDatabase();

    logAudit({
      entityType: 'BACKUP',
      entityId: 'uploaded_file',
      action: 'DATABASE_RESTORED_FROM_FILE',
      newValue: file.originalname,
    });

    res.json({ ok: true, restoredFrom: file.originalname });
  } catch (err) {
    reopenDatabase();
    res.status(500).json({ error: err instanceof Error ? err.message : 'Restore failed' });
  }
});

app.get('/api/audit-logs', requireRole(['SUPER_ADMIN', 'ADMIN']), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 150, 500);
  const logs = getDb()
    .prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?`)
    .all(limit);
  res.json(logs);
});

// ---------------------------------------------------------------------------
// 10. SETTINGS
// ---------------------------------------------------------------------------
app.get('/api/settings', requireAuth, (_req, res) => {
  res.json({
    qaThresholds: getQaThresholds(),
    customFieldMappings: getCustomFieldMappings(),
    customEntryTypeMappings: getCustomEntryTypeMappings(),
  });
});

app.put('/api/settings', requireRole(['SUPER_ADMIN', 'ADMIN']), (req, res) => {
  const db = getDb();
  const { qaThresholds, customFieldMappings, customEntryTypeMappings } = req.body as {
    qaThresholds?: Partial<QaThresholds>;
    customFieldMappings?: CustomFieldMapping[];
    customEntryTypeMappings?: Array<{ rawValue: string; targetType: string }>;
  };

  const now = new Date().toISOString();
  if (qaThresholds) {
    const merged = { ...getQaThresholds(), ...qaThresholds };
    db.prepare(
      `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('qa_thresholds', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(JSON.stringify(merged), now);
    logAudit({
      entityType: 'SETTINGS',
      entityId: 'qa_thresholds',
      action: 'SETTINGS_UPDATED',
      newValue: JSON.stringify(merged),
    });
  }

  if (Array.isArray(customFieldMappings)) {
    db.prepare(
      `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('custom_field_mappings', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(JSON.stringify(customFieldMappings), now);
    logAudit({
      entityType: 'SETTINGS',
      entityId: 'custom_field_mappings',
      action: 'FIELD_MAPPINGS_UPDATED',
      newValue: `${customFieldMappings.length} mappings`,
    });
  }

  if (Array.isArray(customEntryTypeMappings)) {
    const cleaned = customEntryTypeMappings
      .map((m) => ({
        rawValue: m.rawValue?.trim() ?? '',
        targetType: normalizeEntryType(m.targetType) ?? '',
      }))
      .filter((m) => m.rawValue && m.targetType);
    db.prepare(
      `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('custom_entry_type_mappings', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(JSON.stringify(cleaned), now);
    reclassifyStoredEntries({ log: true });
  }

  res.json({
    qaThresholds: getQaThresholds(),
    customFieldMappings: getCustomFieldMappings(),
    customEntryTypeMappings: getCustomEntryTypeMappings(),
  });
});

// ---------------------------------------------------------------------------
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

return app;
}
