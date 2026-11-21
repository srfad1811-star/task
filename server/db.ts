import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { CustomFieldMapping, QaThresholds } from '../src/types.ts';
import { hashPassword } from './cryptoUtils.ts';

const IS_VERCEL = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const BUNDLED_DATA_DIR = path.resolve(process.cwd(), 'data');

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : IS_VERCEL
    ? path.join('/tmp', 'tv-taskverify-data')
    : BUNDLED_DATA_DIR;
export const DB_PATH = path.join(DATA_DIR, 'broadcast_qa.db');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const XML_ARCHIVE_DIR = path.join(DATA_DIR, 'xml_archive');
export const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');

export const DEFAULT_QA_THRESHOLDS: QaThresholds = {
  gapThresholdSeconds: 5,
  overlapToleranceSeconds: 1.5,
  durationToleranceStrictSeconds: 5,
  durationToleranceWarnSeconds: 1.5,
  duplicateWindowSeconds: 30,
  minAdDurationSeconds: 5,
  maxAdDurationSeconds: 180,
  minProgramDurationSeconds: 60,
  maxProgramDurationSeconds: 21600,
  minPromoDurationSeconds: 3,
  maxPromoDurationSeconds: 180,
  minSpnDurationSeconds: 2,
  maxSpnDurationSeconds: 60,
  minMatchCoverage: 60,
  defaultFps: 25,
  autoBackupBeforeImport: true,
};

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  fs.mkdirSync(XML_ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

  if (DATA_DIR !== BUNDLED_DATA_DIR && !fs.existsSync(DB_PATH)) {
    const bundledDb = path.join(BUNDLED_DATA_DIR, 'broadcast_qa.db');
    if (fs.existsSync(bundledDb)) {
      try {
        fs.copyFileSync(bundledDb, DB_PATH);
      } catch {
        // Fallback to creating a fresh database in DATA_DIR
      }
    }
  }
}

ensureDirectories();

let dbInstance: Database.Database = openDatabase();

function openDatabase(): Database.Database {
  const conn = new Database(DB_PATH);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  initSchema(conn);
  return conn;
}

export function getDb(): Database.Database {
  return dbInstance;
}

export function reopenDatabase() {
  try {
    dbInstance.close();
  } catch {
    // ignore if already closed
  }
  dbInstance = openDatabase();
  return dbInstance;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'OPERATOR',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stream_sources (
      id TEXT PRIMARY KEY,
      channel_key TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'News',
      logo_url TEXT,
      source_type TEXT NOT NULL DEFAULT 'HLS_M3U8',
      stream_url TEXT NOT NULL,
      archive_url_template TEXT,
      playback_status TEXT NOT NULL DEFAULT 'UNTESTED',
      recording_permission TEXT NOT NULL DEFAULT 'AUTHORIZED',
      last_tested_at TEXT,
      can_play INTEGER NOT NULL DEFAULT 1,
      can_record INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      bitrate_kbps INTEGER NOT NULL DEFAULT 2500,
      resolution TEXT NOT NULL DEFAULT '1080p',
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_recordings (
      id TEXT PRIMARY KEY,
      stream_source_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      scheduled_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      recurrence TEXT NOT NULL DEFAULT 'ONCE',
      status TEXT NOT NULL DEFAULT 'SCHEDULED',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      stream_source_id TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL DEFAULT 0,
      duration_seconds REAL NOT NULL DEFAULT 0,
      scheduled_start TEXT NOT NULL,
      scheduled_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      recorded_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      folder_name TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      schema_file_count INTEGER NOT NULL DEFAULT 0,
      data_file_count INTEGER NOT NULL DEFAULT 0,
      records_inserted INTEGER NOT NULL DEFAULT 0,
      records_updated INTEGER NOT NULL DEFAULT 0,
      records_skipped_duplicate INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS xml_archive_files (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL,
      detected_role TEXT NOT NULL,
      has_inline_schema INTEGER NOT NULL DEFAULT 0,
      root_element TEXT,
      record_element TEXT,
      record_count INTEGER NOT NULL DEFAULT 0,
      schema_fields_json TEXT,
      unmapped_fields_json TEXT,
      parse_errors_json TEXT,
      archive_path TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      channel_name TEXT NOT NULL,
      is_selected INTEGER NOT NULL DEFAULT 0,
      source_file TEXT,
      first_seen_at TEXT NOT NULL,
      last_updated_at TEXT NOT NULL,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS commercial_catalog (
      id TEXT PRIMARY KEY,
      commercial_id TEXT,
      caption_id TEXT,
      caption_name TEXT,
      brand_id TEXT,
      brand_name TEXT,
      company_name TEXT,
      category_id TEXT,
      category_name TEXT,
      subcategory_id TEXT,
      subcategory_name TEXT,
      commercial_type_id TEXT,
      commercial_type_name TEXT,
      custom_duration REAL,
      source_duration REAL,
      raw_xml TEXT NOT NULL,
      batch_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      dedup_fingerprint TEXT UNIQUE NOT NULL,
      batch_id TEXT NOT NULL,
      source_file_id TEXT NOT NULL,
      source_role TEXT NOT NULL,
      is_deleted_record INTEGER NOT NULL DEFAULT 0,
      is_reviewed_caption INTEGER NOT NULL DEFAULT 0,
      channel_key TEXT NOT NULL,
      channel_id TEXT,
      channel_name TEXT NOT NULL,
      trans_date TEXT,
      raw_trans_date TEXT,
      entry_type TEXT NOT NULL,
      raw_entry_type TEXT,
      master_entry_id TEXT,
      segment_detail_id TEXT,
      commercial_id TEXT,
      commercial_type_id TEXT,
      commercial_type_name TEXT,
      caption_id TEXT,
      caption_name TEXT,
      brand_id TEXT,
      brand_name TEXT,
      company_name TEXT,
      category_id TEXT,
      category_name TEXT,
      subcategory_id TEXT,
      subcategory_name TEXT,
      start_time TEXT,
      end_time TEXT,
      start_seconds REAL,
      end_seconds REAL,
      duration_seconds REAL,
      raw_duration TEXT,
      source_duration REAL,
      custom_duration REAL,
      start_index INTEGER,
      end_index INTEGER,
      diff_in_index INTEGER,
      start_frame INTEGER,
      end_frame INTEGER,
      start_time_tts TEXT,
      end_time_tts TEXT,
      video_clip_id TEXT,
      video_file_name TEXT,
      file_path TEXT,
      action TEXT,
      left_adjust REAL,
      right_adjust REAL,
      quality_id TEXT,
      match_value REAL,
      match_coverage REAL,
      fdb TEXT,
      is_benchmarked TEXT,
      txt TEXT,
      extra_fields_json TEXT,
      original_values_json TEXT NOT NULL,
      raw_xml TEXT NOT NULL,
      is_manually_edited INTEGER NOT NULL DEFAULT 0,
      qa_status TEXT NOT NULL DEFAULT 'PENDING',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (channel_key) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_entries_channel_date ON entries(channel_key, trans_date, start_seconds);
    CREATE INDEX IF NOT EXISTS idx_entries_qa_status ON entries(qa_status);
    CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(entry_type);
    CREATE INDEX IF NOT EXISTS idx_entries_commercial ON entries(commercial_id);

    CREATE TABLE IF NOT EXISTS qa_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      scope TEXT NOT NULL,
      total_analyzed INTEGER NOT NULL DEFAULT 0,
      red_count INTEGER NOT NULL DEFAULT 0,
      yellow_count INTEGER NOT NULL DEFAULT 0,
      green_count INTEGER NOT NULL DEFAULT 0,
      rules_config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS qa_issues (
      id TEXT PRIMARY KEY,
      qa_run_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      related_entry_id TEXT,
      channel_key TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      trans_date TEXT,
      entry_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      error_type TEXT NOT NULL,
      rule_code TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence_level TEXT NOT NULL,
      evidence_json TEXT,
      resolution_status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TEXT NOT NULL,
      FOREIGN KEY (qa_run_id) REFERENCES qa_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_qa_issues_severity ON qa_issues(severity);
    CREATE INDEX IF NOT EXISTS idx_qa_issues_entry ON qa_issues(entry_id);
    CREATE INDEX IF NOT EXISTS idx_qa_issues_channel_date ON qa_issues(channel_key, trans_date);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      field_name TEXT,
      old_value TEXT,
      new_value TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      trigger_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      entry_count INTEGER NOT NULL DEFAULT 0,
      channel_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- =======================================================================
    -- CLOUD 24/7 RECORDING, S3 STORAGE & VIDEO ARCHIVE ARCHITECTURE
    -- =======================================================================

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recording_sources (
      id TEXT PRIMARY KEY,
      channel_key TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'HLS_M3U8',
      stream_url_encrypted TEXT NOT NULL,
      stream_url_redacted TEXT NOT NULL,
      historical_archive_endpoint TEXT,
      recording_permission TEXT NOT NULL DEFAULT 'AUTHORIZED',
      segment_duration_seconds INTEGER NOT NULL DEFAULT 3600,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      auto_record_24_7 INTEGER NOT NULL DEFAULT 0,
      reconnect_delay_sec INTEGER NOT NULL DEFAULT 10,
      last_probe_status TEXT NOT NULL DEFAULT 'UNTESTED',
      last_probe_at TEXT,
      last_probe_error TEXT,
      video_codec TEXT,
      resolution TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (channel_key) REFERENCES channels(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rec_sources_channel ON recording_sources(channel_key);

    CREATE TABLE IF NOT EXISTS recording_sessions (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      source_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'STARTING',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      last_heartbeat_at TEXT NOT NULL,
      reconnect_count INTEGER NOT NULL DEFAULT 0,
      total_segments INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      total_duration_seconds REAL NOT NULL DEFAULT 0,
      pid INTEGER,
      last_error TEXT,
      auto_recover INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (channel_key) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES recording_sources(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rec_sessions_channel_status ON recording_sessions(channel_key, status);

    CREATE TABLE IF NOT EXISTS recording_segments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      record_date TEXT NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      day INTEGER NOT NULL,
      segment_index INTEGER NOT NULL DEFAULT 0,
      start_time_iso TEXT NOT NULL,
      end_time_iso TEXT,
      start_seconds REAL NOT NULL DEFAULT 0,
      end_seconds REAL NOT NULL DEFAULT 0,
      duration_seconds REAL NOT NULL DEFAULT 0,
      file_name TEXT NOT NULL,
      local_path TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'RECORDING',
      storage_provider TEXT,
      storage_key TEXT,
      is_complete INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_key) REFERENCES channels(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rec_segments_channel_date ON recording_segments(channel_key, record_date, start_seconds);
    CREATE INDEX IF NOT EXISTS idx_rec_segments_status ON recording_segments(status);

    CREATE TABLE IF NOT EXISTS cloud_uploads (
      id TEXT PRIMARY KEY,
      segment_id TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      storage_provider TEXT NOT NULL,
      bucket TEXT NOT NULL,
      object_key TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL DEFAULT 0,
      etag TEXT,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_error TEXT,
      started_at TEXT,
      completed_at TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (segment_id) REFERENCES recording_segments(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_uploads_status ON cloud_uploads(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_cloud_uploads_channel ON cloud_uploads(channel_key, completed_at);

    CREATE TABLE IF NOT EXISTS video_archive (
      id TEXT PRIMARY KEY,
      channel_key TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      record_date TEXT NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      day INTEGER NOT NULL,
      start_time_iso TEXT NOT NULL,
      end_time_iso TEXT NOT NULL,
      start_seconds REAL NOT NULL,
      end_seconds REAL NOT NULL,
      duration_seconds REAL NOT NULL,
      file_size_bytes INTEGER NOT NULL DEFAULT 0,
      storage_provider TEXT NOT NULL,
      bucket TEXT,
      object_key TEXT,
      local_fallback_path TEXT,
      sha256 TEXT,
      source_origin TEXT NOT NULL DEFAULT 'CLOUD_24_7',
      segment_id TEXT,
      is_verified INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (channel_key) REFERENCES channels(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_video_archive_hierarchy ON video_archive(channel_key, year, month, day, start_seconds);
    CREATE INDEX IF NOT EXISTS idx_video_archive_date ON video_archive(channel_key, record_date);

    CREATE TABLE IF NOT EXISTS video_timestamp_matches (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      record_date TEXT NOT NULL,
      entry_start_seconds REAL,
      entry_end_seconds REAL,
      archive_id TEXT,
      offset_seconds REAL,
      match_status TEXT NOT NULL DEFAULT 'VIDEO_NOT_AVAILABLE',
      matched_at TEXT NOT NULL,
      FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
      FOREIGN KEY (archive_id) REFERENCES video_archive(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_matches_entry ON video_timestamp_matches(entry_id);
    CREATE INDEX IF NOT EXISTS idx_video_matches_channel_date ON video_timestamp_matches(channel_key, record_date);

    CREATE TABLE IF NOT EXISTS recording_errors (
      id TEXT PRIMARY KEY,
      channel_key TEXT,
      channel_name TEXT,
      session_id TEXT,
      segment_id TEXT,
      severity TEXT NOT NULL DEFAULT 'ERROR',
      error_code TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rec_errors_created ON recording_errors(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rec_errors_channel ON recording_errors(channel_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS storage_statistics (
      id TEXT PRIMARY KEY,
      snapshot_date TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      total_segments INTEGER NOT NULL DEFAULT 0,
      total_hours REAL NOT NULL DEFAULT 0,
      uploaded_bytes_day INTEGER NOT NULL DEFAULT 0,
      estimated_monthly_cost_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_stats_day_ch ON storage_statistics(snapshot_date, channel_key);

    CREATE TABLE IF NOT EXISTS recording_schedules (
      id TEXT PRIMARY KEY,
      channel_key TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      source_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'CONTINUOUS_24_7',
      start_time TEXT,
      end_time TEXT,
      days_of_week TEXT NOT NULL DEFAULT 'MON,TUE,WED,THU,FRI,SAT,SUN',
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (channel_key) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES recording_sources(id) ON DELETE CASCADE
    );

    -- Canonical compatibility views matching Section 10 naming
    CREATE VIEW IF NOT EXISTS autosave_imports AS SELECT * FROM import_batches;
    CREATE VIEW IF NOT EXISTS autosave_entries AS SELECT * FROM entries;
    CREATE VIEW IF NOT EXISTS user_accounts AS SELECT * FROM users;
    CREATE VIEW IF NOT EXISTS system_settings AS SELECT * FROM app_settings;
  `);

  const now = new Date().toISOString();
  const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)`
  );
  insertSetting.run('qa_thresholds', JSON.stringify(DEFAULT_QA_THRESHOLDS), now);
  insertSetting.run('custom_field_mappings', JSON.stringify([]), now);
  insertSetting.run('custom_entry_type_mappings', JSON.stringify([]), now);
  insertSetting.run(
    'cloud_storage_config',
    JSON.stringify({
      provider: process.env.S3_PROVIDER || 'cloudflare_r2',
      endpoint: process.env.S3_ENDPOINT || '',
      region: process.env.S3_REGION || 'auto',
      bucket: process.env.S3_BUCKET || '',
      accessKeyIdEncrypted: '',
      secretAccessKeyEncrypted: '',
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || '',
      retentionDays: Number(process.env.STORAGE_RETENTION_DAYS) || 30,
      storageBudgetGb: Number(process.env.STORAGE_BUDGET_GB) || 500,
      warningThresholdPct: Number(process.env.STORAGE_WARNING_PCT) || 80,
      costPerGbMonthUsd: Number(process.env.STORAGE_COST_PER_GB_USD) || 0.015,
      defaultSegmentSeconds: Number(process.env.RECORDING_SEGMENT_SECONDS) || 3600,
      deleteLocalAfterVerifiedUpload: false,
      signedUrlExpirySeconds: 3600,
    }),
    now
  );

  // Ensure primary admin account exists; never store hardcoded plaintext credentials
  const envAdminPassword = process.env.ADMIN_PASSWORD?.trim();
  const existingAdmin = db
    .prepare(`SELECT id, password_hash FROM users WHERE id = 'usr_admin' OR username = 'admin'`)
    .get() as { id: string; password_hash: string } | undefined;

  if (!existingAdmin) {
    db.prepare(
      `INSERT INTO users (id, username, password_hash, full_name, role, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).run(
      'usr_admin',
      'admin',
      envAdminPassword ? hashPassword(envAdminPassword) : '',
      'System Administrator',
      'ADMIN',
      now
    );
  } else if (envAdminPassword) {
    db.prepare(`UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?`).run(
      hashPassword(envAdminPassword),
      existingAdmin.id
    );
  } else if (existingAdmin.password_hash && !existingAdmin.password_hash.startsWith('scrypt$')) {
    // Clear legacy unhashed placeholder so admin password must be claimed securely
    db.prepare(`UPDATE users SET password_hash = '' WHERE id = ?`).run(existingAdmin.id);
  }

  // Migration: Ensure new stream_sources columns exist if table was created previously
  const migrations = [
    `ALTER TABLE stream_sources ADD COLUMN category TEXT NOT NULL DEFAULT 'News'`,
    `ALTER TABLE stream_sources ADD COLUMN logo_url TEXT`,
    `ALTER TABLE stream_sources ADD COLUMN source_type TEXT NOT NULL DEFAULT 'HLS_M3U8'`,
    `ALTER TABLE stream_sources ADD COLUMN playback_status TEXT NOT NULL DEFAULT 'UNTESTED'`,
    `ALTER TABLE stream_sources ADD COLUMN recording_permission TEXT NOT NULL DEFAULT 'AUTHORIZED'`,
    `ALTER TABLE stream_sources ADD COLUMN last_tested_at TEXT`,
    `ALTER TABLE stream_sources ADD COLUMN notes TEXT`,
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists or error ignored
    }
  }

  // Do not seed any fake or sample channels/streams; only real authorized channels added by user or imported from autosave
}

export function getQaThresholds(): QaThresholds {
  const row = getDb()
    .prepare(`SELECT value_json FROM app_settings WHERE key = 'qa_thresholds'`)
    .get() as { value_json: string } | undefined;
  if (!row) return { ...DEFAULT_QA_THRESHOLDS };
  try {
    return { ...DEFAULT_QA_THRESHOLDS, ...JSON.parse(row.value_json) };
  } catch {
    return { ...DEFAULT_QA_THRESHOLDS };
  }
}

export function getCustomFieldMappings(): CustomFieldMapping[] {
  const row = getDb()
    .prepare(`SELECT value_json FROM app_settings WHERE key = 'custom_field_mappings'`)
    .get() as { value_json: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getCustomEntryTypeMappings(): Array<{ rawValue: string; targetType: string }> {
  const row = getDb()
    .prepare(`SELECT value_json FROM app_settings WHERE key = 'custom_entry_type_mappings'`)
    .get() as { value_json: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function logAudit(params: {
  entityType: string;
  entityId: string;
  action: string;
  fieldName?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  notes?: string | null;
}) {
  getDb()
    .prepare(
      `INSERT INTO audit_logs (timestamp, entity_type, entity_id, action, field_name, old_value, new_value, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      new Date().toISOString(),
      params.entityType,
      params.entityId,
      params.action,
      params.fieldName ?? null,
      params.oldValue ?? null,
      params.newValue ?? null,
      params.notes ?? null
    );
}

export async function createDatabaseBackup(triggerType: string): Promise<{
  id: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
}> {
  ensureDirectories();
  const db = getDb();
  const id = `bkp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `broadcast_qa_${stamp}_${triggerType.toLowerCase()}.db`;
  const filePath = path.join(BACKUPS_DIR, fileName);

  await db.backup(filePath);
  const stat = fs.statSync(filePath);
  const entryCount = (db.prepare(`SELECT COUNT(*) AS c FROM entries`).get() as { c: number }).c;
  const channelCount = (db.prepare(`SELECT COUNT(*) AS c FROM channels`).get() as { c: number }).c;

  db.prepare(
    `INSERT INTO backups (id, file_name, file_path, size_bytes, trigger_type, created_at, entry_count, channel_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, fileName, filePath, stat.size, triggerType, new Date().toISOString(), entryCount, channelCount);

  logAudit({
    entityType: 'BACKUP',
    entityId: id,
    action: 'BACKUP_CREATED',
    newValue: fileName,
    notes: `Trigger: ${triggerType} (${entryCount} entries, ${channelCount} channels)`,
  });

  return { id, fileName, filePath, sizeBytes: stat.size };
}
