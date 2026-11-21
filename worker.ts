/**
 * Standalone 24/7 Cloud Recording & S3 Upload Worker
 * Runs independently of Chrome and independently of the Express web server.
 * Launch via: npm run worker
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  checkFfmpegAvailable,
  getWorkerIdentity,
  installRuntimeFfmpeg,
  recoverRecordingSessionsOnStartup,
  stopChannelRecording,
} from './server/recordingEngine.ts';
import { getDb } from './server/db.ts';

function loadLocalEnvFile() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function main() {
  loadLocalEnvFile();
  let ffmpeg = await checkFfmpegAvailable();
  const worker = getWorkerIdentity();
  console.log(`[BroadcastQA Worker] Booting ${worker.workerId} (PID ${worker.pid})`);
  if (!ffmpeg.available) {
    console.log('[BroadcastQA Worker] System FFmpeg not found — attempting runtime FFmpeg download…');
    await installRuntimeFfmpeg();
    ffmpeg = await checkFfmpegAvailable();
  }
  console.log(
    `[BroadcastQA Worker] FFmpeg: ${ffmpeg.available ? ffmpeg.version : 'NOT INSTALLED'}`
  );

  if (!ffmpeg.available) {
    console.error('[BroadcastQA Worker] FFmpeg binary is required for 24/7 recording.');
    process.exit(1);
  }

  await recoverRecordingSessionsOnStartup();
  console.log('[BroadcastQA Worker] Auto-recovery & schedule/upload workers active.');

  const shutdown = async (signal: string) => {
    console.log(`[BroadcastQA Worker] Received ${signal}, stopping active recordings cleanly…`);
    const active = getDb()
      .prepare(
        `SELECT DISTINCT channel_key FROM recording_sessions WHERE status IN ('STARTING', 'RECORDING', 'RECONNECTING')`
      )
      .all() as Array<{ channel_key: string }>;

    for (const row of active) {
      await stopChannelRecording(row.channel_key, `worker_${signal}`).catch(() => {});
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[BroadcastQA Worker] Fatal startup error:', err);
  process.exit(1);
});
