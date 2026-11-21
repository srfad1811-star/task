import fs from 'node:fs';
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDb, logAudit } from './db.ts';
import { decryptSecret, encryptSecret, maskSecret, signPlaybackToken } from './cryptoUtils.ts';

export type StorageProviderType = 'cloudflare_r2' | 'aws_s3' | 'backblaze_b2' | 'minio' | 'custom_s3';

export interface StoredCloudStorageConfig {
  provider: StorageProviderType;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyIdEncrypted: string;
  secretAccessKeyEncrypted: string;
  publicBaseUrl: string;
  retentionDays: number;
  storageBudgetGb: number;
  warningThresholdPct: number;
  costPerGbMonthUsd: number;
  defaultSegmentSeconds: number;
  deleteLocalAfterVerifiedUpload: boolean;
  signedUrlExpirySeconds: number;
}

export interface PublicCloudStorageConfig {
  provider: StorageProviderType;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyIdMasked: string;
  hasSecretKey: boolean;
  isConfigured: boolean;
  configuredViaEnv: boolean;
  publicBaseUrl: string;
  retentionDays: number;
  storageBudgetGb: number;
  warningThresholdPct: number;
  costPerGbMonthUsd: number;
  defaultSegmentSeconds: number;
  deleteLocalAfterVerifiedUpload: boolean;
  signedUrlExpirySeconds: number;
}

export function getRawCloudStorageConfig(): StoredCloudStorageConfig {
  const row = getDb()
    .prepare(`SELECT value_json FROM app_settings WHERE key = 'cloud_storage_config'`)
    .get() as { value_json: string } | undefined;

  let parsed: Partial<StoredCloudStorageConfig> = {};
  if (row) {
    try {
      parsed = JSON.parse(row.value_json) as Partial<StoredCloudStorageConfig>;
    } catch {
      parsed = {};
    }
  }

  return {
    provider: (parsed.provider || (process.env.S3_PROVIDER as StorageProviderType) || 'cloudflare_r2'),
    endpoint: parsed.endpoint || process.env.S3_ENDPOINT || '',
    region: parsed.region || process.env.S3_REGION || 'auto',
    bucket: parsed.bucket || process.env.S3_BUCKET || '',
    accessKeyIdEncrypted: parsed.accessKeyIdEncrypted || '',
    secretAccessKeyEncrypted: parsed.secretAccessKeyEncrypted || '',
    publicBaseUrl: parsed.publicBaseUrl || process.env.S3_PUBLIC_BASE_URL || '',
    retentionDays: Number(parsed.retentionDays ?? process.env.STORAGE_RETENTION_DAYS ?? 30),
    storageBudgetGb: Number(parsed.storageBudgetGb ?? process.env.STORAGE_BUDGET_GB ?? 500),
    warningThresholdPct: Number(parsed.warningThresholdPct ?? process.env.STORAGE_WARNING_PCT ?? 80),
    costPerGbMonthUsd: Number(parsed.costPerGbMonthUsd ?? process.env.STORAGE_COST_PER_GB_USD ?? 0.015),
    defaultSegmentSeconds: Number(parsed.defaultSegmentSeconds ?? process.env.RECORDING_SEGMENT_SECONDS ?? 3600),
    deleteLocalAfterVerifiedUpload: Boolean(parsed.deleteLocalAfterVerifiedUpload ?? false),
    signedUrlExpirySeconds: Number(parsed.signedUrlExpirySeconds ?? 3600),
  };
}

function getEffectiveCredentials(cfg: StoredCloudStorageConfig): {
  accessKeyId: string;
  secretAccessKey: string;
  fromEnv: boolean;
} {
  const dbAccess = decryptSecret(cfg.accessKeyIdEncrypted);
  const dbSecret = decryptSecret(cfg.secretAccessKeyEncrypted);
  if (dbAccess && dbSecret) {
    return { accessKeyId: dbAccess, secretAccessKey: dbSecret, fromEnv: false };
  }
  const envAccess = process.env.S3_ACCESS_KEY_ID || '';
  const envSecret = process.env.S3_SECRET_ACCESS_KEY || '';
  return {
    accessKeyId: envAccess,
    secretAccessKey: envSecret,
    fromEnv: Boolean(envAccess && envSecret),
  };
}

export function getPublicCloudStorageConfig(): PublicCloudStorageConfig {
  const cfg = getRawCloudStorageConfig();
  const creds = getEffectiveCredentials(cfg);
  const isConfigured = Boolean(cfg.bucket && creds.accessKeyId && creds.secretAccessKey);

  return {
    provider: cfg.provider,
    endpoint: cfg.endpoint,
    region: cfg.region,
    bucket: cfg.bucket,
    accessKeyIdMasked: maskSecret(creds.accessKeyId),
    hasSecretKey: Boolean(creds.secretAccessKey),
    isConfigured,
    configuredViaEnv: creds.fromEnv,
    publicBaseUrl: cfg.publicBaseUrl,
    retentionDays: cfg.retentionDays,
    storageBudgetGb: cfg.storageBudgetGb,
    warningThresholdPct: cfg.warningThresholdPct,
    costPerGbMonthUsd: cfg.costPerGbMonthUsd,
    defaultSegmentSeconds: cfg.defaultSegmentSeconds,
    deleteLocalAfterVerifiedUpload: cfg.deleteLocalAfterVerifiedUpload,
    signedUrlExpirySeconds: cfg.signedUrlExpirySeconds,
  };
}

export function updateCloudStorageConfig(input: {
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
}): PublicCloudStorageConfig {
  const current = getRawCloudStorageConfig();
  const next: StoredCloudStorageConfig = {
    ...current,
    provider: input.provider ?? current.provider,
    endpoint: input.endpoint !== undefined ? input.endpoint.trim() : current.endpoint,
    region: input.region !== undefined ? input.region.trim() || 'auto' : current.region,
    bucket: input.bucket !== undefined ? input.bucket.trim() : current.bucket,
    publicBaseUrl: input.publicBaseUrl !== undefined ? input.publicBaseUrl.trim() : current.publicBaseUrl,
    retentionDays:
      input.retentionDays !== undefined ? Math.max(1, Math.min(3650, Number(input.retentionDays))) : current.retentionDays,
    storageBudgetGb:
      input.storageBudgetGb !== undefined ? Math.max(1, Number(input.storageBudgetGb)) : current.storageBudgetGb,
    warningThresholdPct:
      input.warningThresholdPct !== undefined
        ? Math.max(10, Math.min(99, Number(input.warningThresholdPct)))
        : current.warningThresholdPct,
    costPerGbMonthUsd:
      input.costPerGbMonthUsd !== undefined ? Math.max(0, Number(input.costPerGbMonthUsd)) : current.costPerGbMonthUsd,
    defaultSegmentSeconds:
      input.defaultSegmentSeconds !== undefined
        ? Math.max(60, Math.min(7200, Number(input.defaultSegmentSeconds)))
        : current.defaultSegmentSeconds,
    deleteLocalAfterVerifiedUpload:
      input.deleteLocalAfterVerifiedUpload !== undefined
        ? Boolean(input.deleteLocalAfterVerifiedUpload)
        : current.deleteLocalAfterVerifiedUpload,
    signedUrlExpirySeconds:
      input.signedUrlExpirySeconds !== undefined
        ? Math.max(60, Math.min(86400, Number(input.signedUrlExpirySeconds)))
        : current.signedUrlExpirySeconds,
    accessKeyIdEncrypted:
      input.accessKeyId && input.accessKeyId.trim()
        ? encryptSecret(input.accessKeyId.trim())
        : current.accessKeyIdEncrypted,
    secretAccessKeyEncrypted:
      input.secretAccessKey && input.secretAccessKey.trim()
        ? encryptSecret(input.secretAccessKey.trim())
        : current.secretAccessKeyEncrypted,
  };

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('cloud_storage_config', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
    .run(JSON.stringify(next), now);

  logAudit({
    entityType: 'STORAGE_CONFIG',
    entityId: next.provider,
    action: 'CLOUD_STORAGE_CONFIG_UPDATED',
    notes: `Provider: ${next.provider}, Bucket: ${next.bucket || '(unset)'}, Budget: ${next.storageBudgetGb} GB, Retention: ${next.retentionDays}d`,
  });

  return getPublicCloudStorageConfig();
}

export function createS3Client(): { client: S3Client; config: StoredCloudStorageConfig } | null {
  const config = getRawCloudStorageConfig();
  const creds = getEffectiveCredentials(config);
  if (!config.bucket || !creds.accessKeyId || !creds.secretAccessKey) {
    return null;
  }

  const client = new S3Client({
    region: config.region || 'auto',
    endpoint: config.endpoint || undefined,
    forcePathStyle: config.provider === 'minio' || config.provider === 'custom_s3',
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
  });

  return { client, config };
}

export async function testCloudStorageConnection(): Promise<{
  ok: boolean;
  provider: string;
  bucket: string;
  latencyMs: number;
  message: string;
}> {
  const started = Date.now();
  const s3 = createS3Client();
  const pub = getPublicCloudStorageConfig();
  if (!s3) {
    return {
      ok: false,
      provider: pub.provider,
      bucket: pub.bucket,
      latencyMs: Date.now() - started,
      message:
        'Cloud object storage credentials are not configured yet. Configure S3/R2 endpoint, bucket, access key, and secret key in Storage Management or server environment variables.',
    };
  }

  try {
    await s3.client.send(new HeadBucketCommand({ Bucket: s3.config.bucket }));
    return {
      ok: true,
      provider: s3.config.provider,
      bucket: s3.config.bucket,
      latencyMs: Date.now() - started,
      message: `Connected and verified bucket "${s3.config.bucket}" on ${s3.config.provider}.`,
    };
  } catch (err) {
    return {
      ok: false,
      provider: s3.config.provider,
      bucket: s3.config.bucket,
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : 'Bucket verification failed.',
    };
  }
}

export function buildArchiveObjectKey(params: {
  channelKey: string;
  year: number;
  month: number;
  day: number;
  fileName: string;
}): string {
  const safeChannel = params.channelKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const mm = String(params.month).padStart(2, '0');
  const dd = String(params.day).padStart(2, '0');
  return `recordings/${safeChannel}/${params.year}/${mm}/${dd}/${params.fileName}`;
}

export async function uploadSegmentToCloud(segmentId: string): Promise<{
  ok: boolean;
  archiveId?: string;
  error?: string;
}> {
  const db = getDb();
  const seg = db
    .prepare(`SELECT * FROM recording_segments WHERE id = ?`)
    .get(segmentId) as
    | {
        id: string;
        session_id: string;
        channel_key: string;
        channel_name: string;
        record_date: string;
        year: number;
        month: number;
        day: number;
        start_time_iso: string;
        end_time_iso: string;
        start_seconds: number;
        end_seconds: number;
        duration_seconds: number;
        file_name: string;
        local_path: string;
        file_size_bytes: number;
        sha256: string | null;
        is_complete: number;
      }
    | undefined;

  if (!seg) return { ok: false, error: 'Segment record not found.' };
  if (!seg.is_complete) return { ok: false, error: 'Segment is still recording and not complete.' };
  if (!fs.existsSync(seg.local_path)) {
    return { ok: false, error: `Local segment file missing: ${seg.file_name}` };
  }

  const stat = fs.statSync(seg.local_path);
  if (stat.size <= 0) {
    return { ok: false, error: 'Segment file is empty (0 bytes).' };
  }

  const s3 = createS3Client();
  const objectKey = buildArchiveObjectKey({
    channelKey: seg.channel_key,
    year: seg.year,
    month: seg.month,
    day: seg.day,
    fileName: seg.file_name,
  });

  const now = new Date().toISOString();

  // If S3/R2 is not configured yet, record honest upload failure in cloud_uploads
  // and keep the verified local segment accessible via signed server playback until cloud credentials are configured.
  if (!s3) {
    const uploadId = `upl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    db.prepare(
      `INSERT INTO cloud_uploads (id, segment_id, channel_key, storage_provider, bucket, object_key, file_size_bytes, status, attempts, max_attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 'unconfigured', '', ?, ?, 'FAILED', 1, 5, ?, ?, ?)`
    ).run(
      uploadId,
      seg.id,
      seg.channel_key,
      objectKey,
      stat.size,
      'Cloud object storage (S3/R2) is not configured yet. Configure credentials in Storage Management and click Retry Failed Uploads.',
      now,
      now
    );

    // Register verified local-staged recording in video_archive so playback and timestamp matching work while awaiting cloud upload
    const archiveId = upsertVideoArchiveEntry({
      seg,
      fileSizeBytes: stat.size,
      storageProvider: 'local_staging',
      bucket: null,
      objectKey: null,
      localFallbackPath: seg.local_path,
      sourceOrigin: 'CLOUD_24_7',
    });

    db.prepare(`UPDATE recording_segments SET status = 'LOCAL_READY', file_size_bytes = ?, updated_at = ? WHERE id = ?`).run(
      stat.size,
      now,
      seg.id
    );

    return {
      ok: false,
      archiveId,
      error: 'S3/R2 credentials not configured — segment verified locally and queued for cloud upload retry.',
    };
  }

  const existingUpload = db
    .prepare(`SELECT * FROM cloud_uploads WHERE segment_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(seg.id) as { id: string; attempts: number; max_attempts: number } | undefined;

  const uploadId = existingUpload?.id ?? `upl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const attempts = (existingUpload?.attempts ?? 0) + 1;

  if (existingUpload) {
    db.prepare(
      `UPDATE cloud_uploads SET status = 'UPLOADING', attempts = ?, started_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`
    ).run(attempts, now, now, uploadId);
  } else {
    db.prepare(
      `INSERT INTO cloud_uploads (id, segment_id, channel_key, storage_provider, bucket, object_key, file_size_bytes, status, attempts, max_attempts, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'UPLOADING', ?, 5, ?, ?, ?)`
    ).run(
      uploadId,
      seg.id,
      seg.channel_key,
      s3.config.provider,
      s3.config.bucket,
      objectKey,
      stat.size,
      attempts,
      now,
      now,
      now
    );
  }

  db.prepare(`UPDATE recording_segments SET status = 'UPLOADING', updated_at = ? WHERE id = ?`).run(now, seg.id);

  try {
    const fileStream = fs.createReadStream(seg.local_path);
    const putResp = await s3.client.send(
      new PutObjectCommand({
        Bucket: s3.config.bucket,
        Key: objectKey,
        Body: fileStream,
        ContentLength: stat.size,
        ContentType: 'video/mp4',
        Metadata: {
          channelKey: seg.channel_key,
          recordDate: seg.record_date,
          sha256: seg.sha256 || '',
        },
      })
    );

    // Strictly verify object presence and byte size via HeadObject before marking VERIFIED
    const headResp = await s3.client.send(
      new HeadObjectCommand({
        Bucket: s3.config.bucket,
        Key: objectKey,
      })
    );

    if (headResp.ContentLength !== undefined && headResp.ContentLength !== stat.size) {
      throw new Error(
        `Upload size verification mismatch: expected ${stat.size} bytes, remote object has ${headResp.ContentLength} bytes.`
      );
    }

    const verifiedAt = new Date().toISOString();
    const etag = (putResp.ETag || headResp.ETag || '').replace(/"/g, '');

    db.prepare(
      `UPDATE cloud_uploads SET status = 'VERIFIED', etag = ?, completed_at = ?, verified_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`
    ).run(etag, verifiedAt, verifiedAt, verifiedAt, uploadId);

    db.prepare(
      `UPDATE recording_segments SET status = 'UPLOADED', storage_provider = ?, storage_key = ?, file_size_bytes = ?, updated_at = ? WHERE id = ?`
    ).run(s3.config.provider, objectKey, stat.size, verifiedAt, seg.id);

    const archiveId = upsertVideoArchiveEntry({
      seg,
      fileSizeBytes: stat.size,
      storageProvider: s3.config.provider,
      bucket: s3.config.bucket,
      objectKey,
      localFallbackPath: s3.config.deleteLocalAfterVerifiedUpload ? null : seg.local_path,
      sourceOrigin: 'CLOUD_24_7',
    });

    // Only delete local staging file if user explicitly enabled that option AND cloud verification succeeded
    if (s3.config.deleteLocalAfterVerifiedUpload && fs.existsSync(seg.local_path)) {
      try {
        fs.unlinkSync(seg.local_path);
      } catch {
        // non-fatal
      }
    }

    refreshDailyStorageStats(seg.channel_key, seg.record_date);
    return { ok: true, archiveId };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failAt = new Date().toISOString();

    db.prepare(
      `UPDATE cloud_uploads SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?`
    ).run(errMsg, failAt, uploadId);

    db.prepare(
      `UPDATE recording_segments SET status = 'FAILED', updated_at = ? WHERE id = ?`
    ).run(failAt, seg.id);

    db.prepare(
      `INSERT INTO recording_errors (id, channel_key, channel_name, session_id, segment_id, severity, error_code, message, details, created_at)
       VALUES (?, ?, ?, ?, ?, 'ERROR', 'CLOUD_UPLOAD_FAILED', ?, ?, ?)`
    ).run(
      `err_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      seg.channel_key,
      seg.channel_name,
      seg.session_id,
      seg.id,
      `Cloud upload failed for ${seg.file_name}`,
      errMsg,
      failAt
    );

    return { ok: false, error: errMsg };
  }
}

export function upsertVideoArchiveEntry(params: {
  seg: {
    id: string;
    channel_key: string;
    channel_name: string;
    record_date: string;
    year: number;
    month: number;
    day: number;
    start_time_iso: string;
    end_time_iso: string;
    start_seconds: number;
    end_seconds: number;
    duration_seconds: number;
    sha256: string | null;
  };
  fileSizeBytes: number;
  storageProvider: string;
  bucket: string | null;
  objectKey: string | null;
  localFallbackPath: string | null;
  sourceOrigin: 'CLOUD_24_7' | 'HISTORICAL_IMPORT';
}): string {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM video_archive WHERE segment_id = ?`)
    .get(params.seg.id) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE video_archive SET
         file_size_bytes = ?,
         storage_provider = ?,
         bucket = ?,
         object_key = ?,
         local_fallback_path = ?,
         is_verified = 1
       WHERE id = ?`
    ).run(
      params.fileSizeBytes,
      params.storageProvider,
      params.bucket,
      params.objectKey,
      params.localFallbackPath,
      existing.id
    );
    return existing.id;
  }

  const archiveId = `arc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(
    `INSERT INTO video_archive (
       id, channel_key, channel_name, record_date, year, month, day,
       start_time_iso, end_time_iso, start_seconds, end_seconds, duration_seconds,
       file_size_bytes, storage_provider, bucket, object_key, local_fallback_path,
       sha256, source_origin, segment_id, is_verified, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    archiveId,
    params.seg.channel_key,
    params.seg.channel_name,
    params.seg.record_date,
    params.seg.year,
    params.seg.month,
    params.seg.day,
    params.seg.start_time_iso,
    params.seg.end_time_iso,
    params.seg.start_seconds,
    params.seg.end_seconds,
    params.seg.duration_seconds,
    params.fileSizeBytes,
    params.storageProvider,
    params.bucket,
    params.objectKey,
    params.localFallbackPath,
    params.seg.sha256,
    params.sourceOrigin,
    params.seg.id,
    new Date().toISOString()
  );

  return archiveId;
}

export async function generateTimeLimitedPlaybackUrl(archiveId: string): Promise<{
  url: string;
  expiresAt: string;
  storageProvider: string;
} | null> {
  const row = getDb()
    .prepare(`SELECT * FROM video_archive WHERE id = ? AND is_verified = 1`)
    .get(archiveId) as
    | {
        id: string;
        storage_provider: string;
        bucket: string | null;
        object_key: string | null;
        local_fallback_path: string | null;
      }
    | undefined;

  if (!row) return null;

  const cfg = getRawCloudStorageConfig();
  const expirySec = cfg.signedUrlExpirySeconds || 3600;
  const expiresAtEpoch = Math.floor(Date.now() / 1000) + expirySec;
  const expiresAtIso = new Date(expiresAtEpoch * 1000).toISOString();

  if (row.object_key && row.bucket && row.storage_provider !== 'local_staging') {
    const s3 = createS3Client();
    if (s3) {
      const cmd = new GetObjectCommand({
        Bucket: row.bucket,
        Key: row.object_key,
      });
      const signed = await getSignedUrl(s3.client, cmd, { expiresIn: expirySec });
      return {
        url: signed,
        expiresAt: expiresAtIso,
        storageProvider: row.storage_provider,
      };
    }
  }

  if (row.local_fallback_path && fs.existsSync(row.local_fallback_path)) {
    const token = signPlaybackToken(row.id, expiresAtEpoch);
    return {
      url: `/api/video/stream/${encodeURIComponent(row.id)}?exp=${expiresAtEpoch}&token=${token}`,
      expiresAt: expiresAtIso,
      storageProvider: 'local_staging',
    };
  }

  return null;
}

export function refreshDailyStorageStats(channelKey: string, snapshotDate: string) {
  const db = getDb();
  const cfg = getRawCloudStorageConfig();
  const agg = db
    .prepare(
      `SELECT
         COALESCE(SUM(file_size_bytes), 0) AS total_bytes,
         COUNT(*) AS total_segments,
         COALESCE(SUM(duration_seconds), 0) / 3600.0 AS total_hours
       FROM video_archive
       WHERE channel_key = ? AND is_verified = 1`
    )
    .get(channelKey) as { total_bytes: number; total_segments: number; total_hours: number };

  const dayAgg = db
    .prepare(
      `SELECT COALESCE(SUM(file_size_bytes), 0) AS day_bytes
       FROM video_archive
       WHERE channel_key = ? AND record_date = ? AND is_verified = 1`
    )
    .get(channelKey, snapshotDate) as { day_bytes: number };

  const gb = agg.total_bytes / (1024 ** 3);
  const cost = gb * cfg.costPerGbMonthUsd;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO storage_statistics (
       id, snapshot_date, channel_key, total_bytes, total_segments, total_hours,
       uploaded_bytes_day, estimated_monthly_cost_usd, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(snapshot_date, channel_key) DO UPDATE SET
       total_bytes = excluded.total_bytes,
       total_segments = excluded.total_segments,
       total_hours = excluded.total_hours,
       uploaded_bytes_day = excluded.uploaded_bytes_day,
       estimated_monthly_cost_usd = excluded.estimated_monthly_cost_usd,
       updated_at = excluded.updated_at`
  ).run(
    `st_${snapshotDate}_${channelKey}`,
    snapshotDate,
    channelKey,
    agg.total_bytes,
    agg.total_segments,
    agg.total_hours,
    dayAgg.day_bytes,
    cost,
    now
  );
}

export function getStorageAnalytics() {
  const db = getDb();
  const cfg = getPublicCloudStorageConfig();

  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(file_size_bytes), 0) AS totalBytes,
         COUNT(*) AS totalSegments,
         COALESCE(SUM(duration_seconds), 0) / 3600.0 AS totalHours,
         COALESCE(SUM(CASE WHEN storage_provider != 'local_staging' THEN file_size_bytes ELSE 0 END), 0) AS cloudUploadedBytes,
         COALESCE(SUM(CASE WHEN storage_provider = 'local_staging' THEN file_size_bytes ELSE 0 END), 0) AS localStagedBytes
       FROM video_archive
       WHERE is_verified = 1`
    )
    .get() as {
    totalBytes: number;
    totalSegments: number;
    totalHours: number;
    cloudUploadedBytes: number;
    localStagedBytes: number;
  };

  const todayStr = new Date().toISOString().slice(0, 10);
  const monthPrefix = todayStr.slice(0, 7);

  const dailyRow = db
    .prepare(
      `SELECT COALESCE(SUM(file_size_bytes), 0) AS bytes, COUNT(*) AS segments
       FROM video_archive WHERE record_date = ? AND is_verified = 1`
    )
    .get(todayStr) as { bytes: number; segments: number };

  const monthlyRow = db
    .prepare(
      `SELECT COALESCE(SUM(file_size_bytes), 0) AS bytes, COUNT(*) AS segments
       FROM video_archive WHERE substr(record_date, 1, 7) = ? AND is_verified = 1`
    )
    .get(monthPrefix) as { bytes: number; segments: number };

  const perChannel = db
    .prepare(
      `SELECT
         c.id AS channelKey,
         c.channel_name AS channelName,
         COALESCE(SUM(v.file_size_bytes), 0) AS totalBytes,
         COUNT(v.id) AS segmentCount,
         COALESCE(SUM(v.duration_seconds), 0) / 3600.0 AS totalHours,
         MAX(v.created_at) AS lastArchivedAt
       FROM channels c
       LEFT JOIN video_archive v ON v.channel_key = c.id AND v.is_verified = 1
       GROUP BY c.id
       ORDER BY totalBytes DESC, c.channel_name ASC`
    )
    .all() as Array<{
    channelKey: string;
    channelName: string;
    totalBytes: number;
    segmentCount: number;
    totalHours: number;
    lastArchivedAt: string | null;
  }>;

  const uploadQueueSummary = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status = 'UPLOADING' THEN 1 ELSE 0 END) AS uploading,
         SUM(CASE WHEN status = 'VERIFIED' THEN 1 ELSE 0 END) AS verified,
         SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
       FROM cloud_uploads`
    )
    .get() as {
    queued: number | null;
    uploading: number | null;
    verified: number | null;
    failed: number | null;
  };

  const totalGb = totals.totalBytes / (1024 ** 3);
  const usagePct = cfg.storageBudgetGb > 0 ? (totalGb / cfg.storageBudgetGb) * 100 : 0;
  const estimatedMonthlyCostUsd = totalGb * cfg.costPerGbMonthUsd;

  const warnings: Array<{ level: 'WARN' | 'CRITICAL'; message: string }> = [];
  if (!cfg.isConfigured) {
    warnings.push({
      level: 'WARN',
      message: 'Cloud object storage (Cloudflare R2 / Amazon S3) credentials are not configured yet. Configure credentials to upload recordings to cloud storage.',
    });
  }
  if (usagePct >= 100) {
    warnings.push({
      level: 'CRITICAL',
      message: `Storage budget exceeded (${totalGb.toFixed(2)} GB / ${cfg.storageBudgetGb} GB). Increase budget or export/archive older segments manually — recordings are never silently deleted.`,
    });
  } else if (usagePct >= cfg.warningThresholdPct) {
    warnings.push({
      level: 'WARN',
      message: `Storage usage is at ${usagePct.toFixed(1)}% of configured ${cfg.storageBudgetGb} GB budget (threshold ${cfg.warningThresholdPct}%).`,
    });
  }
  if ((uploadQueueSummary.failed ?? 0) > 0) {
    warnings.push({
      level: 'WARN',
      message: `${uploadQueueSummary.failed} recording segment upload(s) failed verification and need retry.`,
    });
  }

  return {
    config: cfg,
    totalBytes: totals.totalBytes,
    totalGb,
    cloudUploadedBytes: totals.cloudUploadedBytes,
    localStagedBytes: totals.localStagedBytes,
    totalSegments: totals.totalSegments,
    totalHours: totals.totalHours,
    dailyUploadBytes: dailyRow.bytes,
    dailySegments: dailyRow.segments,
    monthlyUploadBytes: monthlyRow.bytes,
    monthlySegments: monthlyRow.segments,
    estimatedMonthlyCostUsd,
    budgetGb: cfg.storageBudgetGb,
    availableBudgetGb: Math.max(0, cfg.storageBudgetGb - totalGb),
    usagePct,
    retentionDays: cfg.retentionDays,
    uploadQueue: {
      queued: uploadQueueSummary.queued ?? 0,
      uploading: uploadQueueSummary.uploading ?? 0,
      verified: uploadQueueSummary.verified ?? 0,
      failed: uploadQueueSummary.failed ?? 0,
    },
    warnings,
    perChannel: perChannel.map((row) => ({
      ...row,
      totalGb: row.totalBytes / (1024 ** 3),
      estimatedMonthlyCostUsd: (row.totalBytes / (1024 ** 3)) * cfg.costPerGbMonthUsd,
    })),
  };
}
