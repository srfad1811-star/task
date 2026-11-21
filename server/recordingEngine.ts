import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { getDb, logAudit, RECORDINGS_DIR } from './db.ts';
import { decryptSecret } from './cryptoUtils.ts';
import { getRawCloudStorageConfig, uploadSegmentToCloud } from './cloudStorage.ts';

const execFileAsync = promisify(execFile);

const WORKER_ID = process.env.RECORDING_WORKER_ID || `worker-${os.hostname()}-${process.pid}`;
const RUNTIME_BIN_DIR = path.join(os.tmpdir(), 'broadcastqa-bin');
const RUNTIME_FFMPEG_PATH = path.join(RUNTIME_BIN_DIR, 'ffmpeg');
const RUNTIME_FFMPEG_URLS: Record<string, string> = {
  'linux-x64':
    'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64.gz',
  'linux-arm64':
    'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-arm64.gz',
};

let runtimeInstallPromise: Promise<{
  ok: boolean;
  version: string | null;
  source: string | null;
  error?: string;
}> | null = null;

function ensureExecutable(binPath: string): string {
  try {
    fs.chmodSync(binPath, 0o755);
  } catch {
    // ignore permission errors on read-only mounts
  }
  return binPath;
}

export function resolveFfmpegBin(): { bin: string; source: 'env' | 'runtime' | 'system' } {
  const envBin = process.env.FFMPEG_PATH?.trim();
  if (envBin && fs.existsSync(envBin)) {
    return { bin: ensureExecutable(envBin), source: 'env' };
  }
  if (fs.existsSync(RUNTIME_FFMPEG_PATH) && fs.statSync(RUNTIME_FFMPEG_PATH).size > 1_000_000) {
    return { bin: ensureExecutable(RUNTIME_FFMPEG_PATH), source: 'runtime' };
  }
  return { bin: 'ffmpeg', source: 'system' };
}

export function resolveFfprobeBin(): { bin: string; source: 'env' | 'system' } {
  const envBin = process.env.FFPROBE_PATH?.trim();
  if (envBin && fs.existsSync(envBin)) {
    return { bin: ensureExecutable(envBin), source: 'env' };
  }
  return { bin: 'ffprobe', source: 'system' };
}

interface ActiveWorkerHandle {
  sessionId: string;
  channelKey: string;
  channelName: string;
  sourceId: string;
  process: ChildProcess | null;
  stagingDir: string;
  segmentDurationSec: number;
  reconnectTimer: NodeJS.Timeout | null;
  watcherTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  stoppedByUser: boolean;
  processedFiles: Set<string>;
  lastStderr: string;
  startedAtMs: number;
  segmentCounter: number;
}

const activeWorkers = new Map<string, ActiveWorkerHandle>(); // keyed by channelKey (prevents duplicates!)
let uploadQueueTimer: NodeJS.Timeout | null = null;
let scheduleCheckTimer: NodeJS.Timeout | null = null;
let uploadLoopRunning = false;

export function getWorkerIdentity() {
  return {
    workerId: WORKER_ID,
    hostname: os.hostname(),
    pid: process.pid,
    activeRecordingCount: activeWorkers.size,
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export async function checkFfmpegAvailable(): Promise<{
  available: boolean;
  version: string | null;
  source: 'env' | 'runtime' | 'system' | null;
}> {
  const candidates: Array<{ bin: string; source: 'env' | 'runtime' | 'system' }> = [];
  const envBin = process.env.FFMPEG_PATH?.trim();
  if (envBin && fs.existsSync(envBin)) {
    candidates.push({ bin: ensureExecutable(envBin), source: 'env' });
  }
  candidates.push({ bin: 'ffmpeg', source: 'system' });
  if (fs.existsSync(RUNTIME_FFMPEG_PATH) && fs.statSync(RUNTIME_FFMPEG_PATH).size > 1_000_000) {
    candidates.push({ bin: ensureExecutable(RUNTIME_FFMPEG_PATH), source: 'runtime' });
  }

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.bin, ['-version'], { timeout: 5000 });
      const firstLine = stdout.split('\n')[0]?.trim() || 'ffmpeg';
      return { available: true, version: firstLine, source: candidate.source };
    } catch {
      // try next candidate
    }
  }
  return { available: false, version: null, source: null };
}

/**
 * Downloads the official static FFmpeg binary at runtime into /tmp/broadcastqa-bin/ffmpeg
 * on slim cloud containers (e.g. Cloud Run) without bloating the production bundle.
 */
export async function installRuntimeFfmpeg(): Promise<{
  ok: boolean;
  version: string | null;
  source: string | null;
  error?: string;
}> {
  const existing = await checkFfmpegAvailable();
  if (existing.available) {
    return { ok: true, version: existing.version, source: existing.source };
  }

  if (runtimeInstallPromise) return runtimeInstallPromise;

  runtimeInstallPromise = (async () => {
    const platformKey = `${process.platform}-${process.arch}`;
    const downloadUrl = RUNTIME_FFMPEG_URLS[platformKey];
    if (!downloadUrl) {
      return {
        ok: false,
        version: null,
        source: null,
        error: `Automatic runtime download is only available on Linux x64/arm64 (detected ${platformKey}). Install FFmpeg via your OS package manager.`,
      };
    }

    const tmpPath = `${RUNTIME_FFMPEG_PATH}.download.${Date.now()}`;
    try {
      fs.mkdirSync(RUNTIME_BIN_DIR, { recursive: true });
      const res = await fetch(downloadUrl, { redirect: 'follow' });
      if (!res.ok || !res.body) {
        throw new Error(`Download failed with HTTP ${res.status}`);
      }

      const gunzip = createGunzip();
      const out = fs.createWriteStream(tmpPath, { mode: 0o755 });
      await pipeline(Readable.fromWeb(res.body as any), gunzip, out);

      fs.chmodSync(tmpPath, 0o755);
      fs.renameSync(tmpPath, RUNTIME_FFMPEG_PATH);

      const check = await checkFfmpegAvailable();
      if (!check.available) {
        throw new Error('Downloaded FFmpeg binary failed version verification.');
      }

      logAudit({
        entityType: 'SYSTEM',
        entityId: 'ffmpeg-runtime',
        action: 'FFMPEG_RUNTIME_INSTALLED',
        notes: `Installed runtime FFmpeg binary (${check.version}) into ${RUNTIME_FFMPEG_PATH}`,
      });

      return { ok: true, version: check.version, source: check.source };
    } catch (err) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
      return {
        ok: false,
        version: null,
        source: null,
        error: err instanceof Error ? err.message : 'Failed to install runtime FFmpeg.',
      };
    } finally {
      runtimeInstallPromise = null;
    }
  })();

  return runtimeInstallPromise;
}

function parseFfmpegStreamStderr(stderr: string): {
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  durationSeconds: number | null;
} {
  const videoMatch = stderr.match(/Stream\s+#\d+:\d+[^:]*:\s+Video:\s+([a-zA-Z0-9_]+)[^,\n]*(?:,\s*[^,\n]+)*?,\s*(\d{2,5}x\d{2,5})/i);
  const videoCodecOnly = stderr.match(/Stream\s+#\d+:\d+[^:]*:\s+Video:\s+([a-zA-Z0-9_]+)/i);
  const audioMatch = stderr.match(/Stream\s+#\d+:\d+[^:]*:\s+Audio:\s+([a-zA-Z0-9_]+)/i);
  const durMatch = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);

  let durationSeconds: number | null = null;
  if (durMatch) {
    const h = Number(durMatch[1]);
    const m = Number(durMatch[2]);
    const s = Number(durMatch[3]);
    const total = h * 3600 + m * 60 + s;
    if (Number.isFinite(total) && total > 0) durationSeconds = total;
  }

  return {
    videoCodec: videoMatch?.[1] ?? videoCodecOnly?.[1] ?? null,
    audioCodec: audioMatch?.[1] ?? null,
    resolution: videoMatch?.[2] ?? null,
    durationSeconds,
  };
}

export async function probeStreamUrl(rawUrl: string): Promise<{
  reachable: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  error: string | null;
}> {
  if (!rawUrl || !/^https?:\/\/|^rtsp:\/\/|^rtmp:\/\//i.test(rawUrl.trim())) {
    return {
      reachable: false,
      videoCodec: null,
      audioCodec: null,
      resolution: null,
      error: 'Stream URL must begin with http://, https://, rtsp://, or rtmp://',
    };
  }

  // Try system ffprobe first if available
  try {
    const { bin: ffprobeBin } = resolveFfprobeBin();
    const { stdout } = await execFileAsync(
      ffprobeBin,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,width,height',
        '-of',
        'json',
        rawUrl.trim(),
      ],
      { timeout: 12000 }
    );
    const parsed = JSON.parse(stdout || '{}') as {
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
      }>;
    };
    const streams = parsed.streams ?? [];
    const vStream = streams.find((s) => s.codec_type === 'video');
    const aStream = streams.find((s) => s.codec_type === 'audio');
    if (vStream || aStream) {
      return {
        reachable: true,
        videoCodec: vStream?.codec_name ?? null,
        audioCodec: aStream?.codec_name ?? null,
        resolution:
          vStream?.width && vStream?.height ? `${vStream.width}x${vStream.height}` : null,
        error: null,
      };
    }
  } catch (probeErr: any) {
    // Only fall back to ffmpeg inspection when ffprobe is missing (ENOENT) or unavailable
    if (probeErr?.code !== 'ENOENT') {
      // Still allow fallback check via ffmpeg if system ffprobe isn't installed
    }
  }

  // Fallback: inspect stream metadata via ffmpeg -i (works with single runtime ffmpeg binary!)
  const { bin: ffmpegBin } = resolveFfmpegBin();
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegBin,
      [
        '-hide_banner',
        '-user_agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        '-headers',
        'Referer: https://www.google.com/\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n',
        '-i',
        rawUrl.trim(),
        '-t',
        '1',
        '-f',
        'null',
        '-',
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 12000);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        reachable: false,
        videoCodec: null,
        audioCodec: null,
        resolution: null,
        error: `FFmpeg not available: ${err.message}`,
      });
    });

    child.on('close', () => {
      clearTimeout(timer);
      const parsed = parseFfmpegStreamStderr(stderr);
      if (parsed.videoCodec || parsed.audioCodec) {
        resolve({
          reachable: true,
          videoCodec: parsed.videoCodec,
          audioCodec: parsed.audioCodec,
          resolution: parsed.resolution,
          error: null,
        });
      } else {
        const lastLine =
          stderr
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-2)
            .join(' ') || 'Stream unreachable or no playable streams detected.';
        resolve({
          reachable: false,
          videoCodec: null,
          audioCodec: null,
          resolution: null,
          error: lastLine.slice(0, 320),
        });
      }
    });
  });
}

async function probeLocalFileDuration(filePath: string): Promise<number | null> {
  try {
    const { bin: ffprobeBin } = resolveFfprobeBin();
    const { stdout } = await execFileAsync(
      ffprobeBin,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { timeout: 10000 }
    );
    const val = Number(stdout.trim());
    if (Number.isFinite(val) && val > 0) return val;
  } catch {
    // Fallback to ffmpeg duration header parsing
  }

  try {
    const { bin: ffmpegBin } = resolveFfmpegBin();
    await execFileAsync(ffmpegBin, ['-hide_banner', '-i', filePath], { timeout: 8000 });
    return null;
  } catch (err: any) {
    const stderr = String(err?.stderr || '');
    return parseFfmpegStreamStderr(stderr).durationSeconds;
  }
}

function recordErrorLog(params: {
  channelKey?: string | null;
  channelName?: string | null;
  sessionId?: string | null;
  segmentId?: string | null;
  severity?: 'WARN' | 'ERROR' | 'CRITICAL';
  errorCode: string;
  message: string;
  details?: string | null;
}) {
  getDb()
    .prepare(
      `INSERT INTO recording_errors (
         id, channel_key, channel_name, session_id, segment_id,
         severity, error_code, message, details, resolved, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(
      `err_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      params.channelKey ?? null,
      params.channelName ?? null,
      params.sessionId ?? null,
      params.segmentId ?? null,
      params.severity ?? 'ERROR',
      params.errorCode,
      params.message,
      params.details ?? null,
      new Date().toISOString()
    );
}

function parseSegmentFilenameDate(fileName: string): Date | null {
  // Format: seg_YYYYMMDD_HHMMSS.mp4
  const m = fileName.match(/seg_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.mp4$/);
  if (!m) return null;
  const [, yyyy, mm, dd, hh, mi, ss] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function finalizeCompletedSegments(handle: ActiveWorkerHandle, flushAll: boolean) {
  if (!fs.existsSync(handle.stagingDir)) return;

  const files = fs
    .readdirSync(handle.stagingDir)
    .filter((f) => f.endsWith('.mp4'))
    .sort();

  // Never finalize the newest file while ffmpeg is actively writing to it unless flushAll === true
  const candidates = flushAll ? files : files.slice(0, Math.max(0, files.length - 1));
  const db = getDb();

  for (const fileName of candidates) {
    if (handle.processedFiles.has(fileName)) continue;
    const fullPath = path.join(handle.stagingDir, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.size < 1024) {
      // Skip corrupt/empty 0-byte stub segments
      handle.processedFiles.add(fileName);
      continue;
    }

    // Ensure mtime is at least 1.5s old before touching unless flushing on stop
    if (!flushAll && Date.now() - stat.mtimeMs < 1500) {
      continue;
    }

    handle.processedFiles.add(fileName);
    const durationSec = (await probeLocalFileDuration(fullPath)) ?? handle.segmentDurationSec;
    const startDate = parseSegmentFilenameDate(fileName) ?? new Date(stat.mtimeMs - durationSec * 1000);
    const endDate = new Date(startDate.getTime() + durationSec * 1000);

    const year = startDate.getUTCFullYear();
    const month = startDate.getUTCMonth() + 1;
    const day = startDate.getUTCDate();
    const recordDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const startSeconds =
      startDate.getUTCHours() * 3600 +
      startDate.getUTCMinutes() * 60 +
      startDate.getUTCSeconds();
    const endSeconds = Math.min(86400, startSeconds + durationSec);

    const fileHash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
    const segId = `seg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    handle.segmentCounter += 1;

    db.prepare(
      `INSERT INTO recording_segments (
         id, session_id, channel_key, channel_name, record_date, year, month, day,
         segment_index, start_time_iso, end_time_iso, start_seconds, end_seconds,
         duration_seconds, file_name, local_path, file_size_bytes, sha256,
         status, is_complete, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL_READY', 1, ?, ?)`
    ).run(
      segId,
      handle.sessionId,
      handle.channelKey,
      handle.channelName,
      recordDate,
      year,
      month,
      day,
      handle.segmentCounter,
      startDate.toISOString(),
      endDate.toISOString(),
      startSeconds,
      endSeconds,
      durationSec,
      fileName,
      fullPath,
      stat.size,
      fileHash,
      now,
      now
    );

    db.prepare(
      `UPDATE recording_sessions SET
         total_segments = total_segments + 1,
         total_bytes = total_bytes + ?,
         total_duration_seconds = total_duration_seconds + ?,
         last_heartbeat_at = ?
       WHERE id = ?`
    ).run(stat.size, durationSec, now, handle.sessionId);

    // Trigger real cloud upload asynchronously (never blocks ffmpeg worker)
    uploadSegmentToCloud(segId).catch((err) => {
      recordErrorLog({
        channelKey: handle.channelKey,
        channelName: handle.channelName,
        sessionId: handle.sessionId,
        segmentId: segId,
        severity: 'ERROR',
        errorCode: 'UPLOAD_DISPATCH_ERROR',
        message: 'Unexpected upload error',
        details: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

function spawnFfmpegProcess(handle: ActiveWorkerHandle, streamUrl: string, reconnectDelaySec: number) {
  if (handle.stoppedByUser) return;

  const db = getDb();
  fs.mkdirSync(handle.stagingDir, { recursive: true });
  const outputPattern = path.join(handle.stagingDir, 'seg_%Y%m%d_%H%M%S.mp4');

  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    String(Math.max(5, Math.min(60, reconnectDelaySec))),
    '-i',
    streamUrl,
    '-c',
    'copy',
    '-f',
    'segment',
    '-segment_time',
    String(handle.segmentDurationSec),
    '-segment_format',
    'mp4',
    '-segment_format_options',
    'movflags=+faststart',
    '-reset_timestamps',
    '1',
    '-strftime',
    '1',
    outputPattern,
  ];

  const { bin: ffmpegBin } = resolveFfmpegBin();
  const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  handle.process = child;
  handle.lastStderr = '';

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE recording_sessions SET status = 'RECORDING', pid = ?, last_heartbeat_at = ?, last_error = NULL WHERE id = ?`
  ).run(child.pid ?? null, now, handle.sessionId);

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text) {
      handle.lastStderr = text.slice(-400);
    }
  });

  child.on('error', (err) => {
    const errMsg = `FFmpeg process failed to start: ${err.message}`;
    handle.lastStderr = errMsg;
    recordErrorLog({
      channelKey: handle.channelKey,
      channelName: handle.channelName,
      sessionId: handle.sessionId,
      severity: 'CRITICAL',
      errorCode: 'FFMPEG_SPAWN_ERROR',
      message: errMsg,
    });
  });

  child.on('close', (code) => {
    handle.process = null;
    finalizeCompletedSegments(handle, true).catch(() => {});

    if (handle.stoppedByUser) {
      db.prepare(
        `UPDATE recording_sessions SET status = 'STOPPED', ended_at = ?, pid = NULL, last_heartbeat_at = ? WHERE id = ?`
      ).run(new Date().toISOString(), new Date().toISOString(), handle.sessionId);
      return;
    }

    const reason =
      handle.lastStderr || `Source stream disconnected (ffmpeg exit code ${code ?? 'unknown'}).`;
    const ts = new Date().toISOString();

    db.prepare(
      `UPDATE recording_sessions SET
         status = 'RECONNECTING',
         reconnect_count = reconnect_count + 1,
         pid = NULL,
         last_error = ?,
         last_heartbeat_at = ?
       WHERE id = ?`
    ).run(reason, ts, handle.sessionId);

    recordErrorLog({
      channelKey: handle.channelKey,
      channelName: handle.channelName,
      sessionId: handle.sessionId,
      severity: 'WARN',
      errorCode: 'STREAM_DISCONNECTED_RECONNECTING',
      message: `Stream disconnected for ${handle.channelName}; retrying in ${reconnectDelaySec}s`,
      details: reason,
    });

    handle.reconnectTimer = setTimeout(() => {
      handle.reconnectTimer = null;
      if (!handle.stoppedByUser && activeWorkers.get(handle.channelKey) === handle) {
        spawnFfmpegProcess(handle, streamUrl, reconnectDelaySec);
      }
    }, Math.max(3, reconnectDelaySec) * 1000);
  });
}

export async function startChannelRecording(params: {
  channelKey: string;
  sourceId?: string;
  triggeredBy?: string;
  autoRecover?: boolean;
}): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const db = getDb();

  // Prevent duplicate active recording sessions for the same channel
  if (activeWorkers.has(params.channelKey)) {
    return {
      ok: false,
      error: 'A recording session is already active for this channel. Stop or restart it first.',
    };
  }

  const ffmpegCheck = await checkFfmpegAvailable();
  if (!ffmpegCheck.available) {
    return {
      ok: false,
      error: 'FFmpeg is not installed or unavailable on this cloud worker.',
    };
  }

  const source = (params.sourceId
    ? db.prepare(`SELECT * FROM recording_sources WHERE id = ?`).get(params.sourceId)
    : db
        .prepare(
          `SELECT * FROM recording_sources WHERE channel_key = ? AND is_enabled = 1 ORDER BY updated_at DESC LIMIT 1`
        )
        .get(params.channelKey)) as
    | {
        id: string;
        channel_key: string;
        channel_name: string;
        stream_url_encrypted: string;
        recording_permission: string;
        segment_duration_seconds: number;
        is_enabled: number;
        reconnect_delay_sec: number;
      }
    | undefined;

  if (!source) {
    return {
      ok: false,
      error: 'No enabled recording source configured for this channel. Add an authorized stream URL in Channel Management first.',
    };
  }

  if (source.recording_permission !== 'AUTHORIZED') {
    recordErrorLog({
      channelKey: source.channel_key,
      channelName: source.channel_name,
      severity: 'WARN',
      errorCode: 'RECORDING_PERMISSION_DENIED',
      message: `Recording blocked for ${source.channel_name}: source permission is ${source.recording_permission}.`,
    });
    return {
      ok: false,
      error: `Recording is blocked because this source's permission is set to "${source.recording_permission}". Only AUTHORIZED sources may be recorded.`,
    };
  }

  const streamUrl = decryptSecret(source.stream_url_encrypted);
  if (!streamUrl) {
    return { ok: false, error: 'Configured stream URL is empty or could not be decrypted.' };
  }

  // Probe stream honestly before reporting RECORDING
  const probe = await probeStreamUrl(streamUrl);
  const probeNow = new Date().toISOString();
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
    probe.reachable ? 'ONLINE' : 'UNREACHABLE',
    probeNow,
    probe.error,
    probe.videoCodec,
    probe.resolution,
    probeNow,
    source.id
  );

  if (!probe.reachable) {
    recordErrorLog({
      channelKey: source.channel_key,
      channelName: source.channel_name,
      severity: 'WARN',
      errorCode: 'SOURCE_UNREACHABLE_WARNING',
      message: `Stream probe warning for ${source.channel_name}: attempting recording spawn anyway.`,
      details: probe.error,
    });
  }

  const cfg = getRawCloudStorageConfig();
  const segmentDurationSec = Math.max(
    30,
    Math.min(7200, source.segment_duration_seconds || cfg.defaultSegmentSeconds || 3600)
  );

  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const safeKey = source.channel_key.replace(/[^a-zA-Z0-9_-]/g, '_');
  const stagingDir = path.join(RECORDINGS_DIR, safeKey, sessionId);
  fs.mkdirSync(stagingDir, { recursive: true });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO recording_sessions (
       id, worker_id, channel_key, channel_name, source_id, status,
       started_at, last_heartbeat_at, reconnect_count, total_segments,
       total_bytes, total_duration_seconds, auto_recover, created_at
     ) VALUES (?, ?, ?, ?, ?, 'STARTING', ?, ?, 0, 0, 0, 0, ?, ?)`
  ).run(
    sessionId,
    WORKER_ID,
    source.channel_key,
    source.channel_name,
    source.id,
    now,
    now,
    params.autoRecover !== false ? 1 : 0,
    now
  );

  const handle: ActiveWorkerHandle = {
    sessionId,
    channelKey: source.channel_key,
    channelName: source.channel_name,
    sourceId: source.id,
    process: null,
    stagingDir,
    segmentDurationSec,
    reconnectTimer: null,
    watcherTimer: null,
    heartbeatTimer: null,
    stoppedByUser: false,
    processedFiles: new Set<string>(),
    lastStderr: '',
    startedAtMs: Date.now(),
    segmentCounter: 0,
  };

  activeWorkers.set(source.channel_key, handle);

  // Check for completed segments every 5 seconds
  handle.watcherTimer = setInterval(() => {
    finalizeCompletedSegments(handle, false).catch(() => {});
  }, 5000);

  // Write live worker heartbeat every 15 seconds
  handle.heartbeatTimer = setInterval(() => {
    if (!handle.stoppedByUser) {
      getDb()
        .prepare(`UPDATE recording_sessions SET last_heartbeat_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), handle.sessionId);
    }
  }, 15000);

  spawnFfmpegProcess(handle, streamUrl, source.reconnect_delay_sec || 10);

  logAudit({
    entityType: 'RECORDING_SESSION',
    entityId: sessionId,
    action: 'RECORDING_STARTED',
    notes: `Started cloud recording for ${source.channel_name} by ${params.triggeredBy || 'system'} (${segmentDurationSec}s segments)`,
  });

  return { ok: true, sessionId };
}

export async function stopChannelRecording(
  channelKey: string,
  triggeredBy = 'operator'
): Promise<{ ok: boolean; message: string }> {
  const handle = activeWorkers.get(channelKey);
  const db = getDb();
  const now = new Date().toISOString();

  if (!handle) {
    // Also clean up any stale DB rows marked active
    const stale = db
      .prepare(
        `UPDATE recording_sessions SET status = 'STOPPED', ended_at = ?, auto_recover = 0, pid = NULL
         WHERE channel_key = ? AND status IN ('STARTING', 'RECORDING', 'RECONNECTING')`
      )
      .run(now, channelKey);
    if (stale.changes > 0) {
      return { ok: true, message: 'Stopped stale recording session state.' };
    }
    return { ok: false, message: 'No active recording session found for this channel.' };
  }

  handle.stoppedByUser = true;
  if (handle.reconnectTimer) clearTimeout(handle.reconnectTimer);
  if (handle.watcherTimer) clearInterval(handle.watcherTimer);
  if (handle.heartbeatTimer) clearInterval(handle.heartbeatTimer);

  if (handle.process && !handle.process.killed) {
    try {
      handle.process.kill('SIGTERM');
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  await finalizeCompletedSegments(handle, true);
  activeWorkers.delete(channelKey);

  db.prepare(
    `UPDATE recording_sessions SET status = 'STOPPED', ended_at = ?, auto_recover = 0, pid = NULL, last_heartbeat_at = ? WHERE id = ?`
  ).run(now, now, handle.sessionId);

  logAudit({
    entityType: 'RECORDING_SESSION',
    entityId: handle.sessionId,
    action: 'RECORDING_STOPPED',
    notes: `Stopped recording for ${handle.channelName} by ${triggeredBy}`,
  });

  return { ok: true, message: `Stopped recording for ${handle.channelName}.` };
}

export async function restartChannelRecording(channelKey: string, triggeredBy = 'operator') {
  await stopChannelRecording(channelKey, triggeredBy);
  return startChannelRecording({ channelKey, triggeredBy, autoRecover: true });
}

export async function retryFailedCloudUploads(): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
}> {
  if (uploadLoopRunning) return { attempted: 0, succeeded: 0, failed: 0 };
  uploadLoopRunning = true;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  try {
    const pending = getDb()
      .prepare(
        `SELECT s.id
         FROM recording_segments s
         LEFT JOIN cloud_uploads u ON u.segment_id = s.id
         WHERE s.is_complete = 1
           AND s.status IN ('LOCAL_READY', 'FAILED')
           AND (u.id IS NULL OR (u.status IN ('QUEUED', 'FAILED') AND u.attempts < u.max_attempts))
         ORDER BY s.created_at ASC
         LIMIT 20`
      )
      .all() as Array<{ id: string }>;

    for (const row of pending) {
      attempted++;
      const res = await uploadSegmentToCloud(row.id);
      if (res.ok) succeeded++;
      else failed++;
    }
  } finally {
    uploadLoopRunning = false;
  }

  return { attempted, succeeded, failed };
}

export async function recoverRecordingSessionsOnStartup() {
  const db = getDb();
  const now = new Date().toISOString();

  // Identify sessions that were running before server restart
  const interrupted = db
    .prepare(
      `SELECT id, channel_key, channel_name, source_id, auto_recover
       FROM recording_sessions
       WHERE status IN ('STARTING', 'RECORDING', 'RECONNECTING')`
    )
    .all() as Array<{
    id: string;
    channel_key: string;
    channel_name: string;
    source_id: string;
    auto_recover: number;
  }>;

  const toRecover = new Map<string, string>();
  for (const s of interrupted) {
    db.prepare(
      `UPDATE recording_sessions SET status = 'INTERRUPTED', ended_at = ?, pid = NULL, last_error = 'Worker restarted — auto-recovery triggered' WHERE id = ?`
    ).run(now, s.id);
    if (s.auto_recover === 1) {
      toRecover.set(s.channel_key, s.source_id);
    }
  }

  // Also include enabled sources configured for auto_record_24_7
  const autoSources = db
    .prepare(
      `SELECT id, channel_key FROM recording_sources
       WHERE is_enabled = 1 AND auto_record_24_7 = 1 AND recording_permission = 'AUTHORIZED'`
    )
    .all() as Array<{ id: string; channel_key: string }>;

  for (const src of autoSources) {
    if (!toRecover.has(src.channel_key)) {
      toRecover.set(src.channel_key, src.id);
    }
  }

  for (const [channelKey, sourceId] of toRecover.entries()) {
    startChannelRecording({
      channelKey,
      sourceId,
      triggeredBy: 'auto_recovery',
      autoRecover: true,
    }).catch(() => {});
  }

  // Start background upload retry worker (every 60s)
  if (!uploadQueueTimer) {
    uploadQueueTimer = setInterval(() => {
      retryFailedCloudUploads().catch(() => {});
    }, 60_000);
  }

  // Start schedule monitor (every 30s)
  if (!scheduleCheckTimer) {
    scheduleCheckTimer = setInterval(() => {
      evaluateRecordingSchedules().catch(() => {});
    }, 30_000);
  }
}

async function evaluateRecordingSchedules() {
  const db = getDb();
  const schedules = db
    .prepare(`SELECT * FROM recording_schedules WHERE is_enabled = 1`)
    .all() as Array<{
    id: string;
    channel_key: string;
    source_id: string;
    mode: string;
    start_time: string | null;
    end_time: string | null;
    days_of_week: string;
  }>;

  const now = new Date();
  const dayMap = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const todayCode = dayMap[now.getUTCDay()];
  const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

  for (const sch of schedules) {
    const days = (sch.days_of_week || '').split(',').map((d) => d.trim().toUpperCase());
    if (!days.includes(todayCode)) continue;

    if (sch.mode === 'CONTINUOUS_24_7') {
      if (!activeWorkers.has(sch.channel_key)) {
        await startChannelRecording({
          channelKey: sch.channel_key,
          sourceId: sch.source_id,
          triggeredBy: 'schedule_24_7',
          autoRecover: true,
        }).catch(() => {});
      }
    } else if (sch.mode === 'SCHEDULED' && sch.start_time && sch.end_time) {
      const inWindow = hhmm >= sch.start_time && hhmm < sch.end_time;
      if (inWindow && !activeWorkers.has(sch.channel_key)) {
        await startChannelRecording({
          channelKey: sch.channel_key,
          sourceId: sch.source_id,
          triggeredBy: 'schedule_window',
          autoRecover: false,
        }).catch(() => {});
      } else if (!inWindow && activeWorkers.has(sch.channel_key)) {
        await stopChannelRecording(sch.channel_key, 'schedule_window_end').catch(() => {});
      }
    }
  }
}

export function getLiveRecordingMonitorData() {
  const db = getDb();
  const todayDate = new Date().toISOString().slice(0, 10);

  const channels = db
    .prepare(`SELECT id, channel_id, channel_name, metadata_json FROM channels ORDER BY channel_name ASC`)
    .all() as Array<{
    id: string;
    channel_id: string | null;
    channel_name: string;
    metadata_json: string | null;
  }>;

  const sources = db.prepare(`SELECT * FROM recording_sources`).all() as Array<any>;
  const sourceByChannel = new Map<string, any>();
  for (const s of sources) sourceByChannel.set(s.channel_key, s);

  const activeSessions = db
    .prepare(
      `SELECT * FROM recording_sessions
       WHERE status IN ('STARTING', 'RECORDING', 'RECONNECTING')
       ORDER BY started_at DESC`
    )
    .all() as Array<any>;
  const sessionByChannel = new Map<string, any>();
  for (const s of activeSessions) {
    if (!sessionByChannel.has(s.channel_key)) sessionByChannel.set(s.channel_key, s);
  }

  const todayStatsStmt = db.prepare(
    `SELECT
       COALESCE(SUM(duration_seconds), 0) AS today_seconds,
       COUNT(*) AS today_segments,
       COALESCE(SUM(file_size_bytes), 0) AS today_bytes
     FROM video_archive
     WHERE channel_key = ? AND record_date = ? AND is_verified = 1`
  );

  const totalStatsStmt = db.prepare(
    `SELECT
       COALESCE(SUM(duration_seconds), 0) AS total_seconds,
       COUNT(*) AS total_segments,
       COALESCE(SUM(file_size_bytes), 0) AS total_bytes,
       MAX(created_at) AS last_archived_at
     FROM video_archive
     WHERE channel_key = ? AND is_verified = 1`
  );

  const uploadStatsStmt = db.prepare(
    `SELECT
       MAX(verified_at) AS last_verified_upload,
       SUM(CASE WHEN status = 'UPLOADING' THEN 1 ELSE 0 END) AS uploading_count,
       SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS queued_count,
       SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed_count
     FROM cloud_uploads
     WHERE channel_key = ?`
  );

  const interruptionsStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM recording_errors
     WHERE channel_key = ? AND substr(created_at, 1, 10) = ?`
  );

  const latestErrStmt = db.prepare(
    `SELECT error_code, message, created_at FROM recording_errors
     WHERE channel_key = ? AND resolved = 0
     ORDER BY created_at DESC LIMIT 1`
  );

  const rows = channels.map((ch) => {
    const src = sourceByChannel.get(ch.id) ?? null;
    const worker = activeWorkers.get(ch.id) ?? null;
    const dbSess = sessionByChannel.get(ch.id) ?? null;
    const todayAgg = todayStatsStmt.get(ch.id, todayDate) as {
      today_seconds: number;
      today_segments: number;
      today_bytes: number;
    };
    const totalAgg = totalStatsStmt.get(ch.id) as {
      total_seconds: number;
      total_segments: number;
      total_bytes: number;
      last_archived_at: string | null;
    };
    const uploadAgg = uploadStatsStmt.get(ch.id) as {
      last_verified_upload: string | null;
      uploading_count: number | null;
      queued_count: number | null;
      failed_count: number | null;
    };
    const interruptionsToday = (interruptionsStmt.get(ch.id, todayDate) as { c: number }).c;
    const latestErr = latestErrStmt.get(ch.id) as
      | { error_code: string; message: string; created_at: string }
      | undefined;

    // Live truthful status: only report RECORDING if an actual ffmpeg process is alive!
    let actualStatus: 'RECORDING' | 'RECONNECTING' | 'STOPPED' | 'NO_SOURCE' | 'RESTRICTED' | 'ERROR' =
      'STOPPED';
    if (!src) {
      actualStatus = 'NO_SOURCE';
    } else if (src.recording_permission !== 'AUTHORIZED') {
      actualStatus = 'RESTRICTED';
    } else if (worker && worker.process && !worker.process.killed) {
      actualStatus = 'RECORDING';
    } else if (worker && worker.reconnectTimer) {
      actualStatus = 'RECONNECTING';
    } else if (dbSess?.status === 'ERROR') {
      actualStatus = 'ERROR';
    }

    const currentSessionDurationSec =
      worker && actualStatus === 'RECORDING'
        ? Math.floor((Date.now() - worker.startedAtMs) / 1000)
        : 0;

    let uploadStatus: 'IDLE' | 'UPLOADING' | 'VERIFIED' | 'FAILED' = 'IDLE';
    if ((uploadAgg.uploading_count ?? 0) > 0) uploadStatus = 'UPLOADING';
    else if ((uploadAgg.failed_count ?? 0) > 0) uploadStatus = 'FAILED';
    else if (uploadAgg.last_verified_upload) uploadStatus = 'VERIFIED';

    let category = 'General';
    if (ch.metadata_json) {
      try {
        const parsed = JSON.parse(ch.metadata_json);
        if (parsed.category) category = parsed.category;
      } catch {
        // ignore
      }
    }

    return {
      channelKey: ch.id,
      channelId: ch.channel_id,
      channelName: ch.channel_name,
      category,
      source: src
        ? {
            id: src.id,
            sourceType: src.source_type,
            streamUrlRedacted: src.stream_url_redacted,
            recordingPermission: src.recording_permission,
            segmentDurationSeconds: src.segment_duration_seconds,
            isEnabled: Boolean(src.is_enabled),
            autoRecord247: Boolean(src.auto_record_24_7),
            lastProbeStatus: src.last_probe_status,
            lastProbeAt: src.last_probe_at,
            lastProbeError: src.last_probe_error,
            resolution: src.resolution,
            videoCodec: src.video_codec,
            historicalArchiveEndpoint: src.historical_archive_endpoint,
          }
        : null,
      status: actualStatus,
      sessionId: worker?.sessionId ?? dbSess?.id ?? null,
      recordingStartedAt: worker
        ? new Date(worker.startedAtMs).toISOString()
        : dbSess?.started_at ?? null,
      currentDurationSeconds: currentSessionDurationSec,
      todayRecordedSeconds: todayAgg.today_seconds + currentSessionDurationSec,
      totalRecordedHours: (totalAgg.total_seconds + currentSessionDurationSec) / 3600,
      totalVideoSegments: totalAgg.total_segments,
      todaySegments: todayAgg.today_segments,
      totalStorageBytes: totalAgg.total_bytes,
      totalStorageGb: totalAgg.total_bytes / (1024 ** 3),
      uploadStatus,
      lastSuccessfulUploadAt: uploadAgg.last_verified_upload,
      failedUploads: uploadAgg.failed_count ?? 0,
      interruptionsCount: (dbSess?.reconnect_count ?? 0) + interruptionsToday,
      currentError: worker?.lastStderr || latestErr?.message || null,
    };
  });

  return {
    worker: getWorkerIdentity(),
    generatedAt: new Date().toISOString(),
    summary: {
      totalChannels: rows.length,
      recordingNow: rows.filter((r) => r.status === 'RECORDING').length,
      reconnecting: rows.filter((r) => r.status === 'RECONNECTING').length,
      configuredSources: rows.filter((r) => r.source !== null).length,
      totalStorageGb: rows.reduce((sum, r) => sum + r.totalStorageGb, 0),
      totalRecordedHours: rows.reduce((sum, r) => sum + r.totalRecordedHours, 0),
      totalSegments: rows.reduce((sum, r) => sum + r.totalVideoSegments, 0),
    },
    channels: rows,
  };
}

/**
 * Real Autosave-to-Video Archive Timestamp Matching
 * Scans entries for (channelKey, recordDate) and links exact matching verified video_archive segments.
 * Unmatched entries are explicitly recorded as VIDEO_NOT_AVAILABLE — never fabricated!
 */
export function matchAutosaveEntriesToVideoArchive(params: {
  channelKey?: string;
  recordDate?: string;
  batchId?: string;
}): {
  scanned: number;
  matched: number;
  unavailable: number;
} {
  const db = getDb();
  const where: string[] = ['is_deleted_record = 0'];
  const vals: unknown[] = [];

  if (params.channelKey) {
    where.push('channel_key = ?');
    vals.push(params.channelKey);
  }
  if (params.recordDate) {
    where.push('trans_date = ?');
    vals.push(params.recordDate);
  }
  if (params.batchId) {
    where.push('batch_id = ?');
    vals.push(params.batchId);
  }

  const entries = db
    .prepare(
      `SELECT id, channel_key, trans_date, start_seconds, end_seconds
       FROM entries
       WHERE ${where.join(' AND ')}`
    )
    .all(...vals) as Array<{
    id: string;
    channel_key: string;
    trans_date: string | null;
    start_seconds: number | null;
    end_seconds: number | null;
  }>;

  const findArchiveStmt = db.prepare(
    `SELECT id, start_seconds, end_seconds
     FROM video_archive
     WHERE channel_key = ?
       AND record_date = ?
       AND is_verified = 1
       AND start_seconds <= ?
       AND end_seconds >= ?
     ORDER BY start_seconds ASC
     LIMIT 1`
  );

  const upsertMatchStmt = db.prepare(
    `INSERT INTO video_timestamp_matches (
       id, entry_id, channel_key, record_date, entry_start_seconds, entry_end_seconds,
       archive_id, offset_seconds, match_status, matched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       archive_id = excluded.archive_id,
       offset_seconds = excluded.offset_seconds,
       match_status = excluded.match_status,
       matched_at = excluded.matched_at`
  );

  let matched = 0;
  let unavailable = 0;
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    for (const entry of entries) {
      if (!entry.trans_date || entry.start_seconds === null) {
        unavailable++;
        upsertMatchStmt.run(
          `vm_${entry.id}`,
          entry.id,
          entry.channel_key,
          entry.trans_date || '',
          entry.start_seconds,
          entry.end_seconds,
          null,
          null,
          'VIDEO_NOT_AVAILABLE',
          now
        );
        continue;
      }

      const arc = findArchiveStmt.get(
        entry.channel_key,
        entry.trans_date,
        entry.start_seconds,
        entry.start_seconds
      ) as { id: string; start_seconds: number; end_seconds: number } | undefined;

      if (arc) {
        matched++;
        const offset = Math.max(0, entry.start_seconds - arc.start_seconds);
        upsertMatchStmt.run(
          `vm_${entry.id}`,
          entry.id,
          entry.channel_key,
          entry.trans_date,
          entry.start_seconds,
          entry.end_seconds,
          arc.id,
          offset,
          'MATCHED',
          now
        );
      } else {
        unavailable++;
        upsertMatchStmt.run(
          `vm_${entry.id}`,
          entry.id,
          entry.channel_key,
          entry.trans_date,
          entry.start_seconds,
          entry.end_seconds,
          null,
          null,
          'VIDEO_NOT_AVAILABLE',
          now
        );
      }
    }
  });
  tx();

  return { scanned: entries.length, matched, unavailable };
}

/**
 * Real Authorized Historical Video Import into Cloud Storage
 * Downloads an authorized historical video URL via FFmpeg, verifies file integrity, and uploads to S3/R2.
 */
export async function importAuthorizedHistoricalVideo(params: {
  channelKey: string;
  recordDate: string; // YYYY-MM-DD
  startHour: number; // 0..23
  sourceUrl: string;
  triggeredBy: string;
}): Promise<{ ok: boolean; archiveId?: string; error?: string }> {
  const db = getDb();
  const channel = db
    .prepare(`SELECT id, channel_name FROM channels WHERE id = ?`)
    .get(params.channelKey) as { id: string; channel_name: string } | undefined;

  if (!channel) return { ok: false, error: 'Channel not found.' };

  const source = db
    .prepare(`SELECT recording_permission FROM recording_sources WHERE channel_key = ? LIMIT 1`)
    .get(params.channelKey) as { recording_permission: string } | undefined;

  if (source && source.recording_permission !== 'AUTHORIZED') {
    return {
      ok: false,
      error: `Historical import blocked: channel recording permission is "${source.recording_permission}".`,
    };
  }

  const probe = await probeStreamUrl(params.sourceUrl);
  if (!probe.reachable) {
    return {
      ok: false,
      error: `Authorized historical media URL could not be accessed: ${probe.error || 'Unreachable'}`,
    };
  }

  const [yStr, mStr, dStr] = params.recordDate.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (!year || !month || !day) {
    return { ok: false, error: 'Invalid date format (expected YYYY-MM-DD).' };
  }

  const safeKey = channel.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const importDir = path.join(RECORDINGS_DIR, safeKey, 'historical_imports');
  fs.mkdirSync(importDir, { recursive: true });

  const hh = String(Math.max(0, Math.min(23, Math.floor(params.startHour)))).padStart(2, '0');
  const fileName = `hist_${yStr}${mStr}${dStr}_${hh}0000.mp4`;
  const localPath = path.join(importDir, fileName);

  try {
    const { bin: ffmpegBin } = resolveFfmpegBin();
    await execFileAsync(
      ffmpegBin,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        params.sourceUrl.trim(),
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        localPath,
      ],
      { timeout: 10 * 60 * 1000 }
    );
  } catch (err) {
    return {
      ok: false,
      error: `Historical recording download failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!fs.existsSync(localPath) || fs.statSync(localPath).size < 1024) {
    return { ok: false, error: 'Downloaded historical file was empty or invalid.' };
  }

  const stat = fs.statSync(localPath);
  const durationSec = (await probeLocalFileDuration(localPath)) ?? 3600;
  const startSeconds = Math.max(0, Math.min(23, Math.floor(params.startHour))) * 3600;
  const endSeconds = Math.min(86400, startSeconds + durationSec);
  const startIso = `${params.recordDate}T${hh}:00:00.000Z`;
  const endIso = new Date(new Date(startIso).getTime() + durationSec * 1000).toISOString();
  const hash = crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');

  const sessId = `hist_sess_${Date.now()}`;
  const segId = `hist_seg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  // Ensure a recording_source row exists if needed for FK or insert directly into video_archive via uploadSegmentToCloud
  const existingSource = db
    .prepare(`SELECT id FROM recording_sources WHERE channel_key = ? LIMIT 1`)
    .get(channel.id) as { id: string } | undefined;

  if (existingSource) {
    db.prepare(
      `INSERT INTO recording_sessions (
         id, worker_id, channel_key, channel_name, source_id, status,
         started_at, ended_at, last_heartbeat_at, total_segments, total_bytes, total_duration_seconds, auto_recover, created_at
       ) VALUES (?, ?, ?, ?, ?, 'STOPPED', ?, ?, ?, 1, ?, ?, 0, ?)`
    ).run(sessId, WORKER_ID, channel.id, channel.channel_name, existingSource.id, now, now, now, stat.size, durationSec, now);

    db.prepare(
      `INSERT INTO recording_segments (
         id, session_id, channel_key, channel_name, record_date, year, month, day,
         segment_index, start_time_iso, end_time_iso, start_seconds, end_seconds,
         duration_seconds, file_name, local_path, file_size_bytes, sha256,
         status, is_complete, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL_READY', 1, ?, ?)`
    ).run(
      segId,
      sessId,
      channel.id,
      channel.channel_name,
      params.recordDate,
      year,
      month,
      day,
      startIso,
      endIso,
      startSeconds,
      endSeconds,
      durationSec,
      fileName,
      localPath,
      stat.size,
      hash,
      now,
      now
    );

    const uploadRes = await uploadSegmentToCloud(segId);
    if (uploadRes.archiveId) {
      db.prepare(`UPDATE video_archive SET source_origin = 'HISTORICAL_IMPORT' WHERE id = ?`).run(
        uploadRes.archiveId
      );
      matchAutosaveEntriesToVideoArchive({ channelKey: channel.id, recordDate: params.recordDate });
      logAudit({
        entityType: 'VIDEO_ARCHIVE',
        entityId: uploadRes.archiveId,
        action: 'HISTORICAL_VIDEO_IMPORTED',
        notes: `Imported authorized historical video for ${channel.channel_name} (${params.recordDate} ${hh}:00) by ${params.triggeredBy}`,
      });
      return { ok: true, archiveId: uploadRes.archiveId };
    }
    return { ok: false, error: uploadRes.error || 'Upload failed.' };
  }

  // Fallback if channel had no recording_sources row yet: store verified entry directly in video_archive
  const archiveId = `arc_hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT INTO video_archive (
       id, channel_key, channel_name, record_date, year, month, day,
       start_time_iso, end_time_iso, start_seconds, end_seconds, duration_seconds,
       file_size_bytes, storage_provider, bucket, object_key, local_fallback_path,
       sha256, source_origin, segment_id, is_verified, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local_staging', NULL, NULL, ?, ?, 'HISTORICAL_IMPORT', NULL, 1, ?)`
  ).run(
    archiveId,
    channel.id,
    channel.channel_name,
    params.recordDate,
    year,
    month,
    day,
    startIso,
    endIso,
    startSeconds,
    endSeconds,
    durationSec,
    stat.size,
    localPath,
    hash,
    now
  );

  matchAutosaveEntriesToVideoArchive({ channelKey: channel.id, recordDate: params.recordDate });
  return { ok: true, archiveId };
}
