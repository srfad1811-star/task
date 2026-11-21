// server/app.ts
import express3 from "express";
import fs6 from "node:fs";
import path4 from "node:path";
import multer from "multer";

// server/db.ts
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// server/cryptoUtils.ts
import crypto from "node:crypto";
var MASTER_SECRET_RAW = process.env.STORAGE_ENCRYPTION_KEY || process.env.SESSION_SECRET || "broadcastqa-studio-default-local-key-change-in-production";
var AES_KEY = crypto.createHash("sha256").update(MASTER_SECRET_RAW).digest();
function encryptSecret(plainText) {
  if (!plainText) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", AES_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}
function decryptSecret(cipherText) {
  if (!cipherText) return "";
  if (!cipherText.startsWith("enc:v1:")) {
    return cipherText;
  }
  try {
    const [, , ivHex, tagHex, dataHex] = cipherText.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", AES_KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final()
    ]);
    return decrypted.toString("utf8");
  } catch {
    return "";
  }
}
function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 6) return "\u2022\u2022\u2022\u2022\u2022\u2022";
  return `${value.slice(0, 3)}\u2022\u2022\u2022\u2022\u2022\u2022${value.slice(-3)}`;
}
function signPlaybackToken(archiveId, expiresAtEpochSec) {
  return crypto.createHmac("sha256", AES_KEY).update(`playback:${archiveId}:${expiresAtEpochSec}`).digest("hex");
}
function verifyPlaybackToken(archiveId, expiresAtEpochSec, token) {
  if (!token || !Number.isFinite(expiresAtEpochSec)) return false;
  if (Math.floor(Date.now() / 1e3) > expiresAtEpochSec) return false;
  const expected = signPlaybackToken(archiveId, expiresAtEpochSec);
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
function signStatelessSessionToken(claims) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const nonce = crypto.randomBytes(12).toString("hex");
  const body = `v1.${nonce}.${payload}`;
  const sig = crypto.createHmac("sha256", AES_KEY).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyStatelessSessionToken(token) {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const body = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const sig = parts[3];
  if (!sig) return null;
  const expectedSig = crypto.createHmac("sha256", AES_KEY).update(body).digest("base64url");
  const bufSig = Buffer.from(sig, "utf8");
  const bufExpected = Buffer.from(expectedSig, "utf8");
  if (bufSig.length !== bufExpected.length || !crypto.timingSafeEqual(bufSig, bufExpected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(parts[2], "base64url").toString("utf8"));
    if (!parsed?.id || !parsed?.username || !parsed?.role || typeof parsed.exp !== "number") {
      return null;
    }
    if (parsed.exp <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}
function redactStreamCredentials(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = parsed.password ? "***" : "";
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/token|key|pass|secret|auth|sig/i.test(key)) {
        parsed.searchParams.set(key, "***");
      }
    }
    return parsed.toString();
  } catch {
    return url.replace(/(token|key|pass|secret|auth)=([^&\s]+)/gi, "$1=***");
  }
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}
function verifyPassword(password, storedHash) {
  if (!password || !storedHash || !storedHash.startsWith("scrypt$")) {
    return false;
  }
  const parts = storedHash.split("$");
  if (parts.length !== 3) return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, "hex");
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
function safeTimingEqualText(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function verifySha256Digest(plainInput, expectedHex) {
  if (!plainInput || !expectedHex) return false;
  const actual = crypto.createHash("sha256").update(plainInput, "utf8").digest();
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// server/db.ts
var IS_VERCEL = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
var BUNDLED_DATA_DIR = path.resolve(process.cwd(), "data");
var DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : IS_VERCEL ? path.join("/tmp", "tv-taskverify-data") : BUNDLED_DATA_DIR;
var DB_PATH = path.join(DATA_DIR, "broadcast_qa.db");
var BACKUPS_DIR = path.join(DATA_DIR, "backups");
var XML_ARCHIVE_DIR = path.join(DATA_DIR, "xml_archive");
var RECORDINGS_DIR = path.join(DATA_DIR, "recordings");
var DEFAULT_QA_THRESHOLDS = {
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
  autoBackupBeforeImport: true
};
function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  fs.mkdirSync(XML_ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  if (DATA_DIR !== BUNDLED_DATA_DIR && !fs.existsSync(DB_PATH)) {
    const bundledDb = path.join(BUNDLED_DATA_DIR, "broadcast_qa.db");
    if (fs.existsSync(bundledDb)) {
      try {
        fs.copyFileSync(bundledDb, DB_PATH);
      } catch {
      }
    }
  }
}
ensureDirectories();
var dbInstance = openDatabase();
function openDatabase() {
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  initSchema(conn);
  return conn;
}
function getDb() {
  return dbInstance;
}
function reopenDatabase() {
  try {
    dbInstance.close();
  } catch {
  }
  dbInstance = openDatabase();
  return dbInstance;
}
function initSchema(db) {
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
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)`
  );
  insertSetting.run("qa_thresholds", JSON.stringify(DEFAULT_QA_THRESHOLDS), now);
  insertSetting.run("custom_field_mappings", JSON.stringify([]), now);
  insertSetting.run("custom_entry_type_mappings", JSON.stringify([]), now);
  insertSetting.run(
    "cloud_storage_config",
    JSON.stringify({
      provider: process.env.S3_PROVIDER || "cloudflare_r2",
      endpoint: process.env.S3_ENDPOINT || "",
      region: process.env.S3_REGION || "auto",
      bucket: process.env.S3_BUCKET || "",
      accessKeyIdEncrypted: "",
      secretAccessKeyEncrypted: "",
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || "",
      retentionDays: Number(process.env.STORAGE_RETENTION_DAYS) || 30,
      storageBudgetGb: Number(process.env.STORAGE_BUDGET_GB) || 500,
      warningThresholdPct: Number(process.env.STORAGE_WARNING_PCT) || 80,
      costPerGbMonthUsd: Number(process.env.STORAGE_COST_PER_GB_USD) || 0.015,
      defaultSegmentSeconds: Number(process.env.RECORDING_SEGMENT_SECONDS) || 3600,
      deleteLocalAfterVerifiedUpload: false,
      signedUrlExpirySeconds: 3600
    }),
    now
  );
  const envAdminPassword = process.env.ADMIN_PASSWORD?.trim();
  const existingAdmin = db.prepare(`SELECT id, password_hash FROM users WHERE id = 'usr_admin' OR username = 'admin'`).get();
  if (!existingAdmin) {
    db.prepare(
      `INSERT INTO users (id, username, password_hash, full_name, role, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).run(
      "usr_admin",
      "admin",
      envAdminPassword ? hashPassword(envAdminPassword) : "",
      "System Administrator",
      "ADMIN",
      now
    );
  } else if (envAdminPassword) {
    db.prepare(`UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?`).run(
      hashPassword(envAdminPassword),
      existingAdmin.id
    );
  } else if (existingAdmin.password_hash && !existingAdmin.password_hash.startsWith("scrypt$")) {
    db.prepare(`UPDATE users SET password_hash = '' WHERE id = ?`).run(existingAdmin.id);
  }
  const migrations = [
    `ALTER TABLE stream_sources ADD COLUMN category TEXT NOT NULL DEFAULT 'News'`,
    `ALTER TABLE stream_sources ADD COLUMN logo_url TEXT`,
    `ALTER TABLE stream_sources ADD COLUMN source_type TEXT NOT NULL DEFAULT 'HLS_M3U8'`,
    `ALTER TABLE stream_sources ADD COLUMN playback_status TEXT NOT NULL DEFAULT 'UNTESTED'`,
    `ALTER TABLE stream_sources ADD COLUMN recording_permission TEXT NOT NULL DEFAULT 'AUTHORIZED'`,
    `ALTER TABLE stream_sources ADD COLUMN last_tested_at TEXT`,
    `ALTER TABLE stream_sources ADD COLUMN notes TEXT`
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
    }
  }
}
function getQaThresholds() {
  const row = getDb().prepare(`SELECT value_json FROM app_settings WHERE key = 'qa_thresholds'`).get();
  if (!row) return { ...DEFAULT_QA_THRESHOLDS };
  try {
    return { ...DEFAULT_QA_THRESHOLDS, ...JSON.parse(row.value_json) };
  } catch {
    return { ...DEFAULT_QA_THRESHOLDS };
  }
}
function getCustomFieldMappings() {
  const row = getDb().prepare(`SELECT value_json FROM app_settings WHERE key = 'custom_field_mappings'`).get();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function getCustomEntryTypeMappings() {
  const row = getDb().prepare(`SELECT value_json FROM app_settings WHERE key = 'custom_entry_type_mappings'`).get();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function logAudit(params) {
  getDb().prepare(
    `INSERT INTO audit_logs (timestamp, entity_type, entity_id, action, field_name, old_value, new_value, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    (/* @__PURE__ */ new Date()).toISOString(),
    params.entityType,
    params.entityId,
    params.action,
    params.fieldName ?? null,
    params.oldValue ?? null,
    params.newValue ?? null,
    params.notes ?? null
  );
}
async function createDatabaseBackup(triggerType) {
  ensureDirectories();
  const db = getDb();
  const id = `bkp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const fileName = `broadcast_qa_${stamp}_${triggerType.toLowerCase()}.db`;
  const filePath = path.join(BACKUPS_DIR, fileName);
  await db.backup(filePath);
  const stat = fs.statSync(filePath);
  const entryCount = db.prepare(`SELECT COUNT(*) AS c FROM entries`).get().c;
  const channelCount = db.prepare(`SELECT COUNT(*) AS c FROM channels`).get().c;
  db.prepare(
    `INSERT INTO backups (id, file_name, file_path, size_bytes, trigger_type, created_at, entry_count, channel_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, fileName, filePath, stat.size, triggerType, (/* @__PURE__ */ new Date()).toISOString(), entryCount, channelCount);
  logAudit({
    entityType: "BACKUP",
    entityId: id,
    action: "BACKUP_CREATED",
    newValue: fileName,
    notes: `Trigger: ${triggerType} (${entryCount} entries, ${channelCount} channels)`
  });
  return { id, fileName, filePath, sizeBytes: stat.size };
}

// server/excelExport.ts
import ExcelJS from "exceljs";
function styleHeaderRow(sheet, columnCount) {
  const row = sheet.getRow(1);
  row.height = 24;
  row.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  row.alignment = { vertical: "middle", horizontal: "left" };
  for (let c = 1; c <= columnCount; c++) {
    const cell = row.getCell(c);
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0B1528" }
    };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FF334155" } }
    };
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columnCount }
  };
}
function applyQaCellColor(cell, status) {
  if (status === "RED") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEE2E2" } };
    cell.font = { bold: true, color: { argb: "FFB91C1C" } };
  } else if (status === "YELLOW") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
    cell.font = { bold: true, color: { argb: "FFB45309" } };
  } else if (status === "GREEN") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCFCE7" } };
    cell.font = { bold: true, color: { argb: "FF15803D" } };
  }
}
async function generateExcelReport(params) {
  const db = getDb();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TV-TASKVERIFY";
  workbook.created = /* @__PURE__ */ new Date();
  const whereEntries = ["is_deleted_record = 0"];
  const entryArgs = [];
  if (params.channelKey) {
    whereEntries.push("channel_key = ?");
    entryArgs.push(params.channelKey);
  }
  if (params.dateFrom) {
    whereEntries.push("trans_date >= ?");
    entryArgs.push(params.dateFrom);
  }
  if (params.dateTo) {
    whereEntries.push("trans_date <= ?");
    entryArgs.push(params.dateTo);
  }
  const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  if (params.reportType === "daily_summary") {
    const sheet2 = workbook.addWorksheet("Daily Channel Summary");
    sheet2.columns = [
      { header: "Channel Name", key: "channel_name", width: 24 },
      { header: "Broadcast Date", key: "trans_date", width: 15 },
      { header: "Total Entries", key: "total_entries", width: 14 },
      { header: "PROGRAM Count", key: "program_count", width: 15 },
      { header: "PROGRAM Duration (sec)", key: "program_duration_sec", width: 22 },
      { header: "SPOT/TVC Count", key: "spot_tvc_count", width: 16 },
      { header: "SPOT/TVC Duration (sec)", key: "spot_tvc_duration_sec", width: 23 },
      { header: "MEDIA Count", key: "media_count", width: 14 },
      { header: "MEDIA Duration (sec)", key: "media_duration_sec", width: 20 },
      { header: "SPONSORSHIP Count", key: "sponsorship_count", width: 19 },
      { header: "SPONSORSHIP Duration (sec)", key: "sponsorship_duration_sec", width: 25 },
      { header: "Total Duration (sec)", key: "total_duration_sec", width: 20 },
      { header: "RED Errors", key: "red_count", width: 13 },
      { header: "YELLOW Suspicious", key: "yellow_count", width: 17 },
      { header: "GREEN Clean", key: "green_count", width: 14 },
      { header: "Pending QA", key: "pending_count", width: 13 }
    ];
    const rows = db.prepare(
      `SELECT
           channel_name,
           COALESCE(trans_date, 'Unspecified') AS trans_date,
           COUNT(*) AS total_entries,
           SUM(CASE WHEN entry_type = 'PROGRAM' THEN 1 ELSE 0 END) AS program_count,
           ROUND(COALESCE(SUM(CASE WHEN entry_type = 'PROGRAM' THEN duration_seconds ELSE 0 END), 0), 2) AS program_duration_sec,
           SUM(CASE WHEN entry_type = 'SPOT/TVC' THEN 1 ELSE 0 END) AS spot_tvc_count,
           ROUND(COALESCE(SUM(CASE WHEN entry_type = 'SPOT/TVC' THEN duration_seconds ELSE 0 END), 0), 2) AS spot_tvc_duration_sec,
           SUM(CASE WHEN entry_type = 'MEDIA' THEN 1 ELSE 0 END) AS media_count,
           ROUND(COALESCE(SUM(CASE WHEN entry_type = 'MEDIA' THEN duration_seconds ELSE 0 END), 0), 2) AS media_duration_sec,
           SUM(CASE WHEN entry_type = 'SPONSORSHIP' THEN 1 ELSE 0 END) AS sponsorship_count,
           ROUND(COALESCE(SUM(CASE WHEN entry_type = 'SPONSORSHIP' THEN duration_seconds ELSE 0 END), 0), 2) AS sponsorship_duration_sec,
           ROUND(COALESCE(SUM(duration_seconds), 0), 2) AS total_duration_sec,
           SUM(CASE WHEN qa_status = 'RED' THEN 1 ELSE 0 END) AS red_count,
           SUM(CASE WHEN qa_status = 'YELLOW' THEN 1 ELSE 0 END) AS yellow_count,
           SUM(CASE WHEN qa_status = 'GREEN' THEN 1 ELSE 0 END) AS green_count,
           SUM(CASE WHEN qa_status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count
         FROM entries
         WHERE ${whereEntries.join(" AND ")}
         GROUP BY channel_name, COALESCE(trans_date, 'Unspecified')
         ORDER BY trans_date DESC, channel_name ASC`
    ).all(...entryArgs);
    for (const r of rows) {
      const added = sheet2.addRow(r);
      added.getCell("program_duration_sec").numFmt = "#,##0.00";
      added.getCell("spot_tvc_duration_sec").numFmt = "#,##0.00";
      added.getCell("media_duration_sec").numFmt = "#,##0.00";
      added.getCell("sponsorship_duration_sec").numFmt = "#,##0.00";
      added.getCell("total_duration_sec").numFmt = "#,##0.00";
      if (r.red_count > 0) applyQaCellColor(added.getCell("red_count"), "RED");
      if (r.yellow_count > 0) applyQaCellColor(added.getCell("yellow_count"), "YELLOW");
    }
    styleHeaderRow(sheet2, sheet2.columns.length);
    const buf2 = Buffer.from(await workbook.xlsx.writeBuffer());
    return { buffer: buf2, fileName: `Daily_Channel_Summary_${stamp}.xlsx` };
  }
  if (params.reportType === "qa_errors" || params.reportType === "suspicious") {
    const severity = params.reportType === "qa_errors" ? "RED" : "YELLOW";
    const sheet2 = workbook.addWorksheet(
      severity === "RED" ? "QA Confirmed Errors (RED)" : "Suspicious Entries (YELLOW)"
    );
    sheet2.columns = [
      { header: "Severity", key: "severity", width: 12 },
      { header: "Channel Name", key: "channel_name", width: 22 },
      { header: "Date", key: "trans_date", width: 13 },
      { header: "Entry ID", key: "entry_id", width: 24 },
      { header: "MasterEntryID", key: "master_entry_id", width: 16 },
      { header: "Content Category", key: "entry_type", width: 16 },
      { header: "Sub-Category / XML Category", key: "category_name", width: 22 },
      { header: "Brand Name", key: "brand_name", width: 20 },
      { header: "Caption Name", key: "caption_name", width: 26 },
      { header: "Start Time", key: "start_time", width: 14 },
      { header: "End Time", key: "end_time", width: 14 },
      { header: "Duration (s)", key: "duration_seconds", width: 13 },
      { header: "Error Type", key: "error_type", width: 28 },
      { header: "Reason for Detection", key: "reason", width: 52 },
      { header: "Confidence / Evidence", key: "confidence_level", width: 28 },
      { header: "Resolution Status", key: "resolution_status", width: 16 }
    ];
    const whereIssues = ["q.severity = ?"];
    const issueArgs = [severity];
    if (params.channelKey) {
      whereIssues.push("q.channel_key = ?");
      issueArgs.push(params.channelKey);
    }
    if (params.dateFrom) {
      whereIssues.push("q.trans_date >= ?");
      issueArgs.push(params.dateFrom);
    }
    if (params.dateTo) {
      whereIssues.push("q.trans_date <= ?");
      issueArgs.push(params.dateTo);
    }
    const issues = db.prepare(
      `SELECT q.*, COALESCE(e.entry_type, q.entry_type) AS entry_type,
                e.master_entry_id, e.category_name, e.brand_name, e.caption_name,
                e.start_time, e.end_time, e.duration_seconds
         FROM qa_issues q
         LEFT JOIN entries e ON e.id = q.entry_id
         WHERE ${whereIssues.join(" AND ")}
         ORDER BY q.channel_name ASC, COALESCE(q.trans_date, '') ASC, COALESCE(e.start_seconds, 999999) ASC`
    ).all(...issueArgs);
    for (const item of issues) {
      const row = sheet2.addRow(item);
      applyQaCellColor(row.getCell("severity"), item.severity);
      row.getCell("duration_seconds").numFmt = "0.00";
      row.getCell("reason").alignment = { wrapText: true };
    }
    styleHeaderRow(sheet2, sheet2.columns.length);
    const buf2 = Buffer.from(await workbook.xlsx.writeBuffer());
    const prefix = severity === "RED" ? "QA_Error_Report" : "Suspicious_Entries_Report";
    return { buffer: buf2, fileName: `${prefix}_${stamp}.xlsx` };
  }
  const typeFilterMap = {
    complete: null,
    spot_tvc: "SPOT/TVC",
    advertisements: "SPOT/TVC",
    programs: "PROGRAM",
    media: "MEDIA",
    promos: "MEDIA",
    sponsorship: "SPONSORSHIP",
    spns: "SPONSORSHIP"
  };
  const targetType = typeFilterMap[params.reportType];
  if (targetType) {
    whereEntries.push("entry_type = ?");
    entryArgs.push(targetType);
  }
  const sheetNames = {
    complete: "Complete Channel Data",
    spot_tvc: "SPOT-TVC Report",
    advertisements: "SPOT-TVC Report",
    programs: "PROGRAM Report",
    media: "MEDIA Report",
    promos: "MEDIA Report",
    sponsorship: "SPONSORSHIP Report",
    spns: "SPONSORSHIP Report"
  };
  const sheet = workbook.addWorksheet(sheetNames[params.reportType] ?? "Report");
  sheet.columns = [
    { header: "QA Status", key: "qa_status", width: 12 },
    { header: "Channel ID", key: "channel_id", width: 13 },
    { header: "Channel Name", key: "channel_name", width: 22 },
    { header: "Date", key: "trans_date", width: 13 },
    { header: "Content Category", key: "entry_type", width: 16 },
    { header: "MasterEntryID", key: "master_entry_id", width: 16 },
    { header: "SegmentDetailID", key: "segment_detail_id", width: 16 },
    { header: "CommercialID", key: "commercial_id", width: 15 },
    { header: "Start Time", key: "start_time", width: 14 },
    { header: "End Time", key: "end_time", width: 14 },
    { header: "Duration (s)", key: "duration_seconds", width: 13 },
    { header: "SourceDuration (s)", key: "source_duration", width: 16 },
    { header: "XML Category", key: "category_name", width: 18 },
    { header: "Subcategory", key: "subcategory_name", width: 18 },
    { header: "Brand Name", key: "brand_name", width: 20 },
    { header: "Caption Name", key: "caption_name", width: 28 },
    { header: "Company", key: "company_name", width: 20 },
    { header: "Video File", key: "video_file_name", width: 24 },
    { header: "MatchCoverage", key: "match_coverage", width: 14 },
    { header: "Manually Edited", key: "edited_label", width: 15 },
    { header: "Source Role", key: "source_role", width: 16 }
  ];
  const entries = db.prepare(
    `SELECT * FROM entries
       WHERE ${whereEntries.join(" AND ")}
       ORDER BY channel_name ASC, COALESCE(trans_date, '') ASC, COALESCE(start_seconds, 999999) ASC`
  ).all(...entryArgs);
  for (const e of entries) {
    const row = sheet.addRow({
      ...e,
      edited_label: e.is_manually_edited ? "Yes" : "No"
    });
    applyQaCellColor(row.getCell("qa_status"), e.qa_status);
    row.getCell("duration_seconds").numFmt = "0.00";
    row.getCell("source_duration").numFmt = "0.00";
  }
  styleHeaderRow(sheet, sheet.columns.length);
  const buf = Buffer.from(await workbook.xlsx.writeBuffer());
  const fileLabel = (sheetNames[params.reportType] ?? "Report").replace(/[\s/]+/g, "_");
  return { buffer: buf, fileName: `${fileLabel}_${stamp}.xlsx` };
}

// server/importService.ts
import crypto3 from "node:crypto";
import fs2 from "node:fs";
import path2 from "node:path";

// server/xmlParser.ts
import crypto2 from "node:crypto";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
var CANONICAL_FIELD_ALIASES = {
  MasterEntryID: ["masterentryid", "master_entry_id", "masterid", "entryid", "entry_id", "scheduleid", "schedule_id", "trscheduleid"],
  segmentDetailID: ["segmentdetailid", "segment_detail_id", "segmentid", "detailid"],
  startIndex: ["startindex", "start_index"],
  endIndex: ["endindex", "end_index"],
  DiffInIndex: ["diffinindex", "diff_in_index", "indexdiff"],
  startTime: ["starttime", "start_time", "startdt", "airstarttime", "begin_time", "progstarttime"],
  endTime: ["endtime", "end_time", "enddt", "airendtime", "progendtime"],
  Duration: ["duration", "dur", "durationseconds", "duration_sec", "length"],
  channelID: ["channelid", "channel_id", "ch_id", "chid"],
  channelName: ["channelname", "channel_name", "ch_name", "chname", "channel"],
  transDate: ["transdate", "trans_date", "broadcastdate", "airdate", "date", "txdate"],
  captionID: ["captionid", "caption_id", "programid", "program_id"],
  captionName: [
    "captionname",
    "caption_name",
    "caption",
    "title",
    "programname",
    "program_name",
    "program_title",
    "programtitle",
    "progname",
    "prog_name",
    "program",
    "showname",
    "show_name",
    "episodename"
  ],
  brandName: ["brandname", "brand_name", "brand"],
  FilePath: ["filepath", "file_path", "path"],
  EntryType: [
    "entrytype",
    "entry_type",
    "recordtype",
    "itemtype",
    "type",
    "mediatype",
    "media_type",
    "contenttype",
    "content_type",
    "scheduletype",
    "schedule_type"
  ],
  videoClipID: ["videoclipid", "video_clip_id", "clipid"],
  startFrame: ["startframe", "start_frame"],
  endFrame: ["endframe", "end_frame"],
  txt: ["txt", "text", "captiontext", "subtitle", "notes", "remarks"],
  startTime_tts: ["starttime_tts", "starttimetts"],
  endTime_tts: ["endtime_tts", "endtimetts"],
  categoryName: ["categoryname", "category_name", "category", "genre"],
  subcategoryName: ["subcategoryname", "subcategory_name", "subcategory", "subgenre"],
  categoryID: ["categoryid", "category_id"],
  subcategoryID: ["subcategoryid", "subcategory_id"],
  brandID: ["brandid", "brand_id"],
  commercialTypeID: ["commercialtypeid", "commercial_type_id"],
  Action: ["action", "operation", "statusaction"],
  commercialID: ["commercialid", "commercial_id", "commid", "adid"],
  videoFileName: ["videofilename", "video_file_name", "filename", "clipfilename"],
  leftAdjust: ["leftadjust", "left_adjust"],
  rightAdjust: ["rightadjust", "right_adjust"],
  qualityID: ["qualityid", "quality_id", "quality"],
  matchValue: ["matchvalue", "match_value"],
  fdb: ["fdb"],
  isBenchMarked: ["isbenchmarked", "is_benchmarked", "benchmarked"],
  companyName: ["companyname", "company_name", "clientname", "advertiser"],
  customDuration: ["customduration", "custom_duration"],
  commercialTypeName: ["commercialtypename", "commercial_type_name", "commtype"],
  MatchCoverage: ["matchcoverage", "match_coverage", "coverage"],
  SourceDuration: ["sourceduration", "source_duration", "refduration"]
};
var ALIAS_TO_CANONICAL = /* @__PURE__ */ new Map();
for (const [canonical, aliases] of Object.entries(CANONICAL_FIELD_ALIASES)) {
  ALIAS_TO_CANONICAL.set(canonical.toLowerCase(), canonical);
  for (const alias of aliases) {
    ALIAS_TO_CANONICAL.set(alias.toLowerCase(), canonical);
  }
}
function decodeBufferToText(buffer) {
  if (buffer.length >= 2) {
    if (buffer[0] === 255 && buffer[1] === 254) {
      return buffer.subarray(2).toString("utf16le");
    }
    if (buffer[0] === 254 && buffer[1] === 255) {
      const swapped = Buffer.allocUnsafe(buffer.length - 2);
      for (let i = 2; i + 1 < buffer.length; i += 2) {
        swapped[i - 2] = buffer[i + 1];
        swapped[i - 1] = buffer[i];
      }
      return swapped.toString("utf16le");
    }
  }
  if (buffer.length >= 3 && buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191) {
    return buffer.subarray(3).toString("utf8");
  }
  const sampleLen = Math.min(buffer.length, 200);
  let zeroOdd = 0;
  for (let i = 1; i < sampleLen; i += 2) {
    if (buffer[i] === 0) zeroOdd++;
  }
  if (sampleLen >= 20 && zeroOdd > sampleLen / 4) {
    return buffer.toString("utf16le");
  }
  return buffer.toString("utf8");
}
function isProbablyXmlText(text) {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<");
}
function stripNs(tag) {
  const idx = tag.indexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}
function extractSchemaFields(schemaNode) {
  const fields = [];
  const seen = /* @__PURE__ */ new Set();
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node;
    const attrName = typeof obj["@_name"] === "string" ? obj["@_name"] : null;
    const attrType = typeof obj["@_type"] === "string" ? obj["@_type"] : null;
    if (attrName && attrType && !seen.has(attrName)) {
      seen.add(attrName);
      fields.push({ name: attrName, type: stripNs(attrType) });
    } else if (attrName && !obj["xs:complexType"] && !obj["xsd:complexType"] && !obj["complexType"]) {
      const simple = obj["xs:simpleType"] ?? obj["xsd:simpleType"] ?? obj["simpleType"];
      const restriction = simple ? simple["xs:restriction"] ?? simple["xsd:restriction"] ?? simple["restriction"] : void 0;
      const baseType = restriction && typeof restriction["@_base"] === "string" ? stripNs(restriction["@_base"]) : "string";
      if (!seen.has(attrName) && attrName !== "NewDataSet") {
        seen.add(attrName);
        fields.push({ name: attrName, type: baseType });
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (!k.startsWith("@_")) walk(v);
    }
  }
  walk(schemaNode);
  return fields;
}
function isPlainRecordObject(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  const keys = Object.keys(val).filter((k) => !k.startsWith("@_") && k !== "#text");
  if (keys.length === 0) return false;
  let scalarOrKnownCount = 0;
  let nestedArrayCount = 0;
  let nestedObjectCount = 0;
  for (const k of keys) {
    const child = val[k];
    if (Array.isArray(child)) {
      nestedArrayCount++;
      continue;
    }
    if (child && typeof child === "object") {
      const childKeys = Object.keys(child).filter((ck) => !ck.startsWith("@_"));
      if (childKeys.length > 0 && !("#text" in child)) {
        nestedObjectCount++;
      } else {
        scalarOrKnownCount++;
      }
    } else {
      scalarOrKnownCount++;
    }
  }
  if (nestedArrayCount > 0) return false;
  return nestedObjectCount === 0 || scalarOrKnownCount >= 2;
}
function extractRecordsFromNode(node) {
  if (!node || typeof node !== "object") {
    return { recordElement: null, rawObjects: [] };
  }
  const obj = node;
  const entries = Object.entries(obj).filter(
    ([k]) => !k.startsWith("@_") && k !== "?xml" && !k.endsWith(":schema") && k !== "schema"
  );
  for (const [k, v] of entries) {
    if (stripNs(k).toLowerCase() === "diffgram" && v && typeof v === "object") {
      const inner = extractRecordsFromNode(v);
      if (inner.rawObjects.length > 0) return inner;
    }
  }
  const collected = [];
  let detectedElement = null;
  for (const [k, v] of entries) {
    if (Array.isArray(v)) {
      const objs = v.filter((item) => Boolean(item && typeof item === "object"));
      if (objs.length > 0) {
        if (!detectedElement) detectedElement = k;
        for (const o of objs) {
          if (isPlainRecordObject(o)) {
            collected.push(o);
          } else {
            const nested = extractRecordsFromNode(o);
            if (nested.rawObjects.length > 0) {
              if (!detectedElement && nested.recordElement) detectedElement = nested.recordElement;
              collected.push(...nested.rawObjects);
            } else {
              collected.push(o);
            }
          }
        }
      }
    } else if (v && typeof v === "object") {
      if (isPlainRecordObject(v)) {
        if (!detectedElement) detectedElement = k;
        collected.push(v);
      } else {
        const nested = extractRecordsFromNode(v);
        if (nested.rawObjects.length > 0) {
          if (!detectedElement && nested.recordElement) detectedElement = nested.recordElement;
          collected.push(...nested.rawObjects);
        }
      }
    }
  }
  return { recordElement: detectedElement, rawObjects: collected };
}
function flattenScalarValue(val) {
  if (val === null || val === void 0) return "";
  if (typeof val === "string") return val.trim();
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "object") {
    const rec = val;
    if ("#text" in rec && rec["#text"] !== void 0) {
      return String(rec["#text"]).trim();
    }
    if (Object.keys(rec).every((k) => k.startsWith("@_"))) {
      return "";
    }
    return JSON.stringify(rec);
  }
  return String(val).trim();
}
function detectFileRole(fileName, rootElement, recordElement, mappedCanonicalKeys, hasRecords, isPureSchema) {
  if (isPureSchema) return "schema_only";
  const name = fileName.toLowerCase();
  const root = (rootElement ?? "").toLowerCase();
  const rec = (recordElement ?? "").toLowerCase();
  if (name.includes("metadata") || root.includes("metadata")) return "metadata";
  if (name.includes("selectedchannel") || rec.includes("selectedchannel")) return "selectedchannels";
  if (name.includes("reviewed_caption") || name.includes("reviewedcaption")) return "reviewed_captions";
  if (name.includes("trschedule_deleted") || name.includes("schedule_deleted") || name.includes("deleted")) {
    return "trschedule_deleted";
  }
  if (name.includes("trcommercial")) return "trcommercial";
  if (name.includes("tcommercial")) return "tcommercial";
  if (name.includes("trschedule") || name.includes("schedule")) return "trschedule";
  if (!hasRecords) return "unknown";
  const hasTiming = mappedCanonicalKeys.has("startTime") || mappedCanonicalKeys.has("endTime") || mappedCanonicalKeys.has("transDate");
  const hasChannel = mappedCanonicalKeys.has("channelID") || mappedCanonicalKeys.has("channelName");
  const hasCommercial = mappedCanonicalKeys.has("commercialID") || mappedCanonicalKeys.has("brandName");
  if (hasChannel && !hasTiming && !hasCommercial) return "selectedchannels";
  if (hasCommercial && !hasTiming) return "tcommercial";
  if (hasTiming && hasCommercial && !mappedCanonicalKeys.has("EntryType")) return "trcommercial";
  if (hasTiming && hasChannel) return "trschedule";
  return "unknown";
}
function normalizeTransDate(rawDate, rawStartTime) {
  const raw = rawDate?.trim() || null;
  const months = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12"
  };
  const tryExtract = (str) => {
    if (!str) return null;
    const s = str.trim();
    const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
    }
    const compactMatch = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (compactMatch) {
      return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
    }
    const dmyMon = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})/);
    if (dmyMon && months[dmyMon[2].toLowerCase()]) {
      return `${dmyMon[3]}-${months[dmyMon[2].toLowerCase()]}-${dmyMon[1].padStart(2, "0")}`;
    }
    const slashMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (slashMatch) {
      const p1 = Number(slashMatch[1]);
      const p2 = Number(slashMatch[2]);
      const year = slashMatch[3];
      if (p1 > 12) {
        return `${year}-${String(p2).padStart(2, "0")}-${String(p1).padStart(2, "0")}`;
      }
      if (p2 > 12) {
        return `${year}-${String(p1).padStart(2, "0")}-${String(p2).padStart(2, "0")}`;
      }
      return `${year}-${String(p1).padStart(2, "0")}-${String(p2).padStart(2, "0")}`;
    }
    return null;
  };
  const fromDate = tryExtract(rawDate);
  if (fromDate) return { transDate: fromDate, rawTransDate: raw };
  const fromStart = tryExtract(rawStartTime);
  if (fromStart) return { transDate: fromStart, rawTransDate: raw };
  return { transDate: null, rawTransDate: raw };
}
function parseTimeToSeconds(raw) {
  if (!raw) return { normalized: null, seconds: null };
  const s = raw.trim();
  if (!s) return { normalized: null, seconds: null };
  const timeMatch = s.match(/(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?\s*(AM|PM)?/i);
  if (timeMatch) {
    let hh = Number(timeMatch[1]);
    const mm = Number(timeMatch[2]);
    const ss = Number(timeMatch[3]);
    const frac = timeMatch[4] ? Number(`0.${timeMatch[4]}`) : 0;
    const ampm = timeMatch[5]?.toUpperCase();
    if (ampm === "PM" && hh < 12) hh += 12;
    if (ampm === "AM" && hh === 12) hh = 0;
    if (mm >= 0 && mm < 60 && ss >= 0 && ss < 60 && hh >= 0 && hh < 48) {
      const total = hh * 3600 + mm * 60 + ss + frac;
      const norm = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}${frac > 0 ? "." + String(Math.round(frac * 1e3)).padStart(3, "0") : ""}`;
      return { normalized: norm, seconds: Math.round(total * 1e3) / 1e3 };
    }
  }
  const hmMatch = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (hmMatch) {
    let hh = Number(hmMatch[1]);
    const mm = Number(hmMatch[2]);
    const ampm = hmMatch[3]?.toUpperCase();
    if (ampm === "PM" && hh < 12) hh += 12;
    if (ampm === "AM" && hh === 12) hh = 0;
    if (mm >= 0 && mm < 60 && hh >= 0 && hh < 48) {
      const total = hh * 3600 + mm * 60;
      return {
        normalized: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`,
        seconds: total
      };
    }
  }
  return { normalized: s, seconds: null };
}
function parseDurationToSeconds(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const numSec = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)?$/i);
  if (numSec) {
    const n = Number(numSec[1]);
    return Number.isFinite(n) ? n : null;
  }
  const iso = s.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso) {
    const h = iso[1] ? Number(iso[1]) : 0;
    const m = iso[2] ? Number(iso[2]) : 0;
    const sec = iso[3] ? Number(iso[3]) : 0;
    return Math.round((h * 3600 + m * 60 + sec) * 1e3) / 1e3;
  }
  const hms = s.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/);
  if (hms) {
    const frac = hms[4] ? Number(`0.${hms[4]}`) : 0;
    return Math.round((Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]) + frac) * 1e3) / 1e3;
  }
  const ms = s.match(/^(\d{1,2}):(\d{2})$/);
  if (ms) {
    return Number(ms[1]) * 60 + Number(ms[2]);
  }
  return null;
}
function isMeaningfulValue(v) {
  if (!v) return false;
  const u = v.trim().toUpperCase();
  return u !== "" && u !== "0" && u !== "-1" && u !== "NULL" && u !== "NONE" && u !== "N/A" && u !== "-";
}
function normalizeEntryType(raw) {
  if (!raw) return null;
  const u = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (!u) return null;
  if (u === "SPONSORSHIP" || u === "SPN" || u === "SPONSOR" || u === "SPNS" || u === "SPONSORSHIPS") {
    return "SPONSORSHIP";
  }
  if (u === "MEDIA" || u === "PROMO" || u === "PROMOS" || u === "PROMOTIONAL") {
    return "MEDIA";
  }
  if (u === "SPOT/TVC" || u === "SPOT / TVC" || u === "SPOT_TVC" || u === "SPOT" || u === "TVC" || u === "ADVERTISEMENT" || u === "ADVERTISEMENTS" || u === "COMMERCIAL" || u === "COMMERCIALS" || u === "AD" || u === "ADS") {
    return "SPOT/TVC";
  }
  if (u === "PROGRAM" || u === "PROGRAMS" || u === "PROGRAMME" || u === "OTHER") {
    return "PROGRAM";
  }
  return null;
}
var SPONSORSHIP_REGEX = /(?:^|[\s\-_/([.,])SPN(?:$|[\s\-_/)\].,0-9])|\bSPONSOR(?:SHIP|ED|ING|S)?\b|\bCO[-\s]?SPONSOR\b|\bTITLE\s+SPONSOR\b|\bASSOCIATE\s+SPONSOR\b|\bSPONSOR\s+BUMPER\b|\bPRESENTED\s+BY\b|\bCO[-\s]?PRESENTED\s+BY\b|\bPOWERED\s+BY\b|\bCO[-\s]?POWERED\s+BY\b|\bBROUGHT\s+TO\s+YOU\s+BY\b|\bIN\s+ASSOCIATION\s+WITH\b/i;
var MEDIA_PROMO_GLOBAL_REGEX = /\bPROMOS?\b|\bPROMOTIONAL\b|\bSELF[-\s]?PROMO\b|\bIN[-\s]?HOUSE[-\s]?PROMO\b|\bCHANNEL[-\s]?PROMO\b|\bPROGRAM(?:ME)?[-\s]?PROMO\b|\bSHOW[-\s]?PROMO\b|\bDRAMA[-\s]?PROMO\b|\bUPCOMING\s+(?:SHOW|DRAMA|PROGRAM(?:ME)?|EPISODE|SERIAL|MOVIE|FILM|EVENT|MATCH)\b|\bTEASERS?\b|\bTRAILERS?\b|\bPRECAP\b|\bPROGRAM(?:ME)?\s+ANNOUNCEMENT\b|\bSHOW\s+ANNOUNCEMENT\b|\bCHANNEL\s+ANNOUNCEMENT\b|\bNEXT\s+ON\b|\bCOMING\s+SOON\b|\bCOMING\s+UP\s+NEXT\b|\bWATCH\s+TONIGHT\b|\bTONIGHT\s+AT\b|\bCHANNEL\s+ID\b|\bSTATION\s+ID\b/i;
var MEDIA_TYPE_FIELD_REGEX = /^(?:MEDIA|PR|PRM|PROMO|PROMOS|TEASER|TRAILER|IDENT|BUMPER|STING|ANNOUNCEMENT|UPCOMING)$|\b(?:CHANNEL\s*MEDIA|SELF\s*MEDIA|IN[-\s]?HOUSE\s*MEDIA|BUMPERS?|IDENTS?|STINGS?|ANNOUNCEMENTS?|UPCOMING)\b/i;
var COMMERCIAL_EXPLICIT_TYPE_REGEX = /^(?:SPOT\/TVC|SPOT\s*\/\s*TVC|SPOT|TVC|COMMERCIAL|COMMERCIALS|ADVERTISEMENT|ADVERTISEMENTS|ADVERT|AD|ADS|ADV|COM|PAID\s*AD|BRAND\s*AD|PRODUCT\s*AD|SERVICE\s*AD|AD\s*SPOT|COMMERCIAL\s*SPOT|TV\s*COMMERCIAL)$|\b(?:SPOT\/TVC|TVC|TV\s+COMMERCIAL|COMMERCIAL\s+SPOT|COMMERCIAL\s+AD|ADVERTISEMENT|ADVERT|BRAND\s+COMMERCIAL|PRODUCT\s+AD|SERVICE\s+AD|PAID\s+AD|CLIENT\s+AD|AD\s+SPOT)\b/i;
var COMMERCIAL_CAPTION_REGEX = /\b(?:SPOT\/TVC|TVC|TV\s+COMMERCIAL|COMMERCIAL\s+SPOT|ADVERTISEMENT|BRAND\s+COMMERCIAL|PRODUCT\s+AD|SERVICE\s+AD|AD\s+SPOT)\b/i;
var PROGRAM_EXACT_TOKENS = /* @__PURE__ */ new Set([
  "P",
  "PRG",
  "PGM",
  "PROG",
  "PROGRAM",
  "PROGRAMME",
  "SHOW",
  "REGULAR",
  "TRANSMISSION",
  "EDITORIAL",
  "CONTENT",
  "TX",
  "FILLER",
  "SONG",
  "SONGS",
  "MUSIC",
  "OST"
]);
var PROGRAM_OR_SONG_TYPE_REGEX = /\b(?:NON[-\s]?COMMERCIAL|PROGRAM(?:ME)?S?|DRAMAS?|SERIALS?|SOAPS?|NEWS|BULLETIN|HEADLINES?|TALK\s*SHOWS?|INTERVIEWS?|ENTERTAINMENT(?:\s+SHOWS?)?|DOCUMENTAR(?:Y|IES)|REALITY(?:\s+SHOWS?)?|SPORTS?(?:\s+SHOW|\s+PROGRAM|\s+LIVE|\s+MATCH)?|CRICKET|FOOTBALL|MUSIC(?:\s+PROGRAM|\s+SHOW|\s+VIDEO)?|SONGS?|OST|QAWWALI|NAAT|HAMD|GHAZAL|GAZAL|CONCERT|SINGING|MOVIES?|FILMS?|TELEFILMS?|SITCOMS?|COMEDY|CARTOONS?|ANIME|KIDS\s+SHOW|MORNING\s+SHOW|CURRENT\s+AFFAIRS?|RELIGIOUS|ISLAMIC|QURAN|COOKING\s+SHOW|LIFESTYLE\s+SHOW|INFOTAINMENT|EPISODES?|DEBATE|MAGAZINE\s+SHOW|WEATHER\s+REPORT|LIVE\s+SHOW|SHOWS?)\b/i;
var SONG_OR_PROGRAM_CONTENT_REGEX = /\b(?:SONGS?|MUSIC\s+PROGRAM|MUSIC\s+SHOW|OST|QAWWALI|NAAT|HAMD|GHAZAL|DRAMA\s+SERIAL|TALK\s+SHOW|NEWS\s+BULLETIN|HEADLINES|INTERVIEW|DOCUMENTARY|REALITY\s+SHOW|MORNING\s+SHOW|EPISODE\s*\d+|EP\.?\s*\d+)\b/i;
function classifyEntryType(canonical, role, customTypeMap) {
  if (customTypeMap && customTypeMap.size > 0) {
    for (const raw of [canonical.EntryType, canonical.commercialTypeName, canonical.categoryName]) {
      if (raw) {
        const mapped = customTypeMap.get(raw.trim().toUpperCase());
        if (mapped) {
          return normalizeEntryType(mapped) ?? mapped;
        }
      }
    }
  }
  const typeFields = [
    canonical.EntryType,
    canonical.commercialTypeName,
    canonical.categoryName,
    canonical.subcategoryName
  ].filter((v) => Boolean(v && v.trim())).map((v) => v.trim().toUpperCase());
  const contentFields = [
    canonical.captionName,
    canonical.brandName,
    canonical.companyName,
    canonical.txt
  ].filter((v) => Boolean(v && v.trim())).map((v) => v.trim().toUpperCase());
  const allFields = [...typeFields, ...contentFields];
  for (const val of allFields) {
    if (SPONSORSHIP_REGEX.test(val)) {
      return "SPONSORSHIP";
    }
  }
  for (const val of typeFields) {
    if (MEDIA_PROMO_GLOBAL_REGEX.test(val) || MEDIA_TYPE_FIELD_REGEX.test(val)) {
      return "MEDIA";
    }
  }
  for (const val of contentFields) {
    if (MEDIA_PROMO_GLOBAL_REGEX.test(val)) {
      return "MEDIA";
    }
  }
  const hasNonCommercialTag = typeFields.some((v) => /\bNON[-\s]?COMMERCIAL\b/i.test(v));
  if (hasNonCommercialTag) {
    return "PROGRAM";
  }
  const primaryTypeFields = [canonical.EntryType, canonical.commercialTypeName].filter((v) => Boolean(v && v.trim())).map((v) => v.trim().toUpperCase());
  const categoryFields = [canonical.categoryName, canonical.subcategoryName].filter((v) => Boolean(v && v.trim())).map((v) => v.trim().toUpperCase());
  const isExplicitCommercialInPrimary = primaryTypeFields.some(
    (v) => COMMERCIAL_EXPLICIT_TYPE_REGEX.test(v) || /\bCOMMERCIAL\b/i.test(v)
  );
  const isStrictAdTagInPrimary = primaryTypeFields.some(
    (v) => /^(?:SPOT\/TVC|SPOT\s*\/\s*TVC|TVC|SPOT|ADVERTISEMENT|PAID\s*AD|BRAND\s*AD|PRODUCT\s*AD|SERVICE\s*AD|TV\s*COMMERCIAL)$|\b(?:SPOT\/TVC|TVC|TV\s+COMMERCIAL|ADVERTISEMENT)\b/i.test(
      v
    )
  );
  const isExplicitProgramOrSongInPrimary = primaryTypeFields.some(
    (v) => PROGRAM_EXACT_TOKENS.has(v) || PROGRAM_OR_SONG_TYPE_REGEX.test(v)
  );
  const isExplicitProgramOrSongInCategory = categoryFields.some(
    (v) => PROGRAM_EXACT_TOKENS.has(v) || PROGRAM_OR_SONG_TYPE_REGEX.test(v)
  );
  const isSongInCategoryOrPrimary = [...primaryTypeFields, ...categoryFields].some(
    (v) => /\b(?:SONGS?|MUSIC\s+PROGRAM|MUSIC\s+SHOW|OST|QAWWALI|NAAT|HAMD|GHAZAL)\b/i.test(v)
  );
  const isSongOrProgramInCaption = Boolean(
    canonical.captionName && SONG_OR_PROGRAM_CONTENT_REGEX.test(canonical.captionName.trim().toUpperCase())
  );
  if (isSongInCategoryOrPrimary && !isStrictAdTagInPrimary) {
    return "PROGRAM";
  }
  if (isExplicitProgramOrSongInPrimary) {
    return "PROGRAM";
  }
  if (isExplicitProgramOrSongInCategory && !isStrictAdTagInPrimary) {
    return "PROGRAM";
  }
  if (isExplicitCommercialInPrimary) {
    return "SPOT/TVC";
  }
  for (const val of categoryFields) {
    if (COMMERCIAL_EXPLICIT_TYPE_REGEX.test(val) || /\bCOMMERCIAL\b/i.test(val)) {
      return "SPOT/TVC";
    }
  }
  if (canonical.captionName && COMMERCIAL_CAPTION_REGEX.test(canonical.captionName.trim().toUpperCase())) {
    return "SPOT/TVC";
  }
  if (isSongOrProgramInCaption) {
    return "PROGRAM";
  }
  if (role === "trcommercial" || role === "tcommercial") {
    return "SPOT/TVC";
  }
  if (role !== "reviewed_captions" && isMeaningfulValue(canonical.commercialID)) {
    return "SPOT/TVC";
  }
  return "PROGRAM";
}
function parseAutosaveXmlBuffer(params) {
  const { buffer, fileName, relativePath, customMappings, existingFileHashes, customTypeMap } = params;
  const sha256 = crypto2.createHash("sha256").update(buffer).digest("hex");
  const alreadyImported = existingFileHashes.has(sha256);
  const customAliasMap = /* @__PURE__ */ new Map();
  for (const m of customMappings) {
    if (m.sourceTag?.trim() && m.canonicalField?.trim()) {
      customAliasMap.set(m.sourceTag.trim().toLowerCase(), m.canonicalField.trim());
    }
  }
  const text = decodeBufferToText(buffer);
  if (!isProbablyXmlText(text)) {
    return {
      inspection: {
        relativePath,
        fileName,
        fileSize: buffer.length,
        sha256,
        isXml: false,
        detectedRole: "invalid",
        hasInlineSchema: false,
        rootElement: null,
        recordElement: null,
        recordCount: 0,
        schemaFields: [],
        mappedFields: [],
        unmappedFields: [],
        parseErrors: ["File does not contain XML markup (skipped as non-XML file)."],
        alreadyImported
      },
      records: [],
      metadataEntries: []
    };
  }
  const validation = XMLValidator.validate(text);
  if (validation !== true) {
    return {
      inspection: {
        relativePath,
        fileName,
        fileSize: buffer.length,
        sha256,
        isXml: true,
        detectedRole: "invalid",
        hasInlineSchema: false,
        rootElement: null,
        recordElement: null,
        recordCount: 0,
        schemaFields: [],
        mappedFields: [],
        unmappedFields: [],
        parseErrors: [
          `Malformed XML at line ${validation.err.line}, col ${validation.err.col}: ${validation.err.msg}`
        ],
        alreadyImported
      },
      records: [],
      metadataEntries: []
    };
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: false,
    allowBooleanAttributes: true
  });
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    format: true,
    suppressEmptyNode: true
  });
  let parsed;
  try {
    parsed = parser.parse(text);
  } catch (err) {
    return {
      inspection: {
        relativePath,
        fileName,
        fileSize: buffer.length,
        sha256,
        isXml: true,
        detectedRole: "invalid",
        hasInlineSchema: false,
        rootElement: null,
        recordElement: null,
        recordCount: 0,
        schemaFields: [],
        mappedFields: [],
        unmappedFields: [],
        parseErrors: [err instanceof Error ? err.message : "XML parsing failed"],
        alreadyImported
      },
      records: [],
      metadataEntries: []
    };
  }
  const rootKeys = Object.keys(parsed).filter((k) => k !== "?xml" && !k.startsWith("@_"));
  const rootElement = rootKeys[0] ?? null;
  const rootNode = rootElement ? parsed[rootElement] : null;
  if (rootElement && stripNs(rootElement).toLowerCase() === "schema") {
    const schemaFields2 = extractSchemaFields(rootNode);
    return {
      inspection: {
        relativePath,
        fileName,
        fileSize: buffer.length,
        sha256,
        isXml: true,
        detectedRole: "schema_only",
        hasInlineSchema: true,
        rootElement,
        recordElement: null,
        recordCount: 0,
        schemaFields: schemaFields2,
        mappedFields: [],
        unmappedFields: [],
        parseErrors: [],
        alreadyImported
      },
      records: [],
      metadataEntries: []
    };
  }
  let schemaFields = [];
  let hasInlineSchema = false;
  if (rootNode && typeof rootNode === "object" && !Array.isArray(rootNode)) {
    const rootObj = rootNode;
    for (const key of Object.keys(rootObj)) {
      if (stripNs(key).toLowerCase() === "schema") {
        hasInlineSchema = true;
        schemaFields = extractSchemaFields(rootObj[key]);
      }
    }
  }
  const { recordElement, rawObjects } = extractRecordsFromNode(rootNode);
  const mappedSamples = /* @__PURE__ */ new Map();
  const unmappedSamples = /* @__PURE__ */ new Map();
  const mappedCanonicalKeys = /* @__PURE__ */ new Set();
  const records = [];
  const metadataEntries = [];
  for (const rawObj of rawObjects) {
    const canonical = {};
    const extra = {};
    for (const [rawKey, rawVal] of Object.entries(rawObj)) {
      if (rawKey.startsWith("@_diffgr:") || rawKey.startsWith("@_msdata:")) {
        continue;
      }
      const cleanTag = rawKey.startsWith("@_") ? rawKey.slice(2) : rawKey;
      const valStr = flattenScalarValue(rawVal);
      const lowerTag = cleanTag.toLowerCase();
      const mappedName = customAliasMap.get(lowerTag) ?? ALIAS_TO_CANONICAL.get(lowerTag) ?? ALIAS_TO_CANONICAL.get(lowerTag.replace(/[_-]/g, ""));
      if (mappedName) {
        if (!canonical[mappedName] && valStr !== "") {
          canonical[mappedName] = valStr;
        } else if (!(mappedName in canonical)) {
          canonical[mappedName] = valStr;
        }
        mappedCanonicalKeys.add(mappedName);
        if (!mappedSamples.has(cleanTag)) {
          mappedSamples.set(cleanTag, {
            xmlTag: cleanTag,
            canonicalField: mappedName,
            sampleValue: valStr.slice(0, 80)
          });
        }
      } else {
        if (valStr !== "") {
          extra[cleanTag] = valStr;
        }
        if (!unmappedSamples.has(cleanTag)) {
          unmappedSamples.set(cleanTag, {
            xmlTag: cleanTag,
            sampleValue: valStr.slice(0, 80)
          });
        }
      }
    }
    const rowTag = recordElement ?? "Record";
    let rawXml = "";
    try {
      rawXml = builder.build({ [rowTag]: rawObj }).trim();
    } catch {
      rawXml = JSON.stringify(rawObj, null, 2);
    }
    const { transDate, rawTransDate } = normalizeTransDate(canonical.transDate, canonical.startTime);
    const startParsed = parseTimeToSeconds(canonical.startTime);
    const endParsed = parseTimeToSeconds(canonical.endTime);
    const durationSeconds = parseDurationToSeconds(canonical.Duration);
    records.push({
      canonical,
      extra,
      rawXml,
      entryType: "PROGRAM",
      // Refined after role detection
      transDate,
      rawTransDate,
      startTimeNormalized: startParsed.normalized,
      endTimeNormalized: endParsed.normalized,
      startSeconds: startParsed.seconds,
      endSeconds: endParsed.seconds,
      durationSeconds
    });
  }
  const detectedRole = detectFileRole(
    fileName,
    rootElement,
    recordElement,
    mappedCanonicalKeys,
    records.length > 0,
    false
  );
  for (const rec of records) {
    rec.entryType = classifyEntryType(rec.canonical, detectedRole, customTypeMap);
    if (detectedRole === "metadata") {
      metadataEntries.push({ ...rec.canonical, ...rec.extra });
    }
  }
  if (detectedRole === "metadata" && records.length === 0 && rootNode && typeof rootNode === "object") {
    const flatMeta = {};
    for (const [k, v] of Object.entries(rootNode)) {
      if (!k.startsWith("@_") && stripNs(k).toLowerCase() !== "schema") {
        flatMeta[k] = flattenScalarValue(v);
      }
    }
    if (Object.keys(flatMeta).length > 0) {
      metadataEntries.push(flatMeta);
    }
  }
  return {
    inspection: {
      relativePath,
      fileName,
      fileSize: buffer.length,
      sha256,
      isXml: true,
      detectedRole,
      hasInlineSchema,
      rootElement,
      recordElement,
      recordCount: records.length,
      schemaFields,
      mappedFields: Array.from(mappedSamples.values()),
      unmappedFields: Array.from(unmappedSamples.values()),
      parseErrors: [],
      alreadyImported
    },
    records,
    metadataEntries
  };
}

// server/reclassify.ts
function buildCustomTypeMap() {
  const list = getCustomEntryTypeMappings();
  const map = /* @__PURE__ */ new Map();
  for (const item of list) {
    if (item.rawValue && item.targetType) {
      const normalized = normalizeEntryType(item.targetType);
      if (normalized) {
        map.set(item.rawValue.trim().toUpperCase(), normalized);
      }
    }
  }
  return map;
}
function reclassifyStoredEntries(options) {
  const db = getDb();
  const customTypeMap = buildCustomTypeMap();
  const where = ["is_manually_edited = 0"];
  if (options?.onlyLegacy) {
    where.push(`entry_type NOT IN ('MEDIA', 'SPONSORSHIP', 'SPOT/TVC', 'PROGRAM')`);
  }
  const rows = db.prepare(
    `SELECT id, source_role, entry_type, raw_entry_type, commercial_type_name,
              category_name, subcategory_name, commercial_id, brand_name, caption_name,
              company_name, txt
       FROM entries
       WHERE ${where.join(" AND ")}`
  ).all();
  const updateStmt = db.prepare(`UPDATE entries SET entry_type = ?, updated_at = ? WHERE id = ?`);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let updated = 0;
  const tx = db.transaction(() => {
    const legacyManualRows = db.prepare(
      `SELECT id, entry_type FROM entries
         WHERE is_manually_edited = 1
           AND entry_type NOT IN ('MEDIA', 'SPONSORSHIP', 'SPOT/TVC', 'PROGRAM')`
    ).all();
    for (const r of legacyManualRows) {
      const migrated = normalizeEntryType(r.entry_type) ?? "PROGRAM";
      if (migrated !== r.entry_type) {
        updateStmt.run(migrated, now, r.id);
        updated++;
      }
    }
    for (const r of rows) {
      const nextType = classifyEntryType(
        {
          EntryType: r.raw_entry_type,
          commercialTypeName: r.commercial_type_name,
          categoryName: r.category_name,
          subcategoryName: r.subcategory_name,
          commercialID: r.commercial_id,
          brandName: r.brand_name,
          captionName: r.caption_name,
          companyName: r.company_name,
          txt: r.txt
        },
        r.source_role,
        customTypeMap
      );
      if (nextType !== r.entry_type) {
        updateStmt.run(nextType, now, r.id);
        updated++;
      }
    }
    db.prepare(
      `UPDATE qa_issues
       SET entry_type = (
         SELECT e.entry_type FROM entries e WHERE e.id = qa_issues.entry_id
       )
       WHERE EXISTS (
         SELECT 1 FROM entries e
         WHERE e.id = qa_issues.entry_id
           AND e.entry_type != qa_issues.entry_type
       )`
    ).run();
    const rawMappings = getCustomEntryTypeMappings();
    let mappingsChanged = false;
    const normalizedMappings = rawMappings.map((m) => {
      const norm = normalizeEntryType(m.targetType);
      if (norm && norm !== m.targetType) {
        mappingsChanged = true;
        return { rawValue: m.rawValue, targetType: norm };
      }
      return m;
    }).filter((m) => normalizeEntryType(m.targetType) !== null);
    if (mappingsChanged) {
      db.prepare(
        `UPDATE app_settings SET value_json = ?, updated_at = ? WHERE key = 'custom_entry_type_mappings'`
      ).run(JSON.stringify(normalizedMappings), now);
    }
    db.prepare(
      `UPDATE entries
       SET channel_name = (
         SELECT c.channel_name FROM channels c WHERE c.id = entries.channel_key
       )
       WHERE EXISTS (
         SELECT 1 FROM channels c
         WHERE c.id = entries.channel_key
           AND c.channel_name NOT IN ('Unknown Channel', 'Unassigned Channel')
           AND (entries.channel_name LIKE 'Channel %' OR entries.channel_name IN ('Unknown Channel', 'Unassigned Channel'))
       )`
    ).run();
  });
  tx();
  if (options?.log && updated > 0) {
    logAudit({
      entityType: "ENTRY",
      entityId: "bulk_reclassify",
      action: "ENTRIES_RECLASSIFIED",
      newValue: `${updated} entries updated`
    });
  }
  return { updated, totalChecked: rows.length };
}

// server/importService.ts
function toNum(v) {
  if (!v) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}
function toInt(v) {
  if (!v) return null;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : null;
}
function deriveChannelKey(channelId, channelName) {
  const idClean = channelId?.trim();
  const nameClean = channelName?.trim();
  if (idClean) return `ch_id_${idClean.toLowerCase()}`;
  if (nameClean) return `ch_name_${nameClean.toLowerCase().replace(/\s+/g, "_")}`;
  return "ch_unknown";
}
function buildRecordFingerprint(rec, role, channelKey) {
  const c = rec.canonical;
  const keyParts = [
    role,
    channelKey,
    c.MasterEntryID ?? "",
    c.segmentDetailID ?? "",
    rec.transDate ?? c.transDate ?? "",
    c.startTime ?? "",
    c.endTime ?? "",
    c.commercialID ?? "",
    c.captionID ?? "",
    c.captionName ?? "",
    c.brandName ?? "",
    c.startIndex ?? "",
    c.endIndex ?? "",
    c.Action ?? ""
  ];
  return crypto3.createHash("sha256").update(keyParts.join("|")).digest("hex");
}
function inspectAutosaveFiles(files) {
  const db = getDb();
  const existingHashes = new Set(
    db.prepare(`SELECT DISTINCT sha256 FROM xml_archive_files`).all().map(
      (r) => r.sha256
    )
  );
  const customMappings = getCustomFieldMappings();
  const customTypeMap = buildCustomTypeMap();
  let folderName = "autosave_upload";
  if (files.length > 0 && files[0].relativePath.includes("/")) {
    folderName = files[0].relativePath.split("/")[0] || "autosave_upload";
  }
  const inspected = [];
  let totalRecords = 0;
  let schemaFiles = 0;
  let dataFiles = 0;
  let errorFiles = 0;
  let duplicateFiles = 0;
  for (const file of files) {
    const parsed = parseAutosaveXmlBuffer({
      buffer: file.buffer,
      fileName: file.originalName,
      relativePath: file.relativePath,
      customMappings,
      existingFileHashes: existingHashes,
      customTypeMap
    });
    inspected.push(parsed.inspection);
    totalRecords += parsed.inspection.recordCount;
    if (parsed.inspection.detectedRole === "schema_only") schemaFiles++;
    else if (parsed.inspection.recordCount > 0 || parsed.inspection.detectedRole === "metadata") dataFiles++;
    if (parsed.inspection.parseErrors.length > 0 && parsed.inspection.isXml) errorFiles++;
    if (parsed.inspection.alreadyImported) duplicateFiles++;
  }
  return {
    folderName,
    files: inspected,
    totalRecords,
    schemaFiles,
    dataFiles,
    errorFiles,
    duplicateFiles
  };
}
async function commitAutosaveImport(params) {
  const db = getDb();
  const thresholds = getQaThresholds();
  const existingEntryCount = db.prepare(`SELECT COUNT(*) AS c FROM entries`).get().c;
  if (thresholds.autoBackupBeforeImport && existingEntryCount > 0) {
    await createDatabaseBackup("AUTO_PRE_IMPORT");
  }
  const batchId = `imp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const batchArchiveDir = path2.join(XML_ARCHIVE_DIR, batchId);
  fs2.mkdirSync(batchArchiveDir, { recursive: true });
  const existingHashes = new Set(
    db.prepare(`SELECT DISTINCT sha256 FROM xml_archive_files`).all().map(
      (r) => r.sha256
    )
  );
  const customMappings = getCustomFieldMappings();
  const customTypeMap = buildCustomTypeMap();
  let folderName = params.folderName?.trim() || "autosave_import";
  if (!params.folderName && params.files.length > 0 && params.files[0].relativePath.includes("/")) {
    folderName = params.files[0].relativePath.split("/")[0] || folderName;
  }
  const parsedResults = params.files.map((file) => {
    const res = parseAutosaveXmlBuffer({
      buffer: file.buffer,
      fileName: file.originalName,
      relativePath: file.relativePath,
      customMappings,
      existingFileHashes: existingHashes,
      customTypeMap
    });
    return { file, res };
  });
  const combinedHash = crypto3.createHash("sha256").update(parsedResults.map((r) => r.res.inspection.sha256).sort().join(":")).digest("hex");
  const importedAt = (/* @__PURE__ */ new Date()).toISOString();
  let schemaFileCount = 0;
  let dataFileCount = 0;
  let recordsInserted = 0;
  let recordsUpdated = 0;
  let recordsSkippedDuplicate = 0;
  let errorCount = 0;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO import_batches (
         id, folder_name, imported_at, file_count, schema_file_count, data_file_count,
         records_inserted, records_updated, records_skipped_duplicate, error_count,
         content_hash, status, notes
       ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, 'processing', ?)`
    ).run(batchId, folderName, importedAt, params.files.length, combinedHash, params.notes ?? null);
    const insertArchiveStmt = db.prepare(
      `INSERT INTO xml_archive_files (
         id, batch_id, relative_path, file_name, file_size, sha256, detected_role,
         has_inline_schema, root_element, record_element, record_count,
         schema_fields_json, unmapped_fields_json, parse_errors_json, archive_path
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const upsertChannelStmt = db.prepare(
      `INSERT INTO channels (id, channel_id, channel_name, is_selected, source_file, first_seen_at, last_updated_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         channel_id = COALESCE(excluded.channel_id, channels.channel_id),
         channel_name = CASE WHEN excluded.channel_name != 'Unknown Channel' THEN excluded.channel_name ELSE channels.channel_name END,
         is_selected = MAX(channels.is_selected, excluded.is_selected),
         last_updated_at = excluded.last_updated_at`
    );
    const upsertCatalogStmt = db.prepare(
      `INSERT INTO commercial_catalog (
         id, commercial_id, caption_id, caption_name, brand_id, brand_name, company_name,
         category_id, category_name, subcategory_id, subcategory_name,
         commercial_type_id, commercial_type_name, custom_duration, source_duration,
         raw_xml, batch_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         caption_name = COALESCE(excluded.caption_name, commercial_catalog.caption_name),
         brand_name = COALESCE(excluded.brand_name, commercial_catalog.brand_name),
         source_duration = COALESCE(excluded.source_duration, commercial_catalog.source_duration),
         custom_duration = COALESCE(excluded.custom_duration, commercial_catalog.custom_duration),
         raw_xml = excluded.raw_xml,
         batch_id = excluded.batch_id`
    );
    const findEntryByFingerprint = db.prepare(
      `SELECT id, is_manually_edited, raw_xml FROM entries WHERE dedup_fingerprint = ?`
    );
    const insertEntryStmt = db.prepare(
      `INSERT INTO entries (
         id, dedup_fingerprint, batch_id, source_file_id, source_role, is_deleted_record, is_reviewed_caption,
         channel_key, channel_id, channel_name, trans_date, raw_trans_date, entry_type, raw_entry_type,
         master_entry_id, segment_detail_id, commercial_id, commercial_type_id, commercial_type_name,
         caption_id, caption_name, brand_id, brand_name, company_name,
         category_id, category_name, subcategory_id, subcategory_name,
         start_time, end_time, start_seconds, end_seconds, duration_seconds, raw_duration,
         source_duration, custom_duration, start_index, end_index, diff_in_index,
         start_frame, end_frame, start_time_tts, end_time_tts,
         video_clip_id, video_file_name, file_path, action,
         left_adjust, right_adjust, quality_id, match_value, match_coverage, fdb, is_benchmarked, txt,
         extra_fields_json, original_values_json, raw_xml, is_manually_edited, qa_status, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, 0, 'PENDING', ?
       )`
    );
    const updateEntryFromAutosaveStmt = db.prepare(
      `UPDATE entries SET
         batch_id = ?, source_file_id = ?,
         entry_type = ?,
         raw_entry_type = COALESCE(?, raw_entry_type),
         commercial_type_name = COALESCE(?, commercial_type_name),
         end_time = COALESCE(?, end_time),
         end_seconds = COALESCE(?, end_seconds),
         duration_seconds = COALESCE(?, duration_seconds),
         raw_duration = COALESCE(?, raw_duration),
         category_name = COALESCE(?, category_name),
         subcategory_name = COALESCE(?, subcategory_name),
         brand_name = COALESCE(?, brand_name),
         caption_name = COALESCE(?, caption_name),
         match_value = COALESCE(?, match_value),
         match_coverage = COALESCE(?, match_coverage),
         txt = COALESCE(?, txt),
         extra_fields_json = ?,
         raw_xml = ?,
         qa_status = 'PENDING',
         updated_at = ?
       WHERE id = ? AND is_manually_edited = 0`
    );
    for (const { file, res } of parsedResults) {
      const insp = res.inspection;
      const safeRelPath = file.relativePath.replace(/^[/.\\]+/, "").replace(/\.\./g, "_");
      const archiveFilePath = path2.join(batchArchiveDir, safeRelPath || file.originalName);
      fs2.mkdirSync(path2.dirname(archiveFilePath), { recursive: true });
      fs2.writeFileSync(archiveFilePath, file.buffer);
      const fileId = `xml_${batchId}_${Math.random().toString(36).slice(2, 8)}`;
      insertArchiveStmt.run(
        fileId,
        batchId,
        file.relativePath,
        file.originalName,
        file.buffer.length,
        insp.sha256,
        insp.detectedRole,
        insp.hasInlineSchema ? 1 : 0,
        insp.rootElement,
        insp.recordElement,
        insp.recordCount,
        JSON.stringify(insp.schemaFields),
        JSON.stringify(insp.unmappedFields),
        JSON.stringify(insp.parseErrors),
        archiveFilePath
      );
      if (insp.detectedRole === "schema_only") {
        schemaFileCount++;
        continue;
      }
      if (insp.isXml && insp.parseErrors.length > 0) {
        errorCount += insp.parseErrors.length;
        continue;
      }
      if (!insp.isXml) {
        continue;
      }
      if (insp.recordCount > 0 || insp.detectedRole === "metadata") {
        dataFileCount++;
      }
      if (insp.alreadyImported && !params.forceReprocessDuplicates) {
        recordsSkippedDuplicate += insp.recordCount;
        continue;
      }
      if (insp.detectedRole === "selectedchannels") {
        for (const rec of res.records) {
          const chId = rec.canonical.channelID || null;
          const chName = rec.canonical.channelName || (chId ? `Channel ${chId}` : "Unknown Channel");
          const chKey = deriveChannelKey(rec.canonical.channelID, chName);
          upsertChannelStmt.run(
            chKey,
            chId,
            chName,
            1,
            file.originalName,
            importedAt,
            importedAt,
            JSON.stringify({ ...rec.canonical, ...rec.extra })
          );
        }
        continue;
      }
      if (insp.detectedRole === "tcommercial") {
        for (const rec of res.records) {
          const c = rec.canonical;
          const catId = `cat_${crypto3.createHash("sha256").update(`${c.commercialID ?? ""}|${c.captionID ?? ""}|${c.brandID ?? ""}|${c.captionName ?? ""}`).digest("hex").slice(0, 20)}`;
          upsertCatalogStmt.run(
            catId,
            c.commercialID ?? null,
            c.captionID ?? null,
            c.captionName ?? null,
            c.brandID ?? null,
            c.brandName ?? null,
            c.companyName ?? null,
            c.categoryID ?? null,
            c.categoryName ?? null,
            c.subcategoryID ?? null,
            c.subcategoryName ?? null,
            c.commercialTypeID ?? null,
            c.commercialTypeName ?? null,
            toNum(c.customDuration),
            toNum(c.SourceDuration),
            rec.rawXml,
            batchId
          );
          recordsInserted++;
        }
        continue;
      }
      if (insp.detectedRole === "metadata") {
        continue;
      }
      const isDeleted = insp.detectedRole === "trschedule_deleted" ? 1 : 0;
      const isReviewed = insp.detectedRole === "reviewed_captions" ? 1 : 0;
      for (const rec of res.records) {
        const c = rec.canonical;
        const chId = c.channelID || null;
        const chName = c.channelName || (chId ? `Channel ${chId}` : "Unassigned Channel");
        const chKey = deriveChannelKey(c.channelID, chName);
        upsertChannelStmt.run(
          chKey,
          chId,
          chName,
          0,
          file.originalName,
          importedAt,
          importedAt,
          null
        );
        const fingerprint = buildRecordFingerprint(rec, insp.detectedRole, chKey);
        const existing = findEntryByFingerprint.get(fingerprint);
        if (existing) {
          if (existing.raw_xml === rec.rawXml || existing.is_manually_edited === 1) {
            recordsSkippedDuplicate++;
          } else {
            updateEntryFromAutosaveStmt.run(
              batchId,
              fileId,
              rec.entryType,
              c.EntryType ?? null,
              c.commercialTypeName ?? null,
              rec.endTimeNormalized,
              rec.endSeconds,
              rec.durationSeconds,
              c.Duration ?? null,
              c.categoryName ?? null,
              c.subcategoryName ?? null,
              c.brandName ?? null,
              c.captionName ?? null,
              toNum(c.matchValue),
              toNum(c.MatchCoverage),
              c.txt ?? null,
              Object.keys(rec.extra).length > 0 ? JSON.stringify(rec.extra) : null,
              rec.rawXml,
              importedAt,
              existing.id
            );
            recordsUpdated++;
          }
          continue;
        }
        const entryId = `ent_${fingerprint.slice(0, 20)}`;
        const originalSnapshot = {
          entryType: rec.entryType,
          categoryName: c.categoryName ?? null,
          subcategoryName: c.subcategoryName ?? null,
          brandName: c.brandName ?? null,
          captionName: c.captionName ?? null,
          startTime: rec.startTimeNormalized ?? c.startTime ?? null,
          endTime: rec.endTimeNormalized ?? c.endTime ?? null,
          durationSeconds: rec.durationSeconds,
          rawFields: c
        };
        insertEntryStmt.run(
          entryId,
          fingerprint,
          batchId,
          fileId,
          insp.detectedRole,
          isDeleted,
          isReviewed,
          chKey,
          chId,
          chName,
          rec.transDate,
          rec.rawTransDate,
          rec.entryType,
          c.EntryType ?? null,
          c.MasterEntryID ?? null,
          c.segmentDetailID ?? null,
          c.commercialID ?? null,
          c.commercialTypeID ?? null,
          c.commercialTypeName ?? null,
          c.captionID ?? null,
          c.captionName ?? null,
          c.brandID ?? null,
          c.brandName ?? null,
          c.companyName ?? null,
          c.categoryID ?? null,
          c.categoryName ?? null,
          c.subcategoryID ?? null,
          c.subcategoryName ?? null,
          rec.startTimeNormalized ?? c.startTime ?? null,
          rec.endTimeNormalized ?? c.endTime ?? null,
          rec.startSeconds,
          rec.endSeconds,
          rec.durationSeconds,
          c.Duration ?? null,
          toNum(c.SourceDuration),
          toNum(c.customDuration),
          toInt(c.startIndex),
          toInt(c.endIndex),
          toInt(c.DiffInIndex),
          toInt(c.startFrame),
          toInt(c.endFrame),
          c.startTime_tts ?? null,
          c.endTime_tts ?? null,
          c.videoClipID ?? null,
          c.videoFileName ?? null,
          c.FilePath ?? null,
          c.Action ?? null,
          toNum(c.leftAdjust),
          toNum(c.rightAdjust),
          c.qualityID ?? null,
          toNum(c.matchValue),
          toNum(c.MatchCoverage),
          c.fdb ?? null,
          c.isBenchMarked ?? null,
          c.txt ?? null,
          Object.keys(rec.extra).length > 0 ? JSON.stringify(rec.extra) : null,
          JSON.stringify(originalSnapshot),
          rec.rawXml,
          importedAt
        );
        recordsInserted++;
      }
    }
    const status = errorCount > 0 && recordsInserted === 0 ? "failed" : errorCount > 0 ? "partial" : "completed";
    db.prepare(
      `UPDATE import_batches SET
         schema_file_count = ?, data_file_count = ?, records_inserted = ?,
         records_updated = ?, records_skipped_duplicate = ?, error_count = ?, status = ?
       WHERE id = ?`
    ).run(
      schemaFileCount,
      dataFileCount,
      recordsInserted,
      recordsUpdated,
      recordsSkippedDuplicate,
      errorCount,
      status,
      batchId
    );
  });
  tx();
  logAudit({
    entityType: "IMPORT",
    entityId: batchId,
    action: "AUTOSAVE_IMPORTED",
    newValue: `${recordsInserted} inserted, ${recordsUpdated} updated, ${recordsSkippedDuplicate} skipped`,
    notes: `Folder: ${folderName} (${params.files.length} files)`
  });
  return {
    batchId,
    folderName,
    fileCount: params.files.length,
    schemaFileCount,
    dataFileCount,
    recordsInserted,
    recordsUpdated,
    recordsSkippedDuplicate,
    errorCount,
    inspectedFiles: parsedResults.map((p) => p.res.inspection)
  };
}

// server/qaEngine.ts
function effectiveDuration(entry) {
  if (entry.duration_seconds !== null && Number.isFinite(entry.duration_seconds)) {
    return entry.duration_seconds;
  }
  if (entry.start_seconds !== null && entry.end_seconds !== null) {
    let diff = entry.end_seconds - entry.start_seconds;
    if (diff < 0 && entry.start_seconds >= 20 * 3600 && entry.end_seconds <= 6 * 3600) {
      diff += 86400;
    }
    return Math.round(diff * 1e3) / 1e3;
  }
  return null;
}
function effectiveEndSeconds(entry) {
  if (entry.end_seconds === null) return null;
  if (entry.start_seconds !== null && entry.end_seconds < entry.start_seconds && entry.start_seconds >= 20 * 3600 && entry.end_seconds <= 6 * 3600) {
    return entry.end_seconds + 86400;
  }
  return entry.end_seconds;
}
function normStr(v) {
  return (v ?? "").trim().toUpperCase();
}
function runAutomaticQa(options) {
  const db = getDb();
  const thresholds = {
    ...getQaThresholds(),
    ...options?.thresholdsOverride ?? {}
  };
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const qaRunId = `qarun_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const whereClauses = ["is_deleted_record = 0"];
  const queryParams = [];
  if (options?.channelKey) {
    whereClauses.push("channel_key = ?");
    queryParams.push(options.channelKey);
  }
  if (options?.transDate) {
    whereClauses.push("trans_date = ?");
    queryParams.push(options.transDate);
  }
  const entries = db.prepare(
    `SELECT * FROM entries
       WHERE ${whereClauses.join(" AND ")}
       ORDER BY channel_key ASC, COALESCE(trans_date, '') ASC, COALESCE(start_seconds, 999999) ASC, COALESCE(start_index, 999999) ASC, id ASC`
  ).all(...queryParams);
  const deletedRecords = db.prepare(`SELECT * FROM entries WHERE is_deleted_record = 1`).all();
  const deletedByChannelDate = /* @__PURE__ */ new Map();
  for (const d of deletedRecords) {
    const key = `${d.channel_key}::${d.trans_date ?? "NODATE"}`;
    const arr = deletedByChannelDate.get(key) ?? [];
    arr.push(d);
    deletedByChannelDate.set(key, arr);
  }
  const catalogRows = db.prepare(`SELECT * FROM commercial_catalog`).all();
  const catalogByCommId = /* @__PURE__ */ new Map();
  for (const row of catalogRows) {
    if (row.commercial_id) {
      catalogByCommId.set(normStr(row.commercial_id), row);
    }
  }
  const commercialBrandMap = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (e.commercial_id && e.brand_name) {
      const cid = normStr(e.commercial_id);
      const set = commercialBrandMap.get(cid) ?? /* @__PURE__ */ new Set();
      set.add(normStr(e.brand_name));
      commercialBrandMap.set(cid, set);
    }
  }
  const groups = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const key = `${e.channel_key}::${e.trans_date ?? "NODATE"}`;
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }
  const draftIssues = [];
  for (const [groupKey, groupEntries] of groups.entries()) {
    const deletedInGroup = deletedByChannelDate.get(groupKey) ?? [];
    const siblingHasMasterId = groupEntries.some((x) => Boolean(x.master_entry_id));
    const siblingHasStartIndex = groupEntries.some((x) => x.start_index !== null);
    for (let i = 0; i < groupEntries.length; i++) {
      const curr = groupEntries[i];
      const prev = i > 0 ? groupEntries[i - 1] : null;
      const next = i + 1 < groupEntries.length ? groupEntries[i + 1] : null;
      const pushIssue = (severity, errorType, ruleCode, reason, confidenceLevel, evidence, relatedEntryId = null) => {
        draftIssues.push({
          entryId: curr.id,
          relatedEntryId,
          channelKey: curr.channel_key,
          channelName: curr.channel_name,
          transDate: curr.trans_date,
          entryType: curr.entry_type,
          severity,
          errorType,
          ruleCode,
          reason,
          confidenceLevel,
          evidence
        });
      };
      const currEffEnd = effectiveEndSeconds(curr);
      const currDur = effectiveDuration(curr);
      const catUpper = normStr(curr.category_name);
      const subCatUpper = normStr(curr.subcategory_name);
      if (curr.start_seconds === null || curr.end_seconds === null) {
        pushIssue(
          "YELLOW",
          "Missing Timeline Bounds",
          "TL_MISSING_TIMESTAMPS",
          `Entry is missing parseable startTime (${curr.start_time ?? "null"}) or endTime (${curr.end_time ?? "null"}).`,
          "MEDIUM (Missing Fields)",
          { startTime: curr.start_time, endTime: curr.end_time }
        );
      } else if (currEffEnd !== null && currEffEnd < curr.start_seconds) {
        pushIssue(
          "RED",
          "Invalid Time Range",
          "TL_INVALID_TIME_RANGE",
          `End time (${curr.end_time}) is earlier than Start time (${curr.start_time}).`,
          "HIGH (Structural)",
          { startTime: curr.start_time, endTime: curr.end_time, startSeconds: curr.start_seconds, endSeconds: curr.end_seconds }
        );
      }
      if (curr.start_seconds !== null && currEffEnd !== null && currEffEnd >= curr.start_seconds && curr.duration_seconds !== null) {
        const computedSpan = Math.round((currEffEnd - curr.start_seconds) * 1e3) / 1e3;
        const diff = Math.abs(computedSpan - curr.duration_seconds);
        if (diff > thresholds.durationToleranceStrictSeconds) {
          pushIssue(
            "RED",
            "Duration Error",
            "TL_DURATION_MISMATCH",
            `Recorded Duration (${curr.duration_seconds}s) differs from (endTime - startTime) (${computedSpan}s) by ${diff.toFixed(2)}s.`,
            "HIGH (Structural)",
            { recordedDuration: curr.duration_seconds, computedSpan, diffSeconds: diff }
          );
        } else if (diff > thresholds.durationToleranceWarnSeconds) {
          pushIssue(
            "YELLOW",
            "Duration Variance",
            "TL_DURATION_VARIANCE",
            `Recorded Duration (${curr.duration_seconds}s) differs from (endTime - startTime) (${computedSpan}s) by ${diff.toFixed(2)}s.`,
            "MEDIUM (Timing Tolerance)",
            { recordedDuration: curr.duration_seconds, computedSpan, diffSeconds: diff }
          );
        }
      }
      if (curr.start_frame !== null && curr.end_frame !== null && curr.end_frame < curr.start_frame) {
        pushIssue(
          "RED",
          "Invalid Frame Sequence",
          "TL_INVALID_FRAME_RANGE",
          `endFrame (${curr.end_frame}) is smaller than startFrame (${curr.start_frame}).`,
          "HIGH (Structural)",
          { startFrame: curr.start_frame, endFrame: curr.end_frame }
        );
      }
      if (curr.start_index !== null && curr.end_index !== null) {
        if (curr.end_index < curr.start_index) {
          pushIssue(
            "RED",
            "Invalid Index Sequence",
            "TL_INVALID_INDEX_RANGE",
            `endIndex (${curr.end_index}) is smaller than startIndex (${curr.start_index}).`,
            "HIGH (Structural)",
            { startIndex: curr.start_index, endIndex: curr.end_index }
          );
        } else if (curr.diff_in_index !== null) {
          const expectedDiff = curr.end_index - curr.start_index;
          if (Math.abs(expectedDiff - curr.diff_in_index) > 1) {
            pushIssue(
              "YELLOW",
              "Index Difference Mismatch",
              "TL_DIFF_IN_INDEX_MISMATCH",
              `DiffInIndex (${curr.diff_in_index}) does not match endIndex - startIndex (${expectedDiff}).`,
              "MEDIUM (Structural)",
              { startIndex: curr.start_index, endIndex: curr.end_index, diffInIndex: curr.diff_in_index, expectedDiff }
            );
          }
        }
      }
      if (prev && prev.start_seconds !== null && curr.start_seconds !== null) {
        const prevEffEnd = effectiveEndSeconds(prev);
        if (prevEffEnd !== null) {
          const gap = curr.start_seconds - prevEffEnd;
          if (gap < -thresholds.overlapToleranceSeconds) {
            const overlapSec = Math.abs(gap);
            const isProgOverlap = curr.entry_type === "PROGRAM" && prev.entry_type === "PROGRAM";
            pushIssue(
              "RED",
              isProgOverlap ? "Overlapping Program Entries" : "Overlapping Entries",
              isProgOverlap ? "PROG_OVERLAPPING" : "TL_OVERLAPPING_ENTRIES",
              `Entry starts at ${curr.start_time}, overlapping previous ${prev.entry_type} (${prev.caption_name || prev.brand_name || prev.id}, ended ${prev.end_time}) by ${overlapSec.toFixed(2)}s.`,
              "HIGH (Structural)",
              { overlapSeconds: overlapSec, prevEntryId: prev.id, prevEnd: prev.end_time, currStart: curr.start_time },
              prev.id
            );
          } else if (gap < -0.25) {
            pushIssue(
              "YELLOW",
              "Minor Boundary Overlap",
              "TL_MINOR_OVERLAP",
              `Entry overlaps previous entry (${prev.end_time}) by ${Math.abs(gap).toFixed(2)}s.`,
              "MEDIUM (Boundary)",
              { overlapSeconds: Math.abs(gap), prevEntryId: prev.id },
              prev.id
            );
          } else if (gap > thresholds.gapThresholdSeconds) {
            const matchingDeleted = deletedInGroup.find(
              (d) => d.start_seconds !== null && d.end_seconds !== null && d.start_seconds >= prevEffEnd - 2 && d.start_seconds <= curr.start_seconds + 2
            );
            if (matchingDeleted) {
              pushIssue(
                "RED",
                matchingDeleted.entry_type === "SPOT/TVC" ? "Confirmed Deleted / Missing SPOT/TVC Gap" : "Deleted Record Gap Detected",
                "TL_DELETED_RECORD_GAP",
                `Timeline gap of ${gap.toFixed(1)}s (${prev.end_time} -> ${curr.start_time}) matches deleted ${matchingDeleted.entry_type} record (${matchingDeleted.brand_name || matchingDeleted.caption_name || matchingDeleted.master_entry_id || matchingDeleted.id}).`,
                "HIGH (Corroborated by Deleted Autosave Record)",
                {
                  gapSeconds: gap,
                  gapStart: prev.end_time,
                  gapEnd: curr.start_time,
                  deletedRecordId: matchingDeleted.id,
                  deletedAction: matchingDeleted.action
                },
                matchingDeleted.id
              );
            } else {
              pushIssue(
                "YELLOW",
                "Suspected Timeline Gap / Missing Entry",
                "TL_SUSPECTED_GAP",
                `Unexplained ${gap.toFixed(1)}s timeline gap between previous entry ending at ${prev.end_time} and this entry starting at ${curr.start_time}. No reference schedule available to confirm drop.`,
                "LOW (Suspected Gap - No Reference Schedule)",
                { gapSeconds: gap, gapStart: prev.end_time, gapEnd: curr.start_time, prevEntryId: prev.id },
                prev.id
              );
            }
          }
        }
      }
      if (siblingHasMasterId && !curr.master_entry_id) {
        pushIssue(
          "YELLOW",
          "Missing Sequence Identifier",
          "TL_MISSING_MASTER_ID",
          `MasterEntryID is missing on this ${curr.entry_type} while sibling records on this channel include sequence IDs.`,
          "MEDIUM (Schema Completeness)",
          { siblingHasMasterId: true }
        );
      } else if (prev && siblingHasStartIndex && prev.end_index !== null && curr.start_index !== null && curr.start_index - prev.end_index > 100) {
        pushIssue(
          "YELLOW",
          "Missing Sequence Index Jump",
          "TL_INDEX_SEQUENCE_JUMP",
          `startIndex jumped from previous endIndex (${prev.end_index}) to ${curr.start_index} (delta ${curr.start_index - prev.end_index}).`,
          "LOW (Sequence Heuristic)",
          { prevEndIndex: prev.end_index, currStartIndex: curr.start_index },
          prev.id
        );
      }
      if (curr.entry_type === "SPOT/TVC") {
        if (currDur !== null) {
          if (currDur <= 0 || currDur > thresholds.maxAdDurationSeconds) {
            pushIssue(
              "RED",
              "Incorrect SPOT/TVC Duration",
              "AD_INVALID_DURATION",
              `SPOT/TVC duration (${currDur}s) is outside valid structural bounds (0s < d <= ${thresholds.maxAdDurationSeconds}s).`,
              "HIGH (Structural)",
              { duration: currDur, maxAllowed: thresholds.maxAdDurationSeconds }
            );
          } else if (currDur < thresholds.minAdDurationSeconds) {
            pushIssue(
              "YELLOW",
              "Short SPOT/TVC Duration",
              "AD_SHORT_DURATION",
              `SPOT/TVC duration (${currDur}s) is shorter than minimum threshold (${thresholds.minAdDurationSeconds}s).`,
              "MEDIUM (Duration Threshold)",
              { duration: currDur, minAllowed: thresholds.minAdDurationSeconds }
            );
          }
        }
        const refDur = curr.custom_duration ?? curr.source_duration ?? (curr.commercial_id ? catalogByCommId.get(normStr(curr.commercial_id))?.source_duration ?? null : null);
        if (refDur !== null && currDur !== null && Math.abs(currDur - refDur) > thresholds.durationToleranceStrictSeconds) {
          pushIssue(
            "YELLOW",
            "SPOT/TVC Cut / Reference Duration Mismatch",
            "AD_SOURCE_DURATION_MISMATCH",
            `Aired SPOT/TVC duration (${currDur}s) differs from commercial reference/source duration (${refDur}s) by ${Math.abs(currDur - refDur).toFixed(2)}s.`,
            "MEDIUM (Catalog Reference)",
            { airedDuration: currDur, referenceDuration: refDur }
          );
        }
        if (/\b(?:PROGRAM|DRAMA|NEWS|SERIAL|MOVIE|SONG|SONGS|PROMO|TEASER|TRAILER|SPN|SPONSOR|SPONSORSHIP)\b/i.test(
          catUpper
        )) {
          pushIssue(
            "RED",
            "Invalid SPOT/TVC Category",
            "AD_INVALID_CATEGORY",
            `SPOT/TVC entry has conflicting non-commercial category "${curr.category_name}".`,
            "HIGH (Category Conflict)",
            { categoryName: curr.category_name, subcategoryName: curr.subcategory_name }
          );
        } else if (!curr.category_name && !curr.brand_name) {
          pushIssue(
            "YELLOW",
            "Missing SPOT/TVC Metadata",
            "AD_MISSING_METADATA",
            `SPOT/TVC entry lacks both categoryName and brandName.`,
            "LOW (Incomplete Metadata)",
            { categoryName: curr.category_name, brandName: curr.brand_name }
          );
        }
        if (curr.commercial_id) {
          const cid = normStr(curr.commercial_id);
          const catalogEntry = catalogByCommId.get(cid);
          if (catalogEntry && catalogEntry.brand_name && curr.brand_name && normStr(catalogEntry.brand_name) !== normStr(curr.brand_name)) {
            pushIssue(
              "RED",
              "Inconsistent Commercial ID",
              "AD_COMMERCIAL_ID_CONFLICT",
              `commercialID "${curr.commercial_id}" maps to brand "${catalogEntry.brand_name}" in commercial catalog, but this entry lists "${curr.brand_name}".`,
              "HIGH (Catalog Cross-Check)",
              { commercialId: curr.commercial_id, catalogBrand: catalogEntry.brand_name, entryBrand: curr.brand_name }
            );
          } else {
            const brands = commercialBrandMap.get(cid);
            if (brands && brands.size > 1) {
              pushIssue(
                "RED",
                "Inconsistent Commercial ID Across Entries",
                "AD_COMMERCIAL_ID_MULTI_BRAND",
                `commercialID "${curr.commercial_id}" appears with multiple different brand names (${Array.from(brands).join(", ")}).`,
                "HIGH (Cross-Entry Conflict)",
                { commercialId: curr.commercial_id, brands: Array.from(brands) }
              );
            }
          }
        } else {
          pushIssue(
            "YELLOW",
            "Missing Commercial ID",
            "AD_MISSING_COMMERCIAL_ID",
            `SPOT/TVC entry does not specify a commercialID.`,
            "LOW (Incomplete Identifier)",
            { brandName: curr.brand_name, captionName: curr.caption_name }
          );
        }
        if (prev && prev.entry_type === "SPOT/TVC") {
          const sameComm = curr.commercial_id && prev.commercial_id && normStr(curr.commercial_id) === normStr(prev.commercial_id) || curr.caption_id && prev.caption_id && normStr(curr.caption_id) === normStr(prev.caption_id) || curr.brand_name && prev.brand_name && curr.caption_name && prev.caption_name && normStr(curr.brand_name) === normStr(prev.brand_name) && normStr(curr.caption_name) === normStr(prev.caption_name);
          if (sameComm) {
            const exactTime = curr.start_time && prev.start_time && curr.start_time === prev.start_time;
            const timeGap = curr.start_seconds !== null && prev.end_seconds !== null ? Math.abs(curr.start_seconds - prev.end_seconds) : 0;
            if (exactTime) {
              pushIssue(
                "RED",
                "Duplicate SPOT/TVC Entry",
                "AD_EXACT_DUPLICATE",
                `Exact duplicate SPOT/TVC (${curr.brand_name || curr.caption_name || curr.commercial_id}) at ${curr.start_time}.`,
                "HIGH (Exact Duplicate)",
                { prevEntryId: prev.id, commercialId: curr.commercial_id, startTime: curr.start_time },
                prev.id
              );
            } else if (timeGap <= thresholds.duplicateWindowSeconds) {
              pushIssue(
                "YELLOW",
                "Back-to-Back Duplicate SPOT/TVC",
                "AD_CONSECUTIVE_DUPLICATE",
                `Same SPOT/TVC (${curr.brand_name || curr.caption_name || curr.commercial_id}) repeats within ${timeGap.toFixed(1)}s of previous airing.`,
                "MEDIUM (Consecutive Repeat)",
                { prevEntryId: prev.id, gapSeconds: timeGap },
                prev.id
              );
            }
          }
        }
        if (prev && next && prev.entry_type === "PROGRAM" && next.entry_type === "PROGRAM" && currDur !== null && currDur < 10) {
          pushIssue(
            "YELLOW",
            "Suspicious SPOT/TVC Placement",
            "AD_ISOLATED_SHORT_PLACEMENT",
            `Very short (${currDur}s) single SPOT/TVC isolated between two PROGRAM blocks (${prev.caption_name || "Program"} -> ${next.caption_name || "Program"}).`,
            "LOW (Placement Heuristic)",
            { duration: currDur, prevEntryId: prev.id, nextEntryId: next.id }
          );
        }
        if (curr.match_coverage !== null && curr.match_coverage < thresholds.minMatchCoverage) {
          pushIssue(
            "YELLOW",
            "Low SPOT/TVC Match Coverage",
            "AD_LOW_MATCH_COVERAGE",
            `MatchCoverage (${curr.match_coverage}%) is below threshold (${thresholds.minMatchCoverage}%).`,
            "MEDIUM (Confidence Metric)",
            { matchCoverage: curr.match_coverage, threshold: thresholds.minMatchCoverage }
          );
        }
      }
      if (curr.entry_type === "PROGRAM") {
        if (/\b(?:COMMERCIAL|ADVERT|ADVERTISEMENT|TVC|SPOT\/TVC|PROMO|SPN|SPONSORSHIP)\b/i.test(catUpper) && !/\bNON[-\s]?COMMERCIAL\b/i.test(catUpper)) {
          pushIssue(
            "RED",
            "Incorrect PROGRAM Category",
            "PROG_INVALID_CATEGORY",
            `PROGRAM entry is tagged with non-program category "${curr.category_name}".`,
            "HIGH (Category Conflict)",
            { categoryName: curr.category_name, subcategoryName: curr.subcategory_name }
          );
        } else if (!curr.category_name && !subCatUpper) {
          pushIssue(
            "YELLOW",
            "Missing PROGRAM Category",
            "PROG_MISSING_CATEGORY",
            `PROGRAM entry does not specify a categoryName or subcategoryName.`,
            "LOW (Metadata Completeness)",
            { captionName: curr.caption_name }
          );
        }
        const isSongOrMusicSegment = /\b(?:SONGS?|MUSIC|OST|NAAT|QAWWALI|HAMD|GHAZAL)\b/i.test(catUpper) || /\b(?:SONGS?|MUSIC|OST|NAAT|QAWWALI|HAMD|GHAZAL)\b/i.test(subCatUpper) || /\b(?:SONGS?|OST|NAAT|QAWWALI)\b/i.test(normStr(curr.caption_name));
        if (currDur !== null) {
          if (currDur <= 0 || currDur > thresholds.maxProgramDurationSeconds) {
            pushIssue(
              "RED",
              "Invalid PROGRAM Duration",
              "PROG_INVALID_DURATION",
              `PROGRAM duration (${currDur}s) is outside valid structural bounds (0s < d <= ${thresholds.maxProgramDurationSeconds}s).`,
              "HIGH (Structural)",
              { duration: currDur, maxAllowed: thresholds.maxProgramDurationSeconds }
            );
          } else if (!isSongOrMusicSegment && currDur < thresholds.minProgramDurationSeconds) {
            pushIssue(
              "YELLOW",
              "Suspicious Short PROGRAM Duration",
              "PROG_SHORT_DURATION",
              `PROGRAM duration (${currDur}s) is shorter than minimum program threshold (${thresholds.minProgramDurationSeconds}s). Review whether this segment belongs to MEDIA or SPOT/TVC.`,
              "MEDIUM (Duration Threshold)",
              { duration: currDur, minAllowed: thresholds.minProgramDurationSeconds }
            );
          }
        }
        if (prev && prev.entry_type === "PROGRAM") {
          const sameCaption = curr.caption_name && prev.caption_name && normStr(curr.caption_name) === normStr(prev.caption_name);
          if (sameCaption && curr.start_time && prev.start_time && curr.start_time === prev.start_time) {
            pushIssue(
              "RED",
              "Duplicate PROGRAM Entry",
              "PROG_EXACT_DUPLICATE",
              `Duplicate PROGRAM entry "${curr.caption_name}" at ${curr.start_time}.`,
              "HIGH (Exact Duplicate)",
              { prevEntryId: prev.id, startTime: curr.start_time },
              prev.id
            );
          } else if (sameCaption && !isSongOrMusicSegment && currDur !== null && currDur < thresholds.minProgramDurationSeconds) {
            pushIssue(
              "YELLOW",
              "Suspicious PROGRAM Sequence",
              "PROG_SUSPICIOUS_SEQUENCE",
              `Short PROGRAM fragment "${curr.caption_name}" (${currDur}s) directly follows an identically titled program.`,
              "MEDIUM (Sequence Heuristic)",
              { prevEntryId: prev.id, duration: currDur },
              prev.id
            );
          }
        }
      }
      if (curr.entry_type === "MEDIA") {
        if (catUpper.includes("PAID AD") || catUpper === "TVC" || catUpper === "SPOT/TVC" || /\bPROGRAM\b/i.test(catUpper) && !/\bPROMO|ANNOUNCEMENT|TEASER|TRAILER\b/i.test(catUpper)) {
          pushIssue(
            "RED",
            "Wrong MEDIA Category",
            "PROMO_WRONG_CATEGORY",
            `MEDIA entry has conflicting category "${curr.category_name}".`,
            "HIGH (Category Conflict)",
            { categoryName: curr.category_name }
          );
        }
        if (currDur !== null) {
          if (currDur <= 0 || currDur > thresholds.maxPromoDurationSeconds) {
            pushIssue(
              "RED",
              "Invalid MEDIA Duration",
              "PROMO_INVALID_DURATION",
              `MEDIA duration (${currDur}s) exceeds valid bounds (0s < d <= ${thresholds.maxPromoDurationSeconds}s).`,
              "HIGH (Structural)",
              { duration: currDur, maxAllowed: thresholds.maxPromoDurationSeconds }
            );
          } else if (currDur < thresholds.minPromoDurationSeconds) {
            pushIssue(
              "YELLOW",
              "Short MEDIA Duration",
              "PROMO_SHORT_DURATION",
              `MEDIA duration (${currDur}s) is below ${thresholds.minPromoDurationSeconds}s.`,
              "MEDIUM (Duration Threshold)",
              { duration: currDur }
            );
          }
        }
        if (prev && prev.entry_type === "MEDIA") {
          const samePromo = curr.caption_name && prev.caption_name && normStr(curr.caption_name) === normStr(prev.caption_name) || curr.commercial_id && prev.commercial_id && normStr(curr.commercial_id) === normStr(prev.commercial_id);
          if (samePromo) {
            if (curr.start_time && prev.start_time && curr.start_time === prev.start_time) {
              pushIssue(
                "RED",
                "Duplicate MEDIA Record",
                "PROMO_EXACT_DUPLICATE",
                `Exact duplicate MEDIA promo "${curr.caption_name || curr.brand_name}" at ${curr.start_time}.`,
                "HIGH (Exact Duplicate)",
                { prevEntryId: prev.id },
                prev.id
              );
            } else {
              pushIssue(
                "YELLOW",
                "Consecutive Duplicate MEDIA",
                "PROMO_CONSECUTIVE_DUPLICATE",
                `MEDIA promo "${curr.caption_name || curr.brand_name}" appears back-to-back.`,
                "MEDIUM (Consecutive Repeat)",
                { prevEntryId: prev.id },
                prev.id
              );
            }
          }
        }
        if (prev && next && prev.entry_type === "PROGRAM" && next.entry_type === "PROGRAM" && prev.caption_name && next.caption_name && normStr(prev.caption_name) === normStr(next.caption_name)) {
          pushIssue(
            "YELLOW",
            "Unexpected MEDIA Placement",
            "PROMO_MID_PROGRAM_PLACEMENT",
            `MEDIA promo interrupts two segments of the same program "${prev.caption_name}" without an accompanying SPOT/TVC break.`,
            "LOW (Placement Heuristic)",
            { prevEntryId: prev.id, nextEntryId: next.id }
          );
        }
      }
      if (curr.entry_type === "SPONSORSHIP") {
        if (/\b(?:NEWS|DRAMA|MOVIE)\b/i.test(catUpper) && !/\bSPONSOR|SPN\b/i.test(catUpper)) {
          pushIssue(
            "RED",
            "Wrong SPONSORSHIP Category",
            "SPN_WRONG_CATEGORY",
            `SPONSORSHIP entry has conflicting program category "${curr.category_name}".`,
            "HIGH (Category Conflict)",
            { categoryName: curr.category_name }
          );
        }
        if (currDur !== null) {
          if (currDur <= 0 || currDur > thresholds.maxSpnDurationSeconds) {
            pushIssue(
              "RED",
              "Incorrect SPONSORSHIP Duration",
              "SPN_INVALID_DURATION",
              `SPONSORSHIP duration (${currDur}s) is outside valid bounds (0s < d <= ${thresholds.maxSpnDurationSeconds}s).`,
              "HIGH (Structural)",
              { duration: currDur, maxAllowed: thresholds.maxSpnDurationSeconds }
            );
          } else if (currDur < thresholds.minSpnDurationSeconds) {
            pushIssue(
              "YELLOW",
              "Short SPONSORSHIP Duration",
              "SPN_SHORT_DURATION",
              `SPONSORSHIP duration (${currDur}s) is shorter than ${thresholds.minSpnDurationSeconds}s.`,
              "MEDIUM (Duration Threshold)",
              { duration: currDur }
            );
          }
        }
        if (prev && prev.entry_type === "SPONSORSHIP") {
          const sameSpn = curr.brand_name && prev.brand_name && normStr(curr.brand_name) === normStr(prev.brand_name) || curr.caption_name && prev.caption_name && normStr(curr.caption_name) === normStr(prev.caption_name);
          if (sameSpn) {
            const exact = curr.start_time && prev.start_time && curr.start_time === prev.start_time;
            pushIssue(
              exact ? "RED" : "YELLOW",
              "Duplicate SPONSORSHIP",
              exact ? "SPN_EXACT_DUPLICATE" : "SPN_CONSECUTIVE_DUPLICATE",
              `Duplicate SPONSORSHIP (${curr.brand_name || curr.caption_name}) detected back-to-back.`,
              exact ? "HIGH (Exact Duplicate)" : "MEDIUM (Consecutive Repeat)",
              { prevEntryId: prev.id },
              prev.id
            );
          }
        }
        if (!curr.brand_name && !curr.commercial_id && !curr.caption_name) {
          pushIssue(
            "YELLOW",
            "Inconsistent SPONSORSHIP Record",
            "SPN_MISSING_IDENTITY",
            `SPONSORSHIP entry has no brandName, commercialID, or captionName.`,
            "MEDIUM (Incomplete Record)",
            {}
          );
        }
      }
    }
  }
  const entrySeverity = /* @__PURE__ */ new Map();
  for (const e of entries) {
    entrySeverity.set(e.id, "GREEN");
  }
  for (const issue of draftIssues) {
    const existing = entrySeverity.get(issue.entryId);
    if (issue.severity === "RED") {
      entrySeverity.set(issue.entryId, "RED");
    } else if (issue.severity === "YELLOW" && existing !== "RED") {
      entrySeverity.set(issue.entryId, "YELLOW");
    }
  }
  let redEntries = 0;
  let yellowEntries = 0;
  let greenEntries = 0;
  for (const sev of entrySeverity.values()) {
    if (sev === "RED") redEntries++;
    else if (sev === "YELLOW") yellowEntries++;
    else greenEntries++;
  }
  const completedAt = (/* @__PURE__ */ new Date()).toISOString();
  const scopeLabel = options?.channelKey ? `${options.channelKey}${options.transDate ? ` (${options.transDate})` : ""}` : "ALL_CHANNELS";
  const tx = db.transaction(() => {
    const analyzedIds = entries.map((e) => e.id);
    const deleteStmt = db.prepare(`DELETE FROM qa_issues WHERE entry_id = ?`);
    for (const id of analyzedIds) {
      deleteStmt.run(id);
    }
    db.prepare(
      `INSERT INTO qa_runs (id, started_at, completed_at, scope, total_analyzed, red_count, yellow_count, green_count, rules_config_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      qaRunId,
      startedAt,
      completedAt,
      scopeLabel,
      entries.length,
      redEntries,
      yellowEntries,
      greenEntries,
      JSON.stringify(thresholds)
    );
    const insertIssue = db.prepare(
      `INSERT INTO qa_issues (
        id, qa_run_id, entry_id, related_entry_id, channel_key, channel_name, trans_date,
        entry_type, severity, error_type, rule_code, reason, confidence_level, evidence_json,
        resolution_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`
    );
    draftIssues.forEach((issue, idx) => {
      insertIssue.run(
        `qai_${qaRunId}_${idx}`,
        qaRunId,
        issue.entryId,
        issue.relatedEntryId,
        issue.channelKey,
        issue.channelName,
        issue.transDate,
        issue.entryType,
        issue.severity,
        issue.errorType,
        issue.ruleCode,
        issue.reason,
        issue.confidenceLevel,
        JSON.stringify(issue.evidence),
        completedAt
      );
    });
    const updateEntryQa = db.prepare(`UPDATE entries SET qa_status = ? WHERE id = ?`);
    for (const [entryId, sev] of entrySeverity.entries()) {
      updateEntryQa.run(sev, entryId);
    }
  });
  tx();
  logAudit({
    entityType: "QA_RUN",
    entityId: qaRunId,
    action: "QA_SCAN_COMPLETED",
    newValue: `${entries.length} analyzed (${redEntries} RED, ${yellowEntries} YELLOW, ${greenEntries} GREEN)`,
    notes: `Scope: ${scopeLabel}`
  });
  return {
    qaRunId,
    totalAnalyzed: entries.length,
    redCount: redEntries,
    yellowCount: yellowEntries,
    greenCount: greenEntries,
    issuesCreated: draftIssues.length
  };
}

// server/mediaRouter.ts
import express from "express";
var DEFAULT_ACCESS_CODE_SHA256 = "52b7032b03051452e554bf6ca225666c2f8ee743e613f7489301c68dcb3ec6e2";
function verifyAccessCode(submittedCode) {
  const clean = submittedCode.trim();
  if (!clean) return false;
  const envCode = process.env.ACCESS_CODE?.trim();
  if (envCode) {
    return safeTimingEqualText(clean, envCode);
  }
  return verifySha256Digest(clean, DEFAULT_ACCESS_CODE_SHA256);
}
var router = express.Router();
var IS_VERCEL2 = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
var VALID_ROLES = /* @__PURE__ */ new Set(["SUPER_ADMIN", "ADMIN", "OPERATOR", "VIEWER"]);
var USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
function createSessionForUser(user) {
  const db = getDb();
  const now = /* @__PURE__ */ new Date();
  const expiresMs = now.getTime() + 7 * 24 * 3600 * 1e3;
  const expires = new Date(expiresMs);
  const token = signStatelessSessionToken({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    exp: expiresMs
  });
  db.prepare(
    `INSERT INTO auth_sessions (token, user_id, username, role, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(token, user.id, user.username, user.role, now.toISOString(), expires.toISOString());
  return token;
}
function resolveSessionUser(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice(7).trim();
  if (!token) return null;
  const db = getDb();
  const sess = db.prepare(
    `SELECT s.user_id, u.username, u.full_name, u.role, s.expires_at
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND u.is_active = 1`
  ).get(token);
  if (sess) {
    if (new Date(sess.expires_at).getTime() <= Date.now()) {
      db.prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(token);
      return null;
    }
    return {
      token,
      user: {
        id: sess.user_id,
        username: sess.username,
        fullName: sess.full_name,
        role: sess.role
      }
    };
  }
  if (IS_VERCEL2) {
    const claims = verifyStatelessSessionToken(token);
    if (claims) {
      return {
        token,
        user: {
          id: claims.id,
          username: claims.username,
          fullName: claims.fullName,
          role: claims.role
        }
      };
    }
  }
  return null;
}
function requireAuth(req, res, next) {
  const resolved = resolveSessionUser(req);
  if (!resolved) {
    res.status(401).json({ error: "Authentication required. Please sign in." });
    return;
  }
  req.authUser = resolved.user;
  req.authToken = resolved.token;
  next();
}
function requireRole(allowedRoles) {
  return (req, res, next) => {
    const resolved = resolveSessionUser(req);
    if (!resolved) {
      res.status(401).json({ error: "Authentication required. Please sign in." });
      return;
    }
    if (!allowedRoles.includes(resolved.user.role)) {
      res.status(403).json({ error: `Role "${resolved.user.role}" is not permitted for this action.` });
      return;
    }
    req.authUser = resolved.user;
    req.authToken = resolved.token;
    next();
  };
}
function getAdminSetupState() {
  const envAdminPassword = process.env.ADMIN_PASSWORD?.trim() || "";
  const adminRow = getDb().prepare(
    `SELECT id, username, full_name, role, password_hash, is_active
       FROM users
       WHERE id = 'usr_admin' OR LOWER(username) = 'admin'
       LIMIT 1`
  ).get();
  const hasSavedHash = Boolean(adminRow?.password_hash && adminRow.password_hash.startsWith("scrypt$"));
  const needsAdminSetup = !envAdminPassword && !hasSavedHash;
  return {
    adminRow,
    envAdminPassword,
    needsAdminSetup
  };
}
router.get("/api/auth/status", (_req, res) => {
  const { adminRow, envAdminPassword } = getAdminSetupState();
  res.json({
    accessCodeMode: true,
    adminUsername: adminRow?.username ?? "admin",
    adminIdReady: true,
    needsAdminSetup: false,
    envAdminConfigured: Boolean(envAdminPassword)
  });
});
router.post("/api/auth/code", (req, res) => {
  const { code } = req.body ?? {};
  if (typeof code !== "string" || !code.trim()) {
    res.status(400).json({ error: "Access code is required." });
    return;
  }
  if (!verifyAccessCode(code)) {
    res.status(401).json({ error: "Invalid access code." });
    return;
  }
  const db = getDb();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let adminRow = db.prepare(
    `SELECT id, username, full_name, role
       FROM users
       WHERE id = 'usr_admin' OR LOWER(username) = 'admin'
       LIMIT 1`
  ).get();
  if (!adminRow) {
    db.prepare(
      `INSERT INTO users (id, username, password_hash, full_name, role, is_active, created_at)
       VALUES ('usr_admin', 'admin', '', 'System Administrator', 'ADMIN', 1, ?)`
    ).run(now);
    adminRow = {
      id: "usr_admin",
      username: "admin",
      full_name: "System Administrator",
      role: "ADMIN"
    };
  } else {
    db.prepare(`UPDATE users SET is_active = 1 WHERE id = ?`).run(adminRow.id);
  }
  const sessionUser = {
    id: adminRow.id,
    username: adminRow.username,
    fullName: adminRow.full_name,
    role: adminRow.role
  };
  const token = createSessionForUser(sessionUser);
  logAudit({
    entityType: "USER",
    entityId: sessionUser.id,
    action: "ACCESS_CODE_UNLOCK",
    notes: "Workspace unlocked with station access code."
  });
  res.json({
    sessionToken: token,
    user: sessionUser
  });
});
router.post("/api/auth/admin-setup", (req, res) => {
  const { password, fullName } = req.body ?? {};
  if (typeof password !== "string" || password.length < 6 || password.length > 128) {
    res.status(400).json({ error: "Admin password must be between 6 and 128 characters." });
    return;
  }
  const { adminRow, envAdminPassword, needsAdminSetup } = getAdminSetupState();
  if (envAdminPassword || !needsAdminSetup) {
    res.status(409).json({ error: "Admin account is already configured. Please sign in." });
    return;
  }
  const db = getDb();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const hash = hashPassword(password);
  const cleanName = typeof fullName === "string" && fullName.trim() ? fullName.trim().slice(0, 80) : "System Administrator";
  let sessionUser;
  const tx = db.transaction(() => {
    const fresh = db.prepare(`SELECT id, password_hash FROM users WHERE id = 'usr_admin' OR LOWER(username) = 'admin' LIMIT 1`).get();
    if (fresh && fresh.password_hash && fresh.password_hash.startsWith("scrypt$")) {
      throw new Error("ALREADY_CLAIMED");
    }
    if (fresh) {
      db.prepare(
        `UPDATE users SET password_hash = ?, full_name = ?, role = 'ADMIN', is_active = 1 WHERE id = ?`
      ).run(hash, cleanName, fresh.id);
      sessionUser = {
        id: fresh.id,
        username: adminRow?.username ?? "admin",
        fullName: cleanName,
        role: "ADMIN"
      };
    } else {
      db.prepare(
        `INSERT INTO users (id, username, password_hash, full_name, role, is_active, created_at)
         VALUES ('usr_admin', 'admin', ?, ?, 'ADMIN', 1, ?)`
      ).run(hash, cleanName, now);
      sessionUser = {
        id: "usr_admin",
        username: "admin",
        fullName: cleanName,
        role: "ADMIN"
      };
    }
  });
  try {
    tx();
  } catch (err) {
    if (err instanceof Error && err.message === "ALREADY_CLAIMED") {
      res.status(409).json({ error: "Admin account is already configured. Please sign in." });
      return;
    }
    res.status(500).json({ error: "Failed to initialize admin account." });
    return;
  }
  const token = createSessionForUser(sessionUser);
  logAudit({
    entityType: "USER",
    entityId: sessionUser.id,
    action: "ADMIN_PASSWORD_CLAIMED",
    notes: "Initial administrator password configured and signed in."
  });
  res.status(201).json({
    sessionToken: token,
    user: sessionUser
  });
});
router.post("/api/auth/register", (req, res) => {
  const { username, password, fullName } = req.body ?? {};
  const cleanUsername = typeof username === "string" ? username.trim() : "";
  const cleanFullName = typeof fullName === "string" ? fullName.trim() : "";
  if (!USERNAME_PATTERN.test(cleanUsername)) {
    res.status(400).json({
      error: "Username must be 3-32 characters (letters, numbers, dot, underscore, hyphen)."
    });
    return;
  }
  if (cleanUsername.toLowerCase() === "admin") {
    res.status(409).json({ error: 'The "admin" username is reserved for the system administrator.' });
    return;
  }
  if (cleanFullName.length < 2 || cleanFullName.length > 80) {
    res.status(400).json({ error: "Full name must be between 2 and 80 characters." });
    return;
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 128) {
    res.status(400).json({ error: "Password must be between 6 and 128 characters." });
    return;
  }
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`).get(cleanUsername);
  if (existing) {
    res.status(409).json({ error: "This username is already taken. Please choose another." });
    return;
  }
  const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const passwordHash = hashPassword(password);
  const role = "VIEWER";
  db.prepare(
    `INSERT INTO users (id, username, password_hash, full_name, role, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(id, cleanUsername, passwordHash, cleanFullName, role, now);
  const sessionUser = {
    id,
    username: cleanUsername,
    fullName: cleanFullName,
    role
  };
  const token = createSessionForUser(sessionUser);
  logAudit({
    entityType: "USER",
    entityId: id,
    action: "USER_REGISTERED",
    notes: `New user ${cleanUsername} registered (${role})`
  });
  res.status(201).json({
    sessionToken: token,
    user: sessionUser
  });
});
router.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password) {
    res.status(400).json({ error: "Username and password required." });
    return;
  }
  const cleanUsername = username.trim();
  const db = getDb();
  const user = db.prepare(`SELECT * FROM users WHERE LOWER(username) = LOWER(?) AND is_active = 1`).get(cleanUsername);
  if (!user) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }
  const envAdminPassword = process.env.ADMIN_PASSWORD?.trim() || "";
  const isAdminAccount = user.id === "usr_admin" || user.username.toLowerCase() === "admin";
  let authenticated = false;
  if (isAdminAccount && envAdminPassword) {
    authenticated = safeTimingEqualText(password, envAdminPassword);
  } else {
    if (isAdminAccount && (!user.password_hash || !user.password_hash.startsWith("scrypt$"))) {
      res.status(403).json({
        error: "Admin password is not configured yet. Please complete First-Time Admin Setup.",
        needsAdminSetup: true
      });
      return;
    }
    authenticated = verifyPassword(password, user.password_hash);
  }
  if (!authenticated) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }
  const sessionUser = {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role
  };
  const token = createSessionForUser(sessionUser);
  logAudit({
    entityType: "USER",
    entityId: user.id,
    action: "USER_LOGIN",
    notes: `User ${user.username} (${user.role}) logged in successfully`
  });
  res.json({
    sessionToken: token,
    user: sessionUser
  });
});
router.post("/api/auth/logout", (req, res) => {
  const resolved = resolveSessionUser(req);
  if (resolved) {
    getDb().prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(resolved.token);
    logAudit({
      entityType: "USER",
      entityId: resolved.user.id,
      action: "USER_LOGOUT",
      notes: `User ${resolved.user.username} signed out`
    });
  }
  res.json({ ok: true });
});
router.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.authUser });
});
router.get("/api/users", requireRole(["ADMIN", "SUPER_ADMIN"]), (_req, res) => {
  const users = getDb().prepare(`SELECT id, username, full_name, role, is_active, created_at FROM users ORDER BY username ASC`).all();
  res.json(users);
});
router.post("/api/users", requireRole(["ADMIN", "SUPER_ADMIN"]), (req, res) => {
  const { username, password, fullName, role } = req.body ?? {};
  const cleanUsername = typeof username === "string" ? username.trim() : "";
  const cleanFullName = typeof fullName === "string" ? fullName.trim() : "";
  const targetRole = typeof role === "string" && VALID_ROLES.has(role) ? role : "OPERATOR";
  if (!USERNAME_PATTERN.test(cleanUsername)) {
    res.status(400).json({
      error: "Username must be 3-32 characters (letters, numbers, dot, underscore, hyphen)."
    });
    return;
  }
  if (!cleanFullName || cleanFullName.length > 80) {
    res.status(400).json({ error: "Full name is required (max 80 characters)." });
    return;
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 128) {
    res.status(400).json({ error: "Password must be between 6 and 128 characters." });
    return;
  }
  if (targetRole === "SUPER_ADMIN" && req.authUser?.role !== "SUPER_ADMIN") {
    res.status(403).json({ error: "Only a Super Admin can create another Super Admin account." });
    return;
  }
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`).get(cleanUsername);
  if (existing) {
    res.status(409).json({ error: `Username "${cleanUsername}" already exists.` });
    return;
  }
  const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const passwordHash = hashPassword(password);
  db.prepare(
    `INSERT INTO users (id, username, password_hash, full_name, role, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(id, cleanUsername, passwordHash, cleanFullName, targetRole, (/* @__PURE__ */ new Date()).toISOString());
  logAudit({
    entityType: "USER",
    entityId: id,
    action: "USER_CREATED",
    notes: `${cleanUsername} (${targetRole}) created by ${req.authUser?.username ?? "admin"}`
  });
  res.status(201).json({ ok: true, id });
});
router.patch("/api/users/:id", requireRole(["ADMIN", "SUPER_ADMIN"]), (req, res) => {
  const { role, isActive, fullName, password } = req.body ?? {};
  const db = getDb();
  const target = db.prepare(`SELECT id, username, role, is_active FROM users WHERE id = ?`).get(req.params.id);
  if (!target) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  if (req.authUser?.id === target.id && isActive === false) {
    res.status(400).json({ error: "You cannot deactivate your own active admin account." });
    return;
  }
  let nextRole = null;
  if (role !== void 0) {
    if (!VALID_ROLES.has(role)) {
      res.status(400).json({ error: "Invalid role specified." });
      return;
    }
    if (role === "SUPER_ADMIN" && req.authUser?.role !== "SUPER_ADMIN") {
      res.status(403).json({ error: "Only a Super Admin can assign the SUPER_ADMIN role." });
      return;
    }
    if (target.id === "usr_admin" && role !== "ADMIN" && role !== "SUPER_ADMIN") {
      res.status(400).json({ error: "Primary admin account must retain ADMIN privileges." });
      return;
    }
    nextRole = role;
  }
  let nextPasswordHash = null;
  if (password !== void 0 && password !== "") {
    if (typeof password !== "string" || password.length < 6 || password.length > 128) {
      res.status(400).json({ error: "New password must be between 6 and 128 characters." });
      return;
    }
    nextPasswordHash = hashPassword(password);
  }
  db.prepare(
    `UPDATE users SET
       role = COALESCE(?, role),
       is_active = COALESCE(?, is_active),
       full_name = COALESCE(?, full_name),
       password_hash = COALESCE(?, password_hash)
     WHERE id = ?`
  ).run(
    nextRole,
    isActive !== void 0 ? isActive ? 1 : 0 : null,
    typeof fullName === "string" && fullName.trim() ? fullName.trim().slice(0, 80) : null,
    nextPasswordHash,
    req.params.id
  );
  if (isActive === false) {
    db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(req.params.id);
  }
  logAudit({
    entityType: "USER",
    entityId: req.params.id,
    action: "USER_UPDATED",
    notes: `Updated user ${target.username} by ${req.authUser?.username ?? "admin"}`
  });
  res.json({ ok: true });
});
router.delete("/api/users/:id", requireRole(["ADMIN", "SUPER_ADMIN"]), (req, res) => {
  const db = getDb();
  const target = db.prepare(`SELECT id, username FROM users WHERE id = ?`).get(req.params.id);
  if (!target) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  if (target.id === "usr_admin" || target.username.toLowerCase() === "admin") {
    res.status(400).json({ error: "Primary admin ID cannot be deleted." });
    return;
  }
  if (target.id === req.authUser?.id) {
    res.status(400).json({ error: "You cannot delete your currently signed-in account." });
    return;
  }
  db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(req.params.id);
  logAudit({
    entityType: "USER",
    entityId: req.params.id,
    action: "USER_DELETED",
    notes: `Deleted user ${target.username}`
  });
  res.json({ ok: true });
});
var mediaRouter_default = router;

// server/cloudRecordingRouter.ts
import express2 from "express";
import fs5 from "node:fs";

// server/cloudStorage.ts
import fs3 from "node:fs";
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
function getRawCloudStorageConfig() {
  const row = getDb().prepare(`SELECT value_json FROM app_settings WHERE key = 'cloud_storage_config'`).get();
  let parsed = {};
  if (row) {
    try {
      parsed = JSON.parse(row.value_json);
    } catch {
      parsed = {};
    }
  }
  return {
    provider: parsed.provider || process.env.S3_PROVIDER || "cloudflare_r2",
    endpoint: parsed.endpoint || process.env.S3_ENDPOINT || "",
    region: parsed.region || process.env.S3_REGION || "auto",
    bucket: parsed.bucket || process.env.S3_BUCKET || "",
    accessKeyIdEncrypted: parsed.accessKeyIdEncrypted || "",
    secretAccessKeyEncrypted: parsed.secretAccessKeyEncrypted || "",
    publicBaseUrl: parsed.publicBaseUrl || process.env.S3_PUBLIC_BASE_URL || "",
    retentionDays: Number(parsed.retentionDays ?? process.env.STORAGE_RETENTION_DAYS ?? 30),
    storageBudgetGb: Number(parsed.storageBudgetGb ?? process.env.STORAGE_BUDGET_GB ?? 500),
    warningThresholdPct: Number(parsed.warningThresholdPct ?? process.env.STORAGE_WARNING_PCT ?? 80),
    costPerGbMonthUsd: Number(parsed.costPerGbMonthUsd ?? process.env.STORAGE_COST_PER_GB_USD ?? 0.015),
    defaultSegmentSeconds: Number(parsed.defaultSegmentSeconds ?? process.env.RECORDING_SEGMENT_SECONDS ?? 3600),
    deleteLocalAfterVerifiedUpload: Boolean(parsed.deleteLocalAfterVerifiedUpload ?? false),
    signedUrlExpirySeconds: Number(parsed.signedUrlExpirySeconds ?? 3600)
  };
}
function getEffectiveCredentials(cfg) {
  const dbAccess = decryptSecret(cfg.accessKeyIdEncrypted);
  const dbSecret = decryptSecret(cfg.secretAccessKeyEncrypted);
  if (dbAccess && dbSecret) {
    return { accessKeyId: dbAccess, secretAccessKey: dbSecret, fromEnv: false };
  }
  const envAccess = process.env.S3_ACCESS_KEY_ID || "";
  const envSecret = process.env.S3_SECRET_ACCESS_KEY || "";
  return {
    accessKeyId: envAccess,
    secretAccessKey: envSecret,
    fromEnv: Boolean(envAccess && envSecret)
  };
}
function getPublicCloudStorageConfig() {
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
    signedUrlExpirySeconds: cfg.signedUrlExpirySeconds
  };
}
function updateCloudStorageConfig(input) {
  const current = getRawCloudStorageConfig();
  const next = {
    ...current,
    provider: input.provider ?? current.provider,
    endpoint: input.endpoint !== void 0 ? input.endpoint.trim() : current.endpoint,
    region: input.region !== void 0 ? input.region.trim() || "auto" : current.region,
    bucket: input.bucket !== void 0 ? input.bucket.trim() : current.bucket,
    publicBaseUrl: input.publicBaseUrl !== void 0 ? input.publicBaseUrl.trim() : current.publicBaseUrl,
    retentionDays: input.retentionDays !== void 0 ? Math.max(1, Math.min(3650, Number(input.retentionDays))) : current.retentionDays,
    storageBudgetGb: input.storageBudgetGb !== void 0 ? Math.max(1, Number(input.storageBudgetGb)) : current.storageBudgetGb,
    warningThresholdPct: input.warningThresholdPct !== void 0 ? Math.max(10, Math.min(99, Number(input.warningThresholdPct))) : current.warningThresholdPct,
    costPerGbMonthUsd: input.costPerGbMonthUsd !== void 0 ? Math.max(0, Number(input.costPerGbMonthUsd)) : current.costPerGbMonthUsd,
    defaultSegmentSeconds: input.defaultSegmentSeconds !== void 0 ? Math.max(60, Math.min(7200, Number(input.defaultSegmentSeconds))) : current.defaultSegmentSeconds,
    deleteLocalAfterVerifiedUpload: input.deleteLocalAfterVerifiedUpload !== void 0 ? Boolean(input.deleteLocalAfterVerifiedUpload) : current.deleteLocalAfterVerifiedUpload,
    signedUrlExpirySeconds: input.signedUrlExpirySeconds !== void 0 ? Math.max(60, Math.min(86400, Number(input.signedUrlExpirySeconds))) : current.signedUrlExpirySeconds,
    accessKeyIdEncrypted: input.accessKeyId && input.accessKeyId.trim() ? encryptSecret(input.accessKeyId.trim()) : current.accessKeyIdEncrypted,
    secretAccessKeyEncrypted: input.secretAccessKey && input.secretAccessKey.trim() ? encryptSecret(input.secretAccessKey.trim()) : current.secretAccessKeyEncrypted
  };
  const now = (/* @__PURE__ */ new Date()).toISOString();
  getDb().prepare(
    `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('cloud_storage_config', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(JSON.stringify(next), now);
  logAudit({
    entityType: "STORAGE_CONFIG",
    entityId: next.provider,
    action: "CLOUD_STORAGE_CONFIG_UPDATED",
    notes: `Provider: ${next.provider}, Bucket: ${next.bucket || "(unset)"}, Budget: ${next.storageBudgetGb} GB, Retention: ${next.retentionDays}d`
  });
  return getPublicCloudStorageConfig();
}
function createS3Client() {
  const config = getRawCloudStorageConfig();
  const creds = getEffectiveCredentials(config);
  if (!config.bucket || !creds.accessKeyId || !creds.secretAccessKey) {
    return null;
  }
  const client = new S3Client({
    region: config.region || "auto",
    endpoint: config.endpoint || void 0,
    forcePathStyle: config.provider === "minio" || config.provider === "custom_s3",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey
    }
  });
  return { client, config };
}
async function testCloudStorageConnection() {
  const started = Date.now();
  const s3 = createS3Client();
  const pub = getPublicCloudStorageConfig();
  if (!s3) {
    return {
      ok: false,
      provider: pub.provider,
      bucket: pub.bucket,
      latencyMs: Date.now() - started,
      message: "Cloud object storage credentials are not configured yet. Configure S3/R2 endpoint, bucket, access key, and secret key in Storage Management or server environment variables."
    };
  }
  try {
    await s3.client.send(new HeadBucketCommand({ Bucket: s3.config.bucket }));
    return {
      ok: true,
      provider: s3.config.provider,
      bucket: s3.config.bucket,
      latencyMs: Date.now() - started,
      message: `Connected and verified bucket "${s3.config.bucket}" on ${s3.config.provider}.`
    };
  } catch (err) {
    return {
      ok: false,
      provider: s3.config.provider,
      bucket: s3.config.bucket,
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : "Bucket verification failed."
    };
  }
}
function buildArchiveObjectKey(params) {
  const safeChannel = params.channelKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const mm = String(params.month).padStart(2, "0");
  const dd = String(params.day).padStart(2, "0");
  return `recordings/${safeChannel}/${params.year}/${mm}/${dd}/${params.fileName}`;
}
async function uploadSegmentToCloud(segmentId) {
  const db = getDb();
  const seg = db.prepare(`SELECT * FROM recording_segments WHERE id = ?`).get(segmentId);
  if (!seg) return { ok: false, error: "Segment record not found." };
  if (!seg.is_complete) return { ok: false, error: "Segment is still recording and not complete." };
  if (!fs3.existsSync(seg.local_path)) {
    return { ok: false, error: `Local segment file missing: ${seg.file_name}` };
  }
  const stat = fs3.statSync(seg.local_path);
  if (stat.size <= 0) {
    return { ok: false, error: "Segment file is empty (0 bytes)." };
  }
  const s3 = createS3Client();
  const objectKey = buildArchiveObjectKey({
    channelKey: seg.channel_key,
    year: seg.year,
    month: seg.month,
    day: seg.day,
    fileName: seg.file_name
  });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (!s3) {
    const uploadId2 = `upl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    db.prepare(
      `INSERT INTO cloud_uploads (id, segment_id, channel_key, storage_provider, bucket, object_key, file_size_bytes, status, attempts, max_attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 'unconfigured', '', ?, ?, 'FAILED', 1, 5, ?, ?, ?)`
    ).run(
      uploadId2,
      seg.id,
      seg.channel_key,
      objectKey,
      stat.size,
      "Cloud object storage (S3/R2) is not configured yet. Configure credentials in Storage Management and click Retry Failed Uploads.",
      now,
      now
    );
    const archiveId = upsertVideoArchiveEntry({
      seg,
      fileSizeBytes: stat.size,
      storageProvider: "local_staging",
      bucket: null,
      objectKey: null,
      localFallbackPath: seg.local_path,
      sourceOrigin: "CLOUD_24_7"
    });
    db.prepare(`UPDATE recording_segments SET status = 'LOCAL_READY', file_size_bytes = ?, updated_at = ? WHERE id = ?`).run(
      stat.size,
      now,
      seg.id
    );
    return {
      ok: false,
      archiveId,
      error: "S3/R2 credentials not configured \u2014 segment verified locally and queued for cloud upload retry."
    };
  }
  const existingUpload = db.prepare(`SELECT * FROM cloud_uploads WHERE segment_id = ? ORDER BY created_at DESC LIMIT 1`).get(seg.id);
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
    const fileStream = fs3.createReadStream(seg.local_path);
    const putResp = await s3.client.send(
      new PutObjectCommand({
        Bucket: s3.config.bucket,
        Key: objectKey,
        Body: fileStream,
        ContentLength: stat.size,
        ContentType: "video/mp4",
        Metadata: {
          channelKey: seg.channel_key,
          recordDate: seg.record_date,
          sha256: seg.sha256 || ""
        }
      })
    );
    const headResp = await s3.client.send(
      new HeadObjectCommand({
        Bucket: s3.config.bucket,
        Key: objectKey
      })
    );
    if (headResp.ContentLength !== void 0 && headResp.ContentLength !== stat.size) {
      throw new Error(
        `Upload size verification mismatch: expected ${stat.size} bytes, remote object has ${headResp.ContentLength} bytes.`
      );
    }
    const verifiedAt = (/* @__PURE__ */ new Date()).toISOString();
    const etag = (putResp.ETag || headResp.ETag || "").replace(/"/g, "");
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
      sourceOrigin: "CLOUD_24_7"
    });
    if (s3.config.deleteLocalAfterVerifiedUpload && fs3.existsSync(seg.local_path)) {
      try {
        fs3.unlinkSync(seg.local_path);
      } catch {
      }
    }
    refreshDailyStorageStats(seg.channel_key, seg.record_date);
    return { ok: true, archiveId };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failAt = (/* @__PURE__ */ new Date()).toISOString();
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
function upsertVideoArchiveEntry(params) {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM video_archive WHERE segment_id = ?`).get(params.seg.id);
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
    (/* @__PURE__ */ new Date()).toISOString()
  );
  return archiveId;
}
async function generateTimeLimitedPlaybackUrl(archiveId) {
  const row = getDb().prepare(`SELECT * FROM video_archive WHERE id = ? AND is_verified = 1`).get(archiveId);
  if (!row) return null;
  const cfg = getRawCloudStorageConfig();
  const expirySec = cfg.signedUrlExpirySeconds || 3600;
  const expiresAtEpoch = Math.floor(Date.now() / 1e3) + expirySec;
  const expiresAtIso = new Date(expiresAtEpoch * 1e3).toISOString();
  if (row.object_key && row.bucket && row.storage_provider !== "local_staging") {
    const s3 = createS3Client();
    if (s3) {
      const cmd = new GetObjectCommand({
        Bucket: row.bucket,
        Key: row.object_key
      });
      const signed = await getSignedUrl(s3.client, cmd, { expiresIn: expirySec });
      return {
        url: signed,
        expiresAt: expiresAtIso,
        storageProvider: row.storage_provider
      };
    }
  }
  if (row.local_fallback_path && fs3.existsSync(row.local_fallback_path)) {
    const token = signPlaybackToken(row.id, expiresAtEpoch);
    return {
      url: `/api/video/stream/${encodeURIComponent(row.id)}?exp=${expiresAtEpoch}&token=${token}`,
      expiresAt: expiresAtIso,
      storageProvider: "local_staging"
    };
  }
  return null;
}
function refreshDailyStorageStats(channelKey, snapshotDate) {
  const db = getDb();
  const cfg = getRawCloudStorageConfig();
  const agg = db.prepare(
    `SELECT
         COALESCE(SUM(file_size_bytes), 0) AS total_bytes,
         COUNT(*) AS total_segments,
         COALESCE(SUM(duration_seconds), 0) / 3600.0 AS total_hours
       FROM video_archive
       WHERE channel_key = ? AND is_verified = 1`
  ).get(channelKey);
  const dayAgg = db.prepare(
    `SELECT COALESCE(SUM(file_size_bytes), 0) AS day_bytes
       FROM video_archive
       WHERE channel_key = ? AND record_date = ? AND is_verified = 1`
  ).get(channelKey, snapshotDate);
  const gb = agg.total_bytes / 1024 ** 3;
  const cost = gb * cfg.costPerGbMonthUsd;
  const now = (/* @__PURE__ */ new Date()).toISOString();
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
function getStorageAnalytics() {
  const db = getDb();
  const cfg = getPublicCloudStorageConfig();
  const totals = db.prepare(
    `SELECT
         COALESCE(SUM(file_size_bytes), 0) AS totalBytes,
         COUNT(*) AS totalSegments,
         COALESCE(SUM(duration_seconds), 0) / 3600.0 AS totalHours,
         COALESCE(SUM(CASE WHEN storage_provider != 'local_staging' THEN file_size_bytes ELSE 0 END), 0) AS cloudUploadedBytes,
         COALESCE(SUM(CASE WHEN storage_provider = 'local_staging' THEN file_size_bytes ELSE 0 END), 0) AS localStagedBytes
       FROM video_archive
       WHERE is_verified = 1`
  ).get();
  const todayStr = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const monthPrefix = todayStr.slice(0, 7);
  const dailyRow = db.prepare(
    `SELECT COALESCE(SUM(file_size_bytes), 0) AS bytes, COUNT(*) AS segments
       FROM video_archive WHERE record_date = ? AND is_verified = 1`
  ).get(todayStr);
  const monthlyRow = db.prepare(
    `SELECT COALESCE(SUM(file_size_bytes), 0) AS bytes, COUNT(*) AS segments
       FROM video_archive WHERE substr(record_date, 1, 7) = ? AND is_verified = 1`
  ).get(monthPrefix);
  const perChannel = db.prepare(
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
  ).all();
  const uploadQueueSummary = db.prepare(
    `SELECT
         SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status = 'UPLOADING' THEN 1 ELSE 0 END) AS uploading,
         SUM(CASE WHEN status = 'VERIFIED' THEN 1 ELSE 0 END) AS verified,
         SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
       FROM cloud_uploads`
  ).get();
  const totalGb = totals.totalBytes / 1024 ** 3;
  const usagePct = cfg.storageBudgetGb > 0 ? totalGb / cfg.storageBudgetGb * 100 : 0;
  const estimatedMonthlyCostUsd = totalGb * cfg.costPerGbMonthUsd;
  const warnings = [];
  if (!cfg.isConfigured) {
    warnings.push({
      level: "WARN",
      message: "Cloud object storage (Cloudflare R2 / Amazon S3) credentials are not configured yet. Configure credentials to upload recordings to cloud storage."
    });
  }
  if (usagePct >= 100) {
    warnings.push({
      level: "CRITICAL",
      message: `Storage budget exceeded (${totalGb.toFixed(2)} GB / ${cfg.storageBudgetGb} GB). Increase budget or export/archive older segments manually \u2014 recordings are never silently deleted.`
    });
  } else if (usagePct >= cfg.warningThresholdPct) {
    warnings.push({
      level: "WARN",
      message: `Storage usage is at ${usagePct.toFixed(1)}% of configured ${cfg.storageBudgetGb} GB budget (threshold ${cfg.warningThresholdPct}%).`
    });
  }
  if ((uploadQueueSummary.failed ?? 0) > 0) {
    warnings.push({
      level: "WARN",
      message: `${uploadQueueSummary.failed} recording segment upload(s) failed verification and need retry.`
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
      failed: uploadQueueSummary.failed ?? 0
    },
    warnings,
    perChannel: perChannel.map((row) => ({
      ...row,
      totalGb: row.totalBytes / 1024 ** 3,
      estimatedMonthlyCostUsd: row.totalBytes / 1024 ** 3 * cfg.costPerGbMonthUsd
    }))
  };
}

// server/recordingEngine.ts
import { execFile, spawn } from "node:child_process";
import crypto4 from "node:crypto";
import fs4 from "node:fs";
import os from "node:os";
import path3 from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var WORKER_ID = process.env.RECORDING_WORKER_ID || `worker-${os.hostname()}-${process.pid}`;
var RUNTIME_BIN_DIR = path3.join(os.tmpdir(), "broadcastqa-bin");
var RUNTIME_FFMPEG_PATH = path3.join(RUNTIME_BIN_DIR, "ffmpeg");
var RUNTIME_FFMPEG_URLS = {
  "linux-x64": "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64.gz",
  "linux-arm64": "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-arm64.gz"
};
var runtimeInstallPromise = null;
function ensureExecutable(binPath) {
  try {
    fs4.chmodSync(binPath, 493);
  } catch {
  }
  return binPath;
}
function resolveFfmpegBin() {
  const envBin = process.env.FFMPEG_PATH?.trim();
  if (envBin && fs4.existsSync(envBin)) {
    return { bin: ensureExecutable(envBin), source: "env" };
  }
  if (fs4.existsSync(RUNTIME_FFMPEG_PATH) && fs4.statSync(RUNTIME_FFMPEG_PATH).size > 1e6) {
    return { bin: ensureExecutable(RUNTIME_FFMPEG_PATH), source: "runtime" };
  }
  return { bin: "ffmpeg", source: "system" };
}
function resolveFfprobeBin() {
  const envBin = process.env.FFPROBE_PATH?.trim();
  if (envBin && fs4.existsSync(envBin)) {
    return { bin: ensureExecutable(envBin), source: "env" };
  }
  return { bin: "ffprobe", source: "system" };
}
var activeWorkers = /* @__PURE__ */ new Map();
var uploadLoopRunning = false;
function getWorkerIdentity() {
  return {
    workerId: WORKER_ID,
    hostname: os.hostname(),
    pid: process.pid,
    activeRecordingCount: activeWorkers.size,
    uptimeSeconds: Math.floor(process.uptime())
  };
}
async function checkFfmpegAvailable() {
  const candidates = [];
  const envBin = process.env.FFMPEG_PATH?.trim();
  if (envBin && fs4.existsSync(envBin)) {
    candidates.push({ bin: ensureExecutable(envBin), source: "env" });
  }
  candidates.push({ bin: "ffmpeg", source: "system" });
  if (fs4.existsSync(RUNTIME_FFMPEG_PATH) && fs4.statSync(RUNTIME_FFMPEG_PATH).size > 1e6) {
    candidates.push({ bin: ensureExecutable(RUNTIME_FFMPEG_PATH), source: "runtime" });
  }
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.bin, ["-version"], { timeout: 5e3 });
      const firstLine = stdout.split("\n")[0]?.trim() || "ffmpeg";
      return { available: true, version: firstLine, source: candidate.source };
    } catch {
    }
  }
  return { available: false, version: null, source: null };
}
async function installRuntimeFfmpeg() {
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
        error: `Automatic runtime download is only available on Linux x64/arm64 (detected ${platformKey}). Install FFmpeg via your OS package manager.`
      };
    }
    const tmpPath = `${RUNTIME_FFMPEG_PATH}.download.${Date.now()}`;
    try {
      fs4.mkdirSync(RUNTIME_BIN_DIR, { recursive: true });
      const res = await fetch(downloadUrl, { redirect: "follow" });
      if (!res.ok || !res.body) {
        throw new Error(`Download failed with HTTP ${res.status}`);
      }
      const gunzip = createGunzip();
      const out = fs4.createWriteStream(tmpPath, { mode: 493 });
      await pipeline(Readable.fromWeb(res.body), gunzip, out);
      fs4.chmodSync(tmpPath, 493);
      fs4.renameSync(tmpPath, RUNTIME_FFMPEG_PATH);
      const check = await checkFfmpegAvailable();
      if (!check.available) {
        throw new Error("Downloaded FFmpeg binary failed version verification.");
      }
      logAudit({
        entityType: "SYSTEM",
        entityId: "ffmpeg-runtime",
        action: "FFMPEG_RUNTIME_INSTALLED",
        notes: `Installed runtime FFmpeg binary (${check.version}) into ${RUNTIME_FFMPEG_PATH}`
      });
      return { ok: true, version: check.version, source: check.source };
    } catch (err) {
      try {
        if (fs4.existsSync(tmpPath)) fs4.unlinkSync(tmpPath);
      } catch {
      }
      return {
        ok: false,
        version: null,
        source: null,
        error: err instanceof Error ? err.message : "Failed to install runtime FFmpeg."
      };
    } finally {
      runtimeInstallPromise = null;
    }
  })();
  return runtimeInstallPromise;
}
function parseFfmpegStreamStderr(stderr) {
  const videoMatch = stderr.match(/Stream\s+#\d+:\d+[^:]*:\s+Video:\s+([a-zA-Z0-9_]+)[^,\n]*(?:,\s*[^,\n]+)*?,\s*(\d{2,5}x\d{2,5})/i);
  const videoCodecOnly = stderr.match(/Stream\s+#\d+:\d+[^:]*:\s+Video:\s+([a-zA-Z0-9_]+)/i);
  const audioMatch = stderr.match(/Stream\s+#\d+:\d+[^:]*:\s+Audio:\s+([a-zA-Z0-9_]+)/i);
  const durMatch = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  let durationSeconds = null;
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
    durationSeconds
  };
}
async function probeStreamUrl(rawUrl) {
  if (!rawUrl || !/^https?:\/\/|^rtsp:\/\/|^rtmp:\/\//i.test(rawUrl.trim())) {
    return {
      reachable: false,
      videoCodec: null,
      audioCodec: null,
      resolution: null,
      error: "Stream URL must begin with http://, https://, rtsp://, or rtmp://"
    };
  }
  try {
    const { bin: ffprobeBin } = resolveFfprobeBin();
    const { stdout } = await execFileAsync(
      ffprobeBin,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height",
        "-of",
        "json",
        rawUrl.trim()
      ],
      { timeout: 12e3 }
    );
    const parsed = JSON.parse(stdout || "{}");
    const streams = parsed.streams ?? [];
    const vStream = streams.find((s) => s.codec_type === "video");
    const aStream = streams.find((s) => s.codec_type === "audio");
    if (vStream || aStream) {
      return {
        reachable: true,
        videoCodec: vStream?.codec_name ?? null,
        audioCodec: aStream?.codec_name ?? null,
        resolution: vStream?.width && vStream?.height ? `${vStream.width}x${vStream.height}` : null,
        error: null
      };
    }
  } catch (probeErr) {
    if (probeErr?.code !== "ENOENT") {
    }
  }
  const { bin: ffmpegBin } = resolveFfmpegBin();
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegBin,
      [
        "-hide_banner",
        "-user_agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "-headers",
        "Referer: https://www.google.com/\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n",
        "-i",
        rawUrl.trim(),
        "-t",
        "1",
        "-f",
        "null",
        "-"
      ],
      {
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }, 12e3);
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16e3) stderr = stderr.slice(-16e3);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        reachable: false,
        videoCodec: null,
        audioCodec: null,
        resolution: null,
        error: `FFmpeg not available: ${err.message}`
      });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const parsed = parseFfmpegStreamStderr(stderr);
      if (parsed.videoCodec || parsed.audioCodec) {
        resolve({
          reachable: true,
          videoCodec: parsed.videoCodec,
          audioCodec: parsed.audioCodec,
          resolution: parsed.resolution,
          error: null
        });
      } else {
        const lastLine = stderr.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" ") || "Stream unreachable or no playable streams detected.";
        resolve({
          reachable: false,
          videoCodec: null,
          audioCodec: null,
          resolution: null,
          error: lastLine.slice(0, 320)
        });
      }
    });
  });
}
async function probeLocalFileDuration(filePath) {
  try {
    const { bin: ffprobeBin } = resolveFfprobeBin();
    const { stdout } = await execFileAsync(
      ffprobeBin,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath
      ],
      { timeout: 1e4 }
    );
    const val = Number(stdout.trim());
    if (Number.isFinite(val) && val > 0) return val;
  } catch {
  }
  try {
    const { bin: ffmpegBin } = resolveFfmpegBin();
    await execFileAsync(ffmpegBin, ["-hide_banner", "-i", filePath], { timeout: 8e3 });
    return null;
  } catch (err) {
    const stderr = String(err?.stderr || "");
    return parseFfmpegStreamStderr(stderr).durationSeconds;
  }
}
function recordErrorLog(params) {
  getDb().prepare(
    `INSERT INTO recording_errors (
         id, channel_key, channel_name, session_id, segment_id,
         severity, error_code, message, details, resolved, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    `err_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    params.channelKey ?? null,
    params.channelName ?? null,
    params.sessionId ?? null,
    params.segmentId ?? null,
    params.severity ?? "ERROR",
    params.errorCode,
    params.message,
    params.details ?? null,
    (/* @__PURE__ */ new Date()).toISOString()
  );
}
function parseSegmentFilenameDate(fileName) {
  const m = fileName.match(/seg_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.mp4$/);
  if (!m) return null;
  const [, yyyy, mm, dd, hh, mi, ss] = m;
  const d = /* @__PURE__ */ new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
async function finalizeCompletedSegments(handle, flushAll) {
  if (!fs4.existsSync(handle.stagingDir)) return;
  const files = fs4.readdirSync(handle.stagingDir).filter((f) => f.endsWith(".mp4")).sort();
  const candidates = flushAll ? files : files.slice(0, Math.max(0, files.length - 1));
  const db = getDb();
  for (const fileName of candidates) {
    if (handle.processedFiles.has(fileName)) continue;
    const fullPath = path3.join(handle.stagingDir, fileName);
    let stat;
    try {
      stat = fs4.statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.size < 1024) {
      handle.processedFiles.add(fileName);
      continue;
    }
    if (!flushAll && Date.now() - stat.mtimeMs < 1500) {
      continue;
    }
    handle.processedFiles.add(fileName);
    const durationSec = await probeLocalFileDuration(fullPath) ?? handle.segmentDurationSec;
    const startDate = parseSegmentFilenameDate(fileName) ?? new Date(stat.mtimeMs - durationSec * 1e3);
    const endDate = new Date(startDate.getTime() + durationSec * 1e3);
    const year = startDate.getUTCFullYear();
    const month = startDate.getUTCMonth() + 1;
    const day = startDate.getUTCDate();
    const recordDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const startSeconds = startDate.getUTCHours() * 3600 + startDate.getUTCMinutes() * 60 + startDate.getUTCSeconds();
    const endSeconds = Math.min(86400, startSeconds + durationSec);
    const fileHash = crypto4.createHash("sha256").update(fs4.readFileSync(fullPath)).digest("hex");
    const segId = `seg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = (/* @__PURE__ */ new Date()).toISOString();
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
    uploadSegmentToCloud(segId).catch((err) => {
      recordErrorLog({
        channelKey: handle.channelKey,
        channelName: handle.channelName,
        sessionId: handle.sessionId,
        segmentId: segId,
        severity: "ERROR",
        errorCode: "UPLOAD_DISPATCH_ERROR",
        message: "Unexpected upload error",
        details: err instanceof Error ? err.message : String(err)
      });
    });
  }
}
function spawnFfmpegProcess(handle, streamUrl, reconnectDelaySec) {
  if (handle.stoppedByUser) return;
  const db = getDb();
  fs4.mkdirSync(handle.stagingDir, { recursive: true });
  const outputPattern = path3.join(handle.stagingDir, "seg_%Y%m%d_%H%M%S.mp4");
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    String(Math.max(5, Math.min(60, reconnectDelaySec))),
    "-i",
    streamUrl,
    "-c",
    "copy",
    "-f",
    "segment",
    "-segment_time",
    String(handle.segmentDurationSec),
    "-segment_format",
    "mp4",
    "-segment_format_options",
    "movflags=+faststart",
    "-reset_timestamps",
    "1",
    "-strftime",
    "1",
    outputPattern
  ];
  const { bin: ffmpegBin } = resolveFfmpegBin();
  const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
  handle.process = child;
  handle.lastStderr = "";
  const now = (/* @__PURE__ */ new Date()).toISOString();
  db.prepare(
    `UPDATE recording_sessions SET status = 'RECORDING', pid = ?, last_heartbeat_at = ?, last_error = NULL WHERE id = ?`
  ).run(child.pid ?? null, now, handle.sessionId);
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      handle.lastStderr = text.slice(-400);
    }
  });
  child.on("error", (err) => {
    const errMsg = `FFmpeg process failed to start: ${err.message}`;
    handle.lastStderr = errMsg;
    recordErrorLog({
      channelKey: handle.channelKey,
      channelName: handle.channelName,
      sessionId: handle.sessionId,
      severity: "CRITICAL",
      errorCode: "FFMPEG_SPAWN_ERROR",
      message: errMsg
    });
  });
  child.on("close", (code) => {
    handle.process = null;
    finalizeCompletedSegments(handle, true).catch(() => {
    });
    if (handle.stoppedByUser) {
      db.prepare(
        `UPDATE recording_sessions SET status = 'STOPPED', ended_at = ?, pid = NULL, last_heartbeat_at = ? WHERE id = ?`
      ).run((/* @__PURE__ */ new Date()).toISOString(), (/* @__PURE__ */ new Date()).toISOString(), handle.sessionId);
      return;
    }
    const reason = handle.lastStderr || `Source stream disconnected (ffmpeg exit code ${code ?? "unknown"}).`;
    const ts = (/* @__PURE__ */ new Date()).toISOString();
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
      severity: "WARN",
      errorCode: "STREAM_DISCONNECTED_RECONNECTING",
      message: `Stream disconnected for ${handle.channelName}; retrying in ${reconnectDelaySec}s`,
      details: reason
    });
    handle.reconnectTimer = setTimeout(() => {
      handle.reconnectTimer = null;
      if (!handle.stoppedByUser && activeWorkers.get(handle.channelKey) === handle) {
        spawnFfmpegProcess(handle, streamUrl, reconnectDelaySec);
      }
    }, Math.max(3, reconnectDelaySec) * 1e3);
  });
}
async function startChannelRecording(params) {
  const db = getDb();
  if (activeWorkers.has(params.channelKey)) {
    return {
      ok: false,
      error: "A recording session is already active for this channel. Stop or restart it first."
    };
  }
  const ffmpegCheck = await checkFfmpegAvailable();
  if (!ffmpegCheck.available) {
    return {
      ok: false,
      error: "FFmpeg is not installed or unavailable on this cloud worker."
    };
  }
  const source = params.sourceId ? db.prepare(`SELECT * FROM recording_sources WHERE id = ?`).get(params.sourceId) : db.prepare(
    `SELECT * FROM recording_sources WHERE channel_key = ? AND is_enabled = 1 ORDER BY updated_at DESC LIMIT 1`
  ).get(params.channelKey);
  if (!source) {
    return {
      ok: false,
      error: "No enabled recording source configured for this channel. Add an authorized stream URL in Channel Management first."
    };
  }
  if (source.recording_permission !== "AUTHORIZED") {
    recordErrorLog({
      channelKey: source.channel_key,
      channelName: source.channel_name,
      severity: "WARN",
      errorCode: "RECORDING_PERMISSION_DENIED",
      message: `Recording blocked for ${source.channel_name}: source permission is ${source.recording_permission}.`
    });
    return {
      ok: false,
      error: `Recording is blocked because this source's permission is set to "${source.recording_permission}". Only AUTHORIZED sources may be recorded.`
    };
  }
  const streamUrl = decryptSecret(source.stream_url_encrypted);
  if (!streamUrl) {
    return { ok: false, error: "Configured stream URL is empty or could not be decrypted." };
  }
  const probe = await probeStreamUrl(streamUrl);
  const probeNow = (/* @__PURE__ */ new Date()).toISOString();
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
    probe.reachable ? "ONLINE" : "UNREACHABLE",
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
      severity: "WARN",
      errorCode: "SOURCE_UNREACHABLE_WARNING",
      message: `Stream probe warning for ${source.channel_name}: attempting recording spawn anyway.`,
      details: probe.error
    });
  }
  const cfg = getRawCloudStorageConfig();
  const segmentDurationSec = Math.max(
    30,
    Math.min(7200, source.segment_duration_seconds || cfg.defaultSegmentSeconds || 3600)
  );
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const safeKey = source.channel_key.replace(/[^a-zA-Z0-9_-]/g, "_");
  const stagingDir = path3.join(RECORDINGS_DIR, safeKey, sessionId);
  fs4.mkdirSync(stagingDir, { recursive: true });
  const now = (/* @__PURE__ */ new Date()).toISOString();
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
  const handle = {
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
    processedFiles: /* @__PURE__ */ new Set(),
    lastStderr: "",
    startedAtMs: Date.now(),
    segmentCounter: 0
  };
  activeWorkers.set(source.channel_key, handle);
  handle.watcherTimer = setInterval(() => {
    finalizeCompletedSegments(handle, false).catch(() => {
    });
  }, 5e3);
  handle.heartbeatTimer = setInterval(() => {
    if (!handle.stoppedByUser) {
      getDb().prepare(`UPDATE recording_sessions SET last_heartbeat_at = ? WHERE id = ?`).run((/* @__PURE__ */ new Date()).toISOString(), handle.sessionId);
    }
  }, 15e3);
  spawnFfmpegProcess(handle, streamUrl, source.reconnect_delay_sec || 10);
  logAudit({
    entityType: "RECORDING_SESSION",
    entityId: sessionId,
    action: "RECORDING_STARTED",
    notes: `Started cloud recording for ${source.channel_name} by ${params.triggeredBy || "system"} (${segmentDurationSec}s segments)`
  });
  return { ok: true, sessionId };
}
async function stopChannelRecording(channelKey, triggeredBy = "operator") {
  const handle = activeWorkers.get(channelKey);
  const db = getDb();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (!handle) {
    const stale = db.prepare(
      `UPDATE recording_sessions SET status = 'STOPPED', ended_at = ?, auto_recover = 0, pid = NULL
         WHERE channel_key = ? AND status IN ('STARTING', 'RECORDING', 'RECONNECTING')`
    ).run(now, channelKey);
    if (stale.changes > 0) {
      return { ok: true, message: "Stopped stale recording session state." };
    }
    return { ok: false, message: "No active recording session found for this channel." };
  }
  handle.stoppedByUser = true;
  if (handle.reconnectTimer) clearTimeout(handle.reconnectTimer);
  if (handle.watcherTimer) clearInterval(handle.watcherTimer);
  if (handle.heartbeatTimer) clearInterval(handle.heartbeatTimer);
  if (handle.process && !handle.process.killed) {
    try {
      handle.process.kill("SIGTERM");
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  await finalizeCompletedSegments(handle, true);
  activeWorkers.delete(channelKey);
  db.prepare(
    `UPDATE recording_sessions SET status = 'STOPPED', ended_at = ?, auto_recover = 0, pid = NULL, last_heartbeat_at = ? WHERE id = ?`
  ).run(now, now, handle.sessionId);
  logAudit({
    entityType: "RECORDING_SESSION",
    entityId: handle.sessionId,
    action: "RECORDING_STOPPED",
    notes: `Stopped recording for ${handle.channelName} by ${triggeredBy}`
  });
  return { ok: true, message: `Stopped recording for ${handle.channelName}.` };
}
async function restartChannelRecording(channelKey, triggeredBy = "operator") {
  await stopChannelRecording(channelKey, triggeredBy);
  return startChannelRecording({ channelKey, triggeredBy, autoRecover: true });
}
async function retryFailedCloudUploads() {
  if (uploadLoopRunning) return { attempted: 0, succeeded: 0, failed: 0 };
  uploadLoopRunning = true;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  try {
    const pending = getDb().prepare(
      `SELECT s.id
         FROM recording_segments s
         LEFT JOIN cloud_uploads u ON u.segment_id = s.id
         WHERE s.is_complete = 1
           AND s.status IN ('LOCAL_READY', 'FAILED')
           AND (u.id IS NULL OR (u.status IN ('QUEUED', 'FAILED') AND u.attempts < u.max_attempts))
         ORDER BY s.created_at ASC
         LIMIT 20`
    ).all();
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
function getLiveRecordingMonitorData() {
  const db = getDb();
  const todayDate = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const channels = db.prepare(`SELECT id, channel_id, channel_name, metadata_json FROM channels ORDER BY channel_name ASC`).all();
  const sources = db.prepare(`SELECT * FROM recording_sources`).all();
  const sourceByChannel = /* @__PURE__ */ new Map();
  for (const s of sources) sourceByChannel.set(s.channel_key, s);
  const activeSessions = db.prepare(
    `SELECT * FROM recording_sessions
       WHERE status IN ('STARTING', 'RECORDING', 'RECONNECTING')
       ORDER BY started_at DESC`
  ).all();
  const sessionByChannel = /* @__PURE__ */ new Map();
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
    const todayAgg = todayStatsStmt.get(ch.id, todayDate);
    const totalAgg = totalStatsStmt.get(ch.id);
    const uploadAgg = uploadStatsStmt.get(ch.id);
    const interruptionsToday = interruptionsStmt.get(ch.id, todayDate).c;
    const latestErr = latestErrStmt.get(ch.id);
    let actualStatus = "STOPPED";
    if (!src) {
      actualStatus = "NO_SOURCE";
    } else if (src.recording_permission !== "AUTHORIZED") {
      actualStatus = "RESTRICTED";
    } else if (worker && worker.process && !worker.process.killed) {
      actualStatus = "RECORDING";
    } else if (worker && worker.reconnectTimer) {
      actualStatus = "RECONNECTING";
    } else if (dbSess?.status === "ERROR") {
      actualStatus = "ERROR";
    }
    const currentSessionDurationSec = worker && actualStatus === "RECORDING" ? Math.floor((Date.now() - worker.startedAtMs) / 1e3) : 0;
    let uploadStatus = "IDLE";
    if ((uploadAgg.uploading_count ?? 0) > 0) uploadStatus = "UPLOADING";
    else if ((uploadAgg.failed_count ?? 0) > 0) uploadStatus = "FAILED";
    else if (uploadAgg.last_verified_upload) uploadStatus = "VERIFIED";
    let category = "General";
    if (ch.metadata_json) {
      try {
        const parsed = JSON.parse(ch.metadata_json);
        if (parsed.category) category = parsed.category;
      } catch {
      }
    }
    return {
      channelKey: ch.id,
      channelId: ch.channel_id,
      channelName: ch.channel_name,
      category,
      source: src ? {
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
        historicalArchiveEndpoint: src.historical_archive_endpoint
      } : null,
      status: actualStatus,
      sessionId: worker?.sessionId ?? dbSess?.id ?? null,
      recordingStartedAt: worker ? new Date(worker.startedAtMs).toISOString() : dbSess?.started_at ?? null,
      currentDurationSeconds: currentSessionDurationSec,
      todayRecordedSeconds: todayAgg.today_seconds + currentSessionDurationSec,
      totalRecordedHours: (totalAgg.total_seconds + currentSessionDurationSec) / 3600,
      totalVideoSegments: totalAgg.total_segments,
      todaySegments: todayAgg.today_segments,
      totalStorageBytes: totalAgg.total_bytes,
      totalStorageGb: totalAgg.total_bytes / 1024 ** 3,
      uploadStatus,
      lastSuccessfulUploadAt: uploadAgg.last_verified_upload,
      failedUploads: uploadAgg.failed_count ?? 0,
      interruptionsCount: (dbSess?.reconnect_count ?? 0) + interruptionsToday,
      currentError: worker?.lastStderr || latestErr?.message || null
    };
  });
  return {
    worker: getWorkerIdentity(),
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    summary: {
      totalChannels: rows.length,
      recordingNow: rows.filter((r) => r.status === "RECORDING").length,
      reconnecting: rows.filter((r) => r.status === "RECONNECTING").length,
      configuredSources: rows.filter((r) => r.source !== null).length,
      totalStorageGb: rows.reduce((sum, r) => sum + r.totalStorageGb, 0),
      totalRecordedHours: rows.reduce((sum, r) => sum + r.totalRecordedHours, 0),
      totalSegments: rows.reduce((sum, r) => sum + r.totalVideoSegments, 0)
    },
    channels: rows
  };
}
function matchAutosaveEntriesToVideoArchive(params) {
  const db = getDb();
  const where = ["is_deleted_record = 0"];
  const vals = [];
  if (params.channelKey) {
    where.push("channel_key = ?");
    vals.push(params.channelKey);
  }
  if (params.recordDate) {
    where.push("trans_date = ?");
    vals.push(params.recordDate);
  }
  if (params.batchId) {
    where.push("batch_id = ?");
    vals.push(params.batchId);
  }
  const entries = db.prepare(
    `SELECT id, channel_key, trans_date, start_seconds, end_seconds
       FROM entries
       WHERE ${where.join(" AND ")}`
  ).all(...vals);
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
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const tx = db.transaction(() => {
    for (const entry of entries) {
      if (!entry.trans_date || entry.start_seconds === null) {
        unavailable++;
        upsertMatchStmt.run(
          `vm_${entry.id}`,
          entry.id,
          entry.channel_key,
          entry.trans_date || "",
          entry.start_seconds,
          entry.end_seconds,
          null,
          null,
          "VIDEO_NOT_AVAILABLE",
          now
        );
        continue;
      }
      const arc = findArchiveStmt.get(
        entry.channel_key,
        entry.trans_date,
        entry.start_seconds,
        entry.start_seconds
      );
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
          "MATCHED",
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
          "VIDEO_NOT_AVAILABLE",
          now
        );
      }
    }
  });
  tx();
  return { scanned: entries.length, matched, unavailable };
}
async function importAuthorizedHistoricalVideo(params) {
  const db = getDb();
  const channel = db.prepare(`SELECT id, channel_name FROM channels WHERE id = ?`).get(params.channelKey);
  if (!channel) return { ok: false, error: "Channel not found." };
  const source = db.prepare(`SELECT recording_permission FROM recording_sources WHERE channel_key = ? LIMIT 1`).get(params.channelKey);
  if (source && source.recording_permission !== "AUTHORIZED") {
    return {
      ok: false,
      error: `Historical import blocked: channel recording permission is "${source.recording_permission}".`
    };
  }
  const probe = await probeStreamUrl(params.sourceUrl);
  if (!probe.reachable) {
    return {
      ok: false,
      error: `Authorized historical media URL could not be accessed: ${probe.error || "Unreachable"}`
    };
  }
  const [yStr, mStr, dStr] = params.recordDate.split("-");
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (!year || !month || !day) {
    return { ok: false, error: "Invalid date format (expected YYYY-MM-DD)." };
  }
  const safeKey = channel.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const importDir = path3.join(RECORDINGS_DIR, safeKey, "historical_imports");
  fs4.mkdirSync(importDir, { recursive: true });
  const hh = String(Math.max(0, Math.min(23, Math.floor(params.startHour)))).padStart(2, "0");
  const fileName = `hist_${yStr}${mStr}${dStr}_${hh}0000.mp4`;
  const localPath = path3.join(importDir, fileName);
  try {
    const { bin: ffmpegBin } = resolveFfmpegBin();
    await execFileAsync(
      ffmpegBin,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        params.sourceUrl.trim(),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        localPath
      ],
      { timeout: 10 * 60 * 1e3 }
    );
  } catch (err) {
    return {
      ok: false,
      error: `Historical recording download failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (!fs4.existsSync(localPath) || fs4.statSync(localPath).size < 1024) {
    return { ok: false, error: "Downloaded historical file was empty or invalid." };
  }
  const stat = fs4.statSync(localPath);
  const durationSec = await probeLocalFileDuration(localPath) ?? 3600;
  const startSeconds = Math.max(0, Math.min(23, Math.floor(params.startHour))) * 3600;
  const endSeconds = Math.min(86400, startSeconds + durationSec);
  const startIso = `${params.recordDate}T${hh}:00:00.000Z`;
  const endIso = new Date(new Date(startIso).getTime() + durationSec * 1e3).toISOString();
  const hash = crypto4.createHash("sha256").update(fs4.readFileSync(localPath)).digest("hex");
  const sessId = `hist_sess_${Date.now()}`;
  const segId = `hist_seg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const existingSource = db.prepare(`SELECT id FROM recording_sources WHERE channel_key = ? LIMIT 1`).get(channel.id);
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
        entityType: "VIDEO_ARCHIVE",
        entityId: uploadRes.archiveId,
        action: "HISTORICAL_VIDEO_IMPORTED",
        notes: `Imported authorized historical video for ${channel.channel_name} (${params.recordDate} ${hh}:00) by ${params.triggeredBy}`
      });
      return { ok: true, archiveId: uploadRes.archiveId };
    }
    return { ok: false, error: uploadRes.error || "Upload failed." };
  }
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

// server/cloudRecordingRouter.ts
var router2 = express2.Router();
function resolveAuthUser(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    const sess = getDb().prepare(
      `SELECT s.user_id, s.username, u.role, s.expires_at
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND u.is_active = 1`
    ).get(token);
    if (sess && new Date(sess.expires_at).getTime() > Date.now()) {
      return { id: sess.user_id, username: sess.username, role: sess.role };
    }
  }
  return null;
}
function requireRole2(allowedRoles) {
  return (req, res, next) => {
    const u = resolveAuthUser(req);
    if (!u) {
      res.status(401).json({ error: "Authentication required for recording control operations." });
      return;
    }
    if (!allowedRoles.includes(u.role)) {
      res.status(403).json({ error: `Role "${u.role}" is not permitted to perform this operation.` });
      return;
    }
    req.authUser = u;
    next();
  };
}
router2.get("/api/recording/monitor", async (_req, res) => {
  const ffmpeg = await checkFfmpegAvailable();
  const data = getLiveRecordingMonitorData();
  res.json({
    ...data,
    ffmpeg
  });
});
router2.get("/api/recording/health", async (_req, res) => {
  const ffmpeg = await checkFfmpegAvailable();
  const storage = getPublicCloudStorageConfig();
  res.json({
    worker: getWorkerIdentity(),
    ffmpeg,
    cloudStorageConfigured: storage.isConfigured,
    cloudStorageProvider: storage.provider,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
});
router2.post("/api/recording/install-ffmpeg", requireRole2(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), async (_req, res) => {
  const result = await installRuntimeFfmpeg();
  if (!result.ok) {
    res.status(500).json({ error: result.error || "Failed to install FFmpeg runtime." });
    return;
  }
  res.json(result);
});
router2.get("/api/recording/sources", (_req, res) => {
  const rows = getDb().prepare(
    `SELECT
         id, channel_key, channel_name, source_type, stream_url_redacted,
         historical_archive_endpoint, recording_permission, segment_duration_seconds,
         is_enabled, auto_record_24_7, reconnect_delay_sec, last_probe_status,
         last_probe_at, last_probe_error, video_codec, resolution, notes, created_at, updated_at
       FROM recording_sources
       ORDER BY channel_name ASC`
  ).all();
  res.json(rows);
});
router2.post("/api/recording/sources", requireRole2(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
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
    notes
  } = req.body;
  if (!channelKey || !streamUrl || !streamUrl.trim()) {
    res.status(400).json({ error: "channelKey and authorized streamUrl are required." });
    return;
  }
  const db = getDb();
  const channel = db.prepare(`SELECT id, channel_name FROM channels WHERE id = ?`).get(channelKey);
  if (!channel) {
    res.status(404).json({ error: "Selected channel does not exist." });
    return;
  }
  const perm = ["AUTHORIZED", "PLAYBACK_ONLY", "RESTRICTED"].includes(recordingPermission || "") ? recordingPermission : "AUTHORIZED";
  const cleanUrl = streamUrl.trim();
  const encrypted = encryptSecret(cleanUrl);
  const redacted = redactStreamCredentials(cleanUrl);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const existing = db.prepare(`SELECT id FROM recording_sources WHERE channel_key = ? LIMIT 1`).get(channel.id);
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
      sourceType || "HLS_M3U8",
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
      entityType: "RECORDING_SOURCE",
      entityId: existing.id,
      action: "RECORDING_SOURCE_UPDATED",
      notes: `Updated stream source for ${channel.channel_name} (${perm}) by ${req.authUser?.username}`
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
    sourceType || "HLS_M3U8",
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
    entityType: "RECORDING_SOURCE",
    entityId: id,
    action: "RECORDING_SOURCE_CREATED",
    notes: `Configured authorized recording source for ${channel.channel_name} by ${req.authUser?.username}`
  });
  res.status(201).json({ ok: true, id, streamUrlRedacted: redacted });
});
router2.patch("/api/recording/sources/:id", requireRole2(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
  const { isEnabled, autoRecord247, recordingPermission, segmentDurationSeconds } = req.body;
  const db = getDb();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  db.prepare(
    `UPDATE recording_sources SET
       is_enabled = COALESCE(?, is_enabled),
       auto_record_24_7 = COALESCE(?, auto_record_24_7),
       recording_permission = COALESCE(?, recording_permission),
       segment_duration_seconds = COALESCE(?, segment_duration_seconds),
       updated_at = ?
     WHERE id = ?`
  ).run(
    isEnabled !== void 0 ? isEnabled ? 1 : 0 : null,
    autoRecord247 !== void 0 ? autoRecord247 ? 1 : 0 : null,
    recordingPermission || null,
    segmentDurationSeconds !== void 0 ? Math.max(30, Math.min(7200, Number(segmentDurationSeconds))) : null,
    now,
    req.params.id
  );
  res.json({ ok: true });
});
router2.post("/api/recording/sources/:id/probe", requireRole2(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), async (req, res) => {
  const db = getDb();
  const src = db.prepare(`SELECT id, stream_url_encrypted FROM recording_sources WHERE id = ?`).get(req.params.id);
  if (!src) {
    res.status(404).json({ error: "Recording source not found." });
    return;
  }
  const rawUrl = decryptSecret(src.stream_url_encrypted);
  const result = await probeStreamUrl(rawUrl);
  const now = (/* @__PURE__ */ new Date()).toISOString();
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
    result.reachable ? "ONLINE" : "UNREACHABLE",
    now,
    result.error,
    result.videoCodec,
    result.resolution,
    now,
    src.id
  );
  res.json(result);
});
router2.delete("/api/recording/sources/:id", requireRole2(["SUPER_ADMIN", "ADMIN"]), (req, res) => {
  getDb().prepare(`DELETE FROM recording_sources WHERE id = ?`).run(req.params.id);
  logAudit({
    entityType: "RECORDING_SOURCE",
    entityId: req.params.id,
    action: "RECORDING_SOURCE_DELETED",
    notes: `Deleted by ${req.authUser?.username}`
  });
  res.json({ ok: true });
});
router2.post("/api/recording/start", requireRole2(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), async (req, res) => {
  const { channelKey, sourceId } = req.body;
  if (!channelKey) {
    res.status(400).json({ error: "channelKey is required." });
    return;
  }
  const result = await startChannelRecording({
    channelKey,
    sourceId,
    triggeredBy: req.authUser?.username || "operator",
    autoRecover: true
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result);
});
router2.post("/api/recording/stop", requireRole2(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), async (req, res) => {
  const { channelKey } = req.body;
  if (!channelKey) {
    res.status(400).json({ error: "channelKey is required." });
    return;
  }
  const result = await stopChannelRecording(channelKey, req.authUser?.username || "operator");
  res.json(result);
});
router2.post("/api/recording/restart", requireRole2(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), async (req, res) => {
  const { channelKey } = req.body;
  if (!channelKey) {
    res.status(400).json({ error: "channelKey is required." });
    return;
  }
  const result = await restartChannelRecording(channelKey, req.authUser?.username || "operator");
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result);
});
router2.post("/api/recording/start-all", requireRole2(["SUPER_ADMIN", "ADMIN"]), async (req, res) => {
  const sources = getDb().prepare(
    `SELECT id, channel_key, channel_name FROM recording_sources
       WHERE is_enabled = 1 AND recording_permission = 'AUTHORIZED'`
  ).all();
  const results = [];
  for (const s of sources) {
    const r = await startChannelRecording({
      channelKey: s.channel_key,
      sourceId: s.id,
      triggeredBy: req.authUser?.username || "admin",
      autoRecover: true
    });
    results.push({ channelName: s.channel_name, ok: r.ok, error: r.error });
  }
  res.json({ started: results.filter((r) => r.ok).length, total: sources.length, results });
});
router2.get("/api/recording/schedules", (_req, res) => {
  const rows = getDb().prepare(`SELECT * FROM recording_schedules ORDER BY channel_name ASC`).all();
  res.json(rows);
});
router2.post("/api/recording/schedules", requireRole2(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
  const { channelKey, mode, startTime, endTime, daysOfWeek, isEnabled } = req.body;
  if (!channelKey) {
    res.status(400).json({ error: "channelKey is required." });
    return;
  }
  const db = getDb();
  const src = db.prepare(`SELECT id, channel_name FROM recording_sources WHERE channel_key = ? LIMIT 1`).get(channelKey);
  if (!src) {
    res.status(400).json({ error: "Configure an authorized recording source for this channel first." });
    return;
  }
  const id = `sch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
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
    mode || "CONTINUOUS_24_7",
    startTime || null,
    endTime || null,
    daysOfWeek || "MON,TUE,WED,THU,FRI,SAT,SUN",
    isEnabled === false ? 0 : 1,
    now,
    now
  );
  res.status(201).json({ ok: true, id });
});
router2.delete("/api/recording/schedules/:id", requireRole2(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
  getDb().prepare(`DELETE FROM recording_schedules WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});
router2.get("/api/archive/tree", (req, res) => {
  const { channelKey, date, time } = req.query;
  const db = getDb();
  const where = ["is_verified = 1"];
  const params = [];
  if (channelKey && channelKey !== "ALL") {
    where.push("channel_key = ?");
    params.push(channelKey);
  }
  if (date) {
    where.push("record_date = ?");
    params.push(date);
  }
  if (time) {
    const parts = time.split(":").map(Number);
    if (!Number.isNaN(parts[0])) {
      const sec = parts[0] * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
      where.push("start_seconds <= ? AND end_seconds >= ?");
      params.push(sec, sec);
    }
  }
  const segments = db.prepare(
    `SELECT
         id, channel_key, channel_name, record_date, year, month, day,
         start_time_iso, end_time_iso, start_seconds, end_seconds, duration_seconds,
         file_size_bytes, storage_provider, bucket, object_key, source_origin, created_at
       FROM video_archive
       WHERE ${where.join(" AND ")}
       ORDER BY channel_name ASC, year DESC, month DESC, day DESC, start_seconds ASC`
  ).all(...params);
  const treeMap = /* @__PURE__ */ new Map();
  for (const seg of segments) {
    if (!treeMap.has(seg.channel_key)) {
      treeMap.set(seg.channel_key, {
        channelKey: seg.channel_key,
        channelName: seg.channel_name,
        totalSegments: 0,
        totalBytes: 0,
        years: /* @__PURE__ */ new Map()
      });
    }
    const chNode = treeMap.get(seg.channel_key);
    chNode.totalSegments++;
    chNode.totalBytes += seg.file_size_bytes || 0;
    if (!chNode.years.has(seg.year)) {
      chNode.years.set(seg.year, { year: seg.year, months: /* @__PURE__ */ new Map() });
    }
    const yNode = chNode.years.get(seg.year);
    if (!yNode.months.has(seg.month)) {
      yNode.months.set(seg.month, { month: seg.month, dates: /* @__PURE__ */ new Map() });
    }
    const mNode = yNode.months.get(seg.month);
    if (!mNode.dates.has(seg.record_date)) {
      mNode.dates.set(seg.record_date, {
        recordDate: seg.record_date,
        day: seg.day,
        segments: [],
        coveredHours: /* @__PURE__ */ new Set()
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
    years: Array.from(ch.years.values()).map((y) => ({
      year: y.year,
      months: Array.from(y.months.values()).map((m) => ({
        month: m.month,
        dates: Array.from(m.dates.values()).map((d) => {
          const missingHours = [];
          for (let h = 0; h < 24; h++) {
            if (!d.coveredHours.has(h)) missingHours.push(h);
          }
          return {
            recordDate: d.recordDate,
            day: d.day,
            coveredHoursCount: d.coveredHours.size,
            missingHours,
            segments: d.segments
          };
        })
      }))
    }))
  }));
  res.json({ totalSegments: segments.length, tree, segments });
});
router2.get("/api/archive/:id/playback-url", async (req, res) => {
  const db = getDb();
  const seg = db.prepare(
    `SELECT
         id, channel_key, channel_name, record_date, start_time_iso, end_time_iso,
         start_seconds, end_seconds, duration_seconds, file_size_bytes, storage_provider, source_origin
       FROM video_archive WHERE id = ? AND is_verified = 1`
  ).get(req.params.id);
  if (!seg) {
    res.status(404).json({ error: "Verified video segment not found." });
    return;
  }
  const playback = await generateTimeLimitedPlaybackUrl(seg.id);
  if (!playback) {
    res.status(404).json({
      error: "Video file is currently unavailable in cloud object storage or local staging."
    });
    return;
  }
  const prevSegment = db.prepare(
    `SELECT id, start_time_iso, end_time_iso, start_seconds, end_seconds, record_date
       FROM video_archive
       WHERE channel_key = ? AND is_verified = 1
         AND (record_date < ? OR (record_date = ? AND start_seconds < ?))
       ORDER BY record_date DESC, start_seconds DESC
       LIMIT 1`
  ).get(seg.channel_key, seg.record_date, seg.record_date, seg.start_seconds);
  const nextSegment = db.prepare(
    `SELECT id, start_time_iso, end_time_iso, start_seconds, end_seconds, record_date
       FROM video_archive
       WHERE channel_key = ? AND is_verified = 1
         AND (record_date > ? OR (record_date = ? AND start_seconds > ?))
       ORDER BY record_date ASC, start_seconds ASC
       LIMIT 1`
  ).get(seg.channel_key, seg.record_date, seg.record_date, seg.start_seconds);
  const matchedEntries = db.prepare(
    `SELECT
         m.entry_id, m.offset_seconds, e.entry_type, e.caption_name, e.brand_name,
         e.start_time, e.end_time, e.duration_seconds, e.qa_status
       FROM video_timestamp_matches m
       JOIN entries e ON e.id = m.entry_id
       WHERE m.archive_id = ? AND m.match_status = 'MATCHED'
       ORDER BY m.offset_seconds ASC`
  ).all(seg.id);
  res.json({
    segment: seg,
    playbackUrl: playback.url,
    expiresAt: playback.expiresAt,
    storageProvider: playback.storageProvider,
    prevSegment: prevSegment ?? null,
    nextSegment: nextSegment ?? null,
    matchedEntries
  });
});
router2.get("/api/video/stream/:id", (req, res) => {
  const exp = Number(req.query.exp);
  const token = String(req.query.token || "");
  if (!verifyPlaybackToken(req.params.id, exp, token)) {
    res.status(403).json({ error: "Playback URL expired or invalid signature." });
    return;
  }
  const row = getDb().prepare(`SELECT local_fallback_path FROM video_archive WHERE id = ? AND is_verified = 1`).get(req.params.id);
  if (!row?.local_fallback_path || !fs5.existsSync(row.local_fallback_path)) {
    res.status(404).json({ error: "Video segment file not found." });
    return;
  }
  const filePath = row.local_fallback_path;
  const stat = fs5.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
      "Cache-Control": "private, max-age=60"
    });
    fs5.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60"
    });
    fs5.createReadStream(filePath).pipe(res);
  }
});
router2.get("/api/historical/search", (req, res) => {
  const { channelKey, dateFrom, dateTo } = req.query;
  const db = getDb();
  if (!channelKey) {
    res.status(400).json({ error: "channelKey is required." });
    return;
  }
  const channel = db.prepare(`SELECT id, channel_name FROM channels WHERE id = ?`).get(channelKey);
  if (!channel) {
    res.status(404).json({ error: "Channel not found." });
    return;
  }
  const source = db.prepare(
    `SELECT id, recording_permission, historical_archive_endpoint FROM recording_sources WHERE channel_key = ? LIMIT 1`
  ).get(channelKey);
  const end = dateTo ? /* @__PURE__ */ new Date(`${dateTo}T00:00:00Z`) : /* @__PURE__ */ new Date();
  const start = dateFrom ? /* @__PURE__ */ new Date(`${dateFrom}T00:00:00Z`) : new Date(end.getTime() - 6 * 864e5);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    res.status(400).json({ error: "Invalid date range." });
    return;
  }
  const maxDays = 60;
  const days = [];
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
    const segs = archiveStmt.all(channelKey, dateStr);
    const hourSet = /* @__PURE__ */ new Set();
    let totalBytes = 0;
    for (const s of segs) {
      totalBytes += s.file_size_bytes || 0;
      const sh = Math.max(0, Math.min(23, Math.floor(s.start_seconds / 3600)));
      const eh = Math.max(sh, Math.min(23, Math.floor(Math.max(s.start_seconds, s.end_seconds - 1) / 3600)));
      for (let h = sh; h <= eh; h++) hourSet.add(h);
    }
    const availableHourList = Array.from(hourSet).sort((a, b) => a - b);
    const missingHourList = [];
    for (let h = 0; h < 24; h++) {
      if (!hourSet.has(h)) missingHourList.push(h);
    }
    let status = "UNAVAILABLE";
    if (availableHourList.length === 24) status = "COMPLETE_24H";
    else if (availableHourList.length > 0) status = "PARTIAL";
    const autosaveEntryCount = entryCountStmt.get(channelKey, dateStr).c;
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
        duration_seconds: s.duration_seconds
      }))
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  days.reverse();
  res.json({
    channel,
    recordingPermission: source?.recording_permission ?? "NOT_CONFIGURED",
    historicalArchiveEndpoint: source?.historical_archive_endpoint ?? null,
    notice: "Autosave XML files contain schedule/broadcast metadata only \u2014 never video. Dates marked UNAVAILABLE have no verified recording in cloud storage.",
    days
  });
});
router2.post("/api/historical/import", requireRole2(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), async (req, res) => {
  const { channelKey, recordDate, startHour, sourceUrl } = req.body;
  if (!channelKey || !recordDate || !sourceUrl) {
    res.status(400).json({ error: "channelKey, recordDate (YYYY-MM-DD), and authorized sourceUrl are required." });
    return;
  }
  const result = await importAuthorizedHistoricalVideo({
    channelKey,
    recordDate,
    startHour: Number(startHour) || 0,
    sourceUrl,
    triggeredBy: req.authUser?.username || "operator"
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result);
});
router2.post("/api/autosave/match-video", (req, res) => {
  const { channelKey, recordDate, batchId } = req.body;
  const summary = matchAutosaveEntriesToVideoArchive({ channelKey, recordDate, batchId });
  res.json({ ok: true, ...summary });
});
router2.get("/api/autosave/matches", (req, res) => {
  const { channelKey, recordDate, batchId } = req.query;
  const db = getDb();
  const where = ["e.is_deleted_record = 0"];
  const params = [];
  if (channelKey && channelKey !== "ALL") {
    where.push("e.channel_key = ?");
    params.push(channelKey);
  }
  if (recordDate) {
    where.push("e.trans_date = ?");
    params.push(recordDate);
  }
  if (batchId) {
    where.push("e.batch_id = ?");
    params.push(batchId);
  }
  const rows = db.prepare(
    `SELECT
         e.id AS entry_id, e.channel_key, e.channel_name, e.trans_date,
         e.entry_type, e.caption_name, e.brand_name, e.start_time, e.end_time,
         e.start_seconds, e.duration_seconds, e.qa_status,
         COALESCE(m.match_status, 'VIDEO_NOT_AVAILABLE') AS match_status,
         m.archive_id, m.offset_seconds, m.matched_at
       FROM entries e
       LEFT JOIN video_timestamp_matches m ON m.entry_id = e.id
       WHERE ${where.join(" AND ")}
       ORDER BY e.trans_date DESC, e.start_seconds ASC
       LIMIT 300`
  ).all(...params);
  res.json(rows);
});
router2.get("/api/storage/analytics", (_req, res) => {
  res.json(getStorageAnalytics());
});
router2.get("/api/storage/config", (_req, res) => {
  res.json(getPublicCloudStorageConfig());
});
router2.put("/api/storage/config", requireRole2(["SUPER_ADMIN", "ADMIN"]), (req, res) => {
  const body = req.body;
  const updated = updateCloudStorageConfig(body);
  res.json(updated);
});
router2.post("/api/storage/test", requireRole2(["SUPER_ADMIN", "ADMIN"]), async (_req, res) => {
  const result = await testCloudStorageConnection();
  res.json(result);
});
router2.post("/api/storage/retry-uploads", requireRole2(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), async (_req, res) => {
  const result = await retryFailedCloudUploads();
  res.json(result);
});
router2.get("/api/recording/logs", (req, res) => {
  const { channelKey, limit } = req.query;
  const lim = Math.min(Number(limit) || 150, 500);
  const db = getDb();
  const errWhere = channelKey && channelKey !== "ALL" ? "WHERE channel_key = ?" : "";
  const errParams = channelKey && channelKey !== "ALL" ? [channelKey, lim] : [lim];
  const errors = db.prepare(`SELECT * FROM recording_errors ${errWhere} ORDER BY created_at DESC LIMIT ?`).all(...errParams);
  const sessions = db.prepare(`SELECT * FROM recording_sessions ${errWhere} ORDER BY started_at DESC LIMIT ?`).all(...errParams);
  const uploads = db.prepare(
    `SELECT u.*, s.file_name, s.channel_name, s.record_date
       FROM cloud_uploads u
       LEFT JOIN recording_segments s ON s.id = u.segment_id
       ${channelKey && channelKey !== "ALL" ? "WHERE u.channel_key = ?" : ""}
       ORDER BY u.created_at DESC
       LIMIT ?`
  ).all(...errParams);
  res.json({ errors, sessions, uploads });
});
router2.patch("/api/recording/errors/:id/resolve", requireRole2(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
  getDb().prepare(`UPDATE recording_errors SET resolved = 1 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});
var cloudRecordingRouter_default = router2;

// server/app.ts
function createApiApp() {
  const app2 = express3();
  app2.use(express3.json({ limit: "10mb" }));
  app2.use(mediaRouter_default);
  app2.use(cloudRecordingRouter_default);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 50 * 1024 * 1024,
      // 50 MB per file
      files: 500
    }
  });
  function extractUploadedFiles(req) {
    const files = req.files ?? [];
    let relPaths = [];
    if (typeof req.body?.relativePaths === "string") {
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
      buffer: f.buffer
    }));
  }
  function getDirectorySize(dirPath) {
    if (!fs6.existsSync(dirPath)) return 0;
    let total = 0;
    for (const entry of fs6.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path4.join(dirPath, entry.name);
      if (entry.isDirectory()) total += getDirectorySize(full);
      else if (entry.isFile()) total += fs6.statSync(full).size;
    }
    return total;
  }
  app2.get("/api/dashboard", requireAuth, (_req, res) => {
    const db = getDb();
    const totalChannels = db.prepare(`SELECT COUNT(*) AS c FROM channels`).get().c;
    const importedChannels = db.prepare(`SELECT COUNT(DISTINCT channel_key) AS c FROM entries WHERE is_deleted_record = 0`).get().c;
    const entryCounts = db.prepare(
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
    ).get();
    const deletedRecordsCount = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE is_deleted_record = 1`).get().c;
    const issueBreakdown = db.prepare(
      `SELECT
         SUM(CASE WHEN rule_code IN ('TL_MISSING_MASTER_ID', 'TL_INDEX_SEQUENCE_JUMP', 'TL_SUSPECTED_GAP', 'TL_DELETED_RECORD_GAP', 'PROG_SUSPICIOUS_SEQUENCE') THEN 1 ELSE 0 END) AS missing_seq,
         SUM(CASE WHEN rule_code LIKE '%DUPLICATE%' THEN 1 ELSE 0 END) AS duplicates,
         SUM(CASE WHEN rule_code LIKE '%DURATION%' THEN 1 ELSE 0 END) AS duration_errors
       FROM qa_issues`
    ).get();
    let storageUsageBytes = 0;
    try {
      if (fs6.existsSync(DB_PATH)) storageUsageBytes += fs6.statSync(DB_PATH).size;
      if (fs6.existsSync(XML_ARCHIVE_DIR)) storageUsageBytes += getDirectorySize(XML_ARCHIVE_DIR);
    } catch {
    }
    const metrics = {
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
      reviewedCaptionsCount: entryCounts.reviewed_captions ?? 0
    };
    const recentImports = db.prepare(`SELECT * FROM import_batches ORDER BY imported_at DESC LIMIT 8`).all();
    const latestQaRun = db.prepare(`SELECT * FROM qa_runs ORDER BY completed_at DESC LIMIT 1`).get() ?? null;
    const recentIssues = db.prepare(
      `SELECT q.*, COALESCE(e.entry_type, q.entry_type) AS entry_type,
              e.master_entry_id, e.brand_name, e.caption_name, e.start_time, e.end_time, e.duration_seconds
       FROM qa_issues q
       LEFT JOIN entries e ON e.id = q.entry_id
       ORDER BY CASE q.severity WHEN 'RED' THEN 1 WHEN 'YELLOW' THEN 2 ELSE 3 END, q.created_at DESC
       LIMIT 12`
    ).all();
    const recentActivity = db.prepare(`SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 8`).all();
    res.json({ metrics, recentImports, latestQaRun, recentIssues, recentActivity });
  });
  app2.post("/api/import/inspect", requireRole(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), upload.array("files", 500), (req, res) => {
    try {
      const files = extractUploadedFiles(req);
      if (files.length === 0) {
        res.status(400).json({ error: "No files provided for inspection." });
        return;
      }
      const result = inspectAutosaveFiles(files);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Inspection failed" });
    }
  });
  app2.post("/api/import/commit", requireRole(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), upload.array("files", 500), async (req, res) => {
    try {
      const files = extractUploadedFiles(req);
      if (files.length === 0) {
        res.status(400).json({ error: "No files provided for import." });
        return;
      }
      const forceReprocessDuplicates = req.body?.forceReprocessDuplicates === "true";
      const runQaAfter = req.body?.runQaAfter === "true";
      const folderName = typeof req.body?.folderName === "string" ? req.body.folderName : void 0;
      const notes = typeof req.body?.notes === "string" ? req.body.notes : void 0;
      const importSummary = await commitAutosaveImport({
        files,
        folderName,
        notes,
        forceReprocessDuplicates
      });
      let qaSummary = null;
      if (runQaAfter) {
        qaSummary = runAutomaticQa();
      }
      const videoMatchSummary = matchAutosaveEntriesToVideoArchive({
        batchId: importSummary.batchId
      });
      res.json({ ...importSummary, qaSummary, videoMatchSummary });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Import failed" });
    }
  });
  app2.get("/api/import/batches", requireAuth, (_req, res) => {
    const batches = getDb().prepare(`SELECT * FROM import_batches ORDER BY imported_at DESC`).all();
    res.json(batches);
  });
  app2.get("/api/import/batches/:batchId/files", requireAuth, (req, res) => {
    const files = getDb().prepare(`SELECT * FROM xml_archive_files WHERE batch_id = ? ORDER BY file_name ASC`).all(req.params.batchId);
    res.json(files);
  });
  app2.get("/api/import/files/:fileId/raw", requireAuth, (req, res) => {
    const file = getDb().prepare(`SELECT file_name, archive_path FROM xml_archive_files WHERE id = ?`).get(req.params.fileId);
    if (!file || !fs6.existsSync(file.archive_path)) {
      res.status(404).json({ error: "Archived XML file not found." });
      return;
    }
    const content = fs6.readFileSync(file.archive_path);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${file.file_name}"`);
    res.send(content);
  });
  app2.get("/api/channels", requireAuth, (_req, res) => {
    const db = getDb();
    const rows = db.prepare(
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
    ).all();
    const dateRows = db.prepare(
      `SELECT DISTINCT channel_key, trans_date
       FROM entries
       WHERE trans_date IS NOT NULL
       ORDER BY trans_date DESC`
    ).all();
    const datesByChannel = /* @__PURE__ */ new Map();
    for (const r of dateRows) {
      const arr = datesByChannel.get(r.channel_key) ?? [];
      arr.push(r.trans_date);
      datesByChannel.set(r.channel_key, arr);
    }
    const result = rows.map((r) => ({
      ...r,
      dates: datesByChannel.get(r.id) ?? []
    }));
    res.json(result);
  });
  app2.post("/api/channels", requireRole(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
    const { channelName, channelId, category, notes } = req.body;
    const nameClean = (channelName ?? "").trim();
    const idClean = (channelId ?? "").trim();
    if (!nameClean) {
      res.status(400).json({ error: "Channel name is required." });
      return;
    }
    const channelKey = idClean ? `ch_id_${idClean.toLowerCase()}` : `ch_name_${nameClean.toLowerCase().replace(/\s+/g, "_")}`;
    const db = getDb();
    const existing = db.prepare(`SELECT id, channel_name FROM channels WHERE id = ?`).get(channelKey);
    if (existing) {
      res.status(409).json({
        error: `Channel "${existing.channel_name}" with this ID/name already exists.`
      });
      return;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const metadata = JSON.stringify({
      category: (category ?? "General").trim() || "General",
      notes: (notes ?? "").trim() || void 0
    });
    db.prepare(
      `INSERT INTO channels (id, channel_id, channel_name, is_selected, source_file, first_seen_at, last_updated_at, metadata_json)
     VALUES (?, ?, ?, 1, 'manual', ?, ?, ?)`
    ).run(channelKey, idClean || null, nameClean, now, now, metadata);
    logAudit({
      entityType: "CHANNEL",
      entityId: channelKey,
      action: "CHANNEL_CREATED",
      notes: `Added channel "${nameClean}"${idClean ? ` (ID: ${idClean})` : ""}`
    });
    res.status(201).json({
      ok: true,
      channel: {
        id: channelKey,
        channel_id: idClean || null,
        channel_name: nameClean
      }
    });
  });
  app2.post("/api/channels/bulk", requireRole(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "Provide at least one channel to add." });
      return;
    }
    const db = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let added = 0;
    let skipped = 0;
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO channels (id, channel_id, channel_name, is_selected, source_file, first_seen_at, last_updated_at, metadata_json)
     VALUES (?, ?, ?, 1, 'manual', ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      for (const item of items) {
        const nameClean = (item.channelName ?? "").trim();
        const idClean = (item.channelId ?? "").trim();
        if (!nameClean) continue;
        const channelKey = idClean ? `ch_id_${idClean.toLowerCase()}` : `ch_name_${nameClean.toLowerCase().replace(/\s+/g, "_")}`;
        const info = insertStmt.run(
          channelKey,
          idClean || null,
          nameClean,
          now,
          now,
          JSON.stringify({ category: (item.category ?? "General").trim() || "General" })
        );
        if (info.changes > 0) added++;
        else skipped++;
      }
    });
    tx();
    if (added > 0) {
      logAudit({
        entityType: "CHANNEL",
        entityId: "bulk",
        action: "CHANNELS_BULK_CREATED",
        notes: `Added ${added} channels manually (${skipped} skipped as duplicates).`
      });
    }
    res.status(201).json({ ok: true, added, skipped });
  });
  app2.post("/api/channels/sync", requireRole(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
    const { channels } = req.body;
    if (!Array.isArray(channels)) {
      res.status(400).json({ error: "channels array is required." });
      return;
    }
    const db = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const activeCloudIds = /* @__PURE__ */ new Set();
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
            category: ch.category || "General",
            notes: ch.notes || void 0,
            syncedFromCloud: true
          })
        );
      }
      const cloudRows = db.prepare(`SELECT id FROM channels WHERE source_file = 'cloud_sync'`).all();
      const countEntriesStmt = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE channel_key = ?`);
      const deleteStmt = db.prepare(`DELETE FROM channels WHERE id = ? AND source_file = 'cloud_sync'`);
      for (const row of cloudRows) {
        if (!activeCloudIds.has(row.id)) {
          const count = countEntriesStmt.get(row.id).c;
          if (count === 0) {
            deleteStmt.run(row.id);
          }
        }
      }
    });
    tx();
    res.json({ ok: true, syncedCount: activeCloudIds.size });
  });
  app2.delete("/api/channels/:channelKey", requireRole(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
    const db = getDb();
    const channelKey = req.params.channelKey;
    const channel = db.prepare(`SELECT channel_name FROM channels WHERE id = ?`).get(channelKey);
    if (!channel) {
      res.status(404).json({ error: "Channel not found." });
      return;
    }
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM qa_issues WHERE channel_key = ?`).run(channelKey);
      db.prepare(`DELETE FROM entries WHERE channel_key = ?`).run(channelKey);
      db.prepare(`DELETE FROM channels WHERE id = ?`).run(channelKey);
    });
    tx();
    logAudit({
      entityType: "CHANNEL",
      entityId: channelKey,
      action: "CHANNEL_DELETED",
      notes: `Deleted channel "${channel.channel_name}" and all associated entries and QA findings.`
    });
    res.json({ ok: true });
  });
  app2.get("/api/channels/:channelKey/entries", requireAuth, (req, res) => {
    const db = getDb();
    const { date, entryType, includeDeleted, search } = req.query;
    const where = ["channel_key = ?"];
    const params = [req.params.channelKey];
    if (includeDeleted !== "true") {
      where.push("is_deleted_record = 0");
    }
    if (typeof date === "string" && date.trim()) {
      where.push("trans_date = ?");
      params.push(date.trim());
    }
    if (typeof entryType === "string" && entryType.trim() && entryType !== "ALL") {
      const normalizedType = normalizeEntryType(entryType) ?? entryType.trim();
      where.push("entry_type = ?");
      params.push(normalizedType);
    }
    if (typeof search === "string" && search.trim()) {
      const q = `%${search.trim()}%`;
      where.push(
        `(COALESCE(caption_name,'') LIKE ? OR COALESCE(brand_name,'') LIKE ? OR COALESCE(category_name,'') LIKE ? OR COALESCE(master_entry_id,'') LIKE ? OR COALESCE(commercial_id,'') LIKE ?)`
      );
      params.push(q, q, q, q, q);
    }
    const entries = db.prepare(
      `SELECT * FROM entries
       WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(trans_date, '') ASC, COALESCE(start_seconds, 999999) ASC, COALESCE(start_index, 999999) ASC, id ASC`
    ).all(...params);
    const issues = db.prepare(`SELECT * FROM qa_issues WHERE channel_key = ? ORDER BY created_at DESC`).all(req.params.channelKey);
    res.json({ entries, issues });
  });
  app2.get("/api/entries", requireAuth, (req, res) => {
    const db = getDb();
    const {
      search,
      channelKey,
      date,
      entryType,
      qaStatus,
      includeDeleted,
      limit = "100",
      offset = "0"
    } = req.query;
    const where = [];
    const params = [];
    if (includeDeleted !== "true") {
      where.push("is_deleted_record = 0");
    }
    if (typeof channelKey === "string" && channelKey && channelKey !== "ALL") {
      where.push("channel_key = ?");
      params.push(channelKey);
    }
    if (typeof date === "string" && date) {
      where.push("trans_date = ?");
      params.push(date);
    }
    if (typeof entryType === "string" && entryType && entryType !== "ALL") {
      const normalizedType = normalizeEntryType(entryType) ?? entryType.trim();
      where.push("entry_type = ?");
      params.push(normalizedType);
    }
    if (typeof qaStatus === "string" && qaStatus && qaStatus !== "ALL") {
      where.push("qa_status = ?");
      params.push(qaStatus);
    }
    if (typeof search === "string" && search.trim()) {
      const q = `%${search.trim()}%`;
      where.push(
        `(COALESCE(channel_name,'') LIKE ? OR COALESCE(caption_name,'') LIKE ? OR COALESCE(brand_name,'') LIKE ? OR COALESCE(category_name,'') LIKE ? OR COALESCE(master_entry_id,'') LIKE ? OR COALESCE(commercial_id,'') LIKE ?)`
      );
      params.push(q, q, q, q, q, q);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM entries ${whereSql}`).get(...params);
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    const rows = db.prepare(
      `SELECT * FROM entries ${whereSql}
       ORDER BY COALESCE(trans_date, '') DESC, channel_name ASC, COALESCE(start_seconds, 999999) ASC
       LIMIT ? OFFSET ?`
    ).all(...params, lim, off);
    res.json({ total: totalRow.c, entries: rows });
  });
  app2.get("/api/entries/type-diagnostics", requireAuth, (_req, res) => {
    const rows = getDb().prepare(
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
    ).all();
    res.json(rows);
  });
  app2.post("/api/entries/reclassify", requireRole(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
    const db = getDb();
    const { rawValue, targetType } = req.body ?? {};
    if (rawValue && targetType) {
      const normalizedTarget = normalizeEntryType(targetType);
      if (!normalizedTarget) {
        res.status(400).json({ error: "Invalid targetType. Must be MEDIA, SPONSORSHIP, SPOT/TVC, or PROGRAM." });
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
      ).run(JSON.stringify(filtered), (/* @__PURE__ */ new Date()).toISOString());
    }
    const result = reclassifyStoredEntries({ log: true });
    res.json(result);
  });
  app2.get("/api/entries/:id", requireAuth, (req, res) => {
    const db = getDb();
    const entry = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Entry not found." });
      return;
    }
    const issues = db.prepare(`SELECT * FROM qa_issues WHERE entry_id = ?`).all(req.params.id);
    const auditLogs = db.prepare(`SELECT * FROM audit_logs WHERE entity_type = 'ENTRY' AND entity_id = ? ORDER BY timestamp DESC`).all(req.params.id);
    res.json({ entry, issues, auditLogs });
  });
  app2.patch("/api/entries/:id", requireRole(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Entry not found." });
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
      edit_notes
    } = req.body;
    const nextEntryType = typeof entry_type === "string" ? normalizeEntryType(entry_type) ?? existing.entry_type : existing.entry_type;
    const nextCategory = category_name !== void 0 ? category_name ? String(category_name) : null : existing.category_name;
    const nextSubcategory = subcategory_name !== void 0 ? subcategory_name ? String(subcategory_name) : null : existing.subcategory_name;
    const nextBrand = brand_name !== void 0 ? brand_name ? String(brand_name) : null : existing.brand_name;
    const nextCaption = caption_name !== void 0 ? caption_name ? String(caption_name) : null : existing.caption_name;
    let nextStartTime = existing.start_time;
    let nextStartSeconds = existing.start_seconds;
    if (start_time !== void 0) {
      const raw = start_time ? String(start_time) : "";
      const parsed = parseTimeToSeconds(raw);
      nextStartTime = parsed.normalized;
      nextStartSeconds = parsed.seconds;
    }
    let nextEndTime = existing.end_time;
    let nextEndSeconds = existing.end_seconds;
    if (end_time !== void 0) {
      const raw = end_time ? String(end_time) : "";
      const parsed = parseTimeToSeconds(raw);
      nextEndTime = parsed.normalized;
      nextEndSeconds = parsed.seconds;
    }
    let nextDuration = existing.duration_seconds;
    if (duration_seconds !== void 0 && duration_seconds !== null && duration_seconds !== "") {
      nextDuration = parseDurationToSeconds(String(duration_seconds)) ?? Number(duration_seconds);
    }
    const changes = [
      ["entry_type", existing.entry_type, nextEntryType],
      ["category_name", existing.category_name, nextCategory],
      ["subcategory_name", existing.subcategory_name, nextSubcategory],
      ["brand_name", existing.brand_name, nextBrand],
      ["caption_name", existing.caption_name, nextCaption],
      ["start_time", existing.start_time, nextStartTime],
      ["end_time", existing.end_time, nextEndTime],
      [
        "duration_seconds",
        existing.duration_seconds !== null ? String(existing.duration_seconds) : null,
        nextDuration !== null ? String(nextDuration) : null
      ]
    ];
    const now = (/* @__PURE__ */ new Date()).toISOString();
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
      if (nextEntryType !== existing.entry_type) {
        db.prepare(`UPDATE qa_issues SET entry_type = ? WHERE entry_id = ?`).run(nextEntryType, existing.id);
      }
      for (const [field, oldV, newV] of changes) {
        if (oldV !== newV) {
          logAudit({
            entityType: "ENTRY",
            entityId: existing.id,
            action: "ENTRY_EDITED",
            fieldName: field,
            oldValue: oldV,
            newValue: newV,
            notes: typeof edit_notes === "string" && edit_notes.trim() ? edit_notes.trim() : null
          });
        }
      }
    });
    tx();
    const updated = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(existing.id);
    const issues = db.prepare(`SELECT * FROM qa_issues WHERE entry_id = ?`).all(existing.id);
    const auditLogs = db.prepare(`SELECT * FROM audit_logs WHERE entity_type = 'ENTRY' AND entity_id = ? ORDER BY timestamp DESC`).all(existing.id);
    res.json({ entry: updated, issues, auditLogs });
  });
  app2.post("/api/entries/:id/reset", requireRole(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Entry not found." });
      return;
    }
    const orig = JSON.parse(existing.original_values_json);
    const restoredType = normalizeEntryType(orig.entryType) ?? "PROGRAM";
    const startParsed = parseTimeToSeconds(orig.startTime ?? void 0);
    const endParsed = parseTimeToSeconds(orig.endTime ?? void 0);
    const now = (/* @__PURE__ */ new Date()).toISOString();
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
      entityType: "ENTRY",
      entityId: existing.id,
      action: "ENTRY_RESTORED_ORIGINAL",
      notes: "Reverted manual edits back to immutable original XML snapshot."
    });
    const restored = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(existing.id);
    const issues = db.prepare(`SELECT * FROM qa_issues WHERE entry_id = ?`).all(existing.id);
    res.json({ entry: restored, issues });
  });
  app2.post("/api/qa/run", requireRole(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
    try {
      const { channelKey, transDate, thresholdsOverride } = req.body ?? {};
      const result = runAutomaticQa({
        channelKey: channelKey && channelKey !== "ALL" ? channelKey : void 0,
        transDate: transDate || void 0,
        thresholdsOverride
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "QA execution failed" });
    }
  });
  app2.get("/api/qa/runs", requireAuth, (_req, res) => {
    const runs = getDb().prepare(`SELECT * FROM qa_runs ORDER BY completed_at DESC LIMIT 20`).all();
    res.json(runs);
  });
  app2.get("/api/qa/issues", requireAuth, (req, res) => {
    const db = getDb();
    const {
      severity = "ALL",
      channelKey,
      date,
      entryType,
      resolutionStatus,
      search
    } = req.query;
    if (severity === "GREEN") {
      const where2 = ["is_deleted_record = 0", `qa_status = 'GREEN'`];
      const params2 = [];
      if (typeof channelKey === "string" && channelKey && channelKey !== "ALL") {
        where2.push("channel_key = ?");
        params2.push(channelKey);
      }
      if (typeof date === "string" && date) {
        where2.push("trans_date = ?");
        params2.push(date);
      }
      if (typeof entryType === "string" && entryType && entryType !== "ALL") {
        const normalizedType = normalizeEntryType(entryType) ?? entryType.trim();
        where2.push("entry_type = ?");
        params2.push(normalizedType);
      }
      if (typeof search === "string" && search.trim()) {
        const q = `%${search.trim()}%`;
        where2.push(
          `(COALESCE(caption_name,'') LIKE ? OR COALESCE(brand_name,'') LIKE ? OR COALESCE(channel_name,'') LIKE ?)`
        );
        params2.push(q, q, q);
      }
      const cleanEntries = db.prepare(
        `SELECT id AS entry_id, channel_key, channel_name, trans_date, entry_type,
                master_entry_id, segment_detail_id, category_name, subcategory_name,
                brand_name, caption_name, start_time, end_time, duration_seconds, raw_xml
         FROM entries
         WHERE ${where2.join(" AND ")}
         ORDER BY channel_name ASC, COALESCE(trans_date, '') DESC, COALESCE(start_seconds, 0) ASC
         LIMIT 300`
      ).all(...params2);
      const mapped = cleanEntries.map((e) => ({
        id: `green_${e.entry_id}`,
        qa_run_id: "clean",
        entry_id: e.entry_id,
        related_entry_id: null,
        channel_key: e.channel_key,
        channel_name: e.channel_name,
        trans_date: e.trans_date,
        entry_type: e.entry_type,
        severity: "GREEN",
        error_type: "No Issue Detected",
        rule_code: "PASS_ALL_CHECKS",
        reason: "Entry passed all configured structural, category, duration, and timeline checks.",
        confidence_level: "VERIFIED (Available Checks)",
        evidence_json: null,
        resolution_status: "RESOLVED",
        created_at: "",
        master_entry_id: e.master_entry_id,
        segment_detail_id: e.segment_detail_id,
        category_name: e.category_name,
        subcategory_name: e.subcategory_name,
        brand_name: e.brand_name,
        caption_name: e.caption_name,
        start_time: e.start_time,
        end_time: e.end_time,
        duration_seconds: e.duration_seconds,
        raw_xml: e.raw_xml
      }));
      res.json({ issues: mapped });
      return;
    }
    const where = [];
    const params = [];
    if (typeof severity === "string" && (severity === "RED" || severity === "YELLOW")) {
      where.push("q.severity = ?");
      params.push(severity);
    }
    if (typeof channelKey === "string" && channelKey && channelKey !== "ALL") {
      where.push("q.channel_key = ?");
      params.push(channelKey);
    }
    if (typeof date === "string" && date) {
      where.push("q.trans_date = ?");
      params.push(date);
    }
    if (typeof entryType === "string" && entryType && entryType !== "ALL") {
      const normalizedType = normalizeEntryType(entryType) ?? entryType.trim();
      where.push("COALESCE(e.entry_type, q.entry_type) = ?");
      params.push(normalizedType);
    }
    if (typeof resolutionStatus === "string" && resolutionStatus && resolutionStatus !== "ALL") {
      where.push("q.resolution_status = ?");
      params.push(resolutionStatus);
    }
    if (typeof search === "string" && search.trim()) {
      const q = `%${search.trim()}%`;
      where.push(
        `(q.channel_name LIKE ? OR q.error_type LIKE ? OR q.reason LIKE ? OR COALESCE(e.brand_name,'') LIKE ? OR COALESCE(e.caption_name,'') LIKE ? OR COALESCE(e.master_entry_id,'') LIKE ?)`
      );
      params.push(q, q, q, q, q, q);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const issues = db.prepare(
      `SELECT q.*, COALESCE(e.entry_type, q.entry_type) AS entry_type,
              e.master_entry_id, e.segment_detail_id, e.category_name, e.subcategory_name,
              e.brand_name, e.caption_name, e.start_time, e.end_time, e.duration_seconds, e.raw_xml
       FROM qa_issues q
       LEFT JOIN entries e ON e.id = q.entry_id
       ${whereSql}
       ORDER BY CASE q.severity WHEN 'RED' THEN 1 WHEN 'YELLOW' THEN 2 ELSE 3 END,
                q.channel_name ASC, COALESCE(q.trans_date, '') DESC, COALESCE(e.start_seconds, 999999) ASC
       LIMIT 500`
    ).all(...params);
    res.json({ issues });
  });
  app2.patch("/api/qa/issues/:id", requireRole(["SUPER_ADMIN", "ADMIN", "OPERATOR"]), (req, res) => {
    const db = getDb();
    const { resolution_status, notes } = req.body;
    const valid = /* @__PURE__ */ new Set(["OPEN", "REVIEWED", "RESOLVED", "IGNORED"]);
    if (!resolution_status || !valid.has(resolution_status)) {
      res.status(400).json({ error: "Invalid resolution_status." });
      return;
    }
    const existing = db.prepare(`SELECT id, resolution_status FROM qa_issues WHERE id = ?`).get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "QA Issue not found." });
      return;
    }
    db.prepare(`UPDATE qa_issues SET resolution_status = ? WHERE id = ?`).run(
      resolution_status,
      req.params.id
    );
    logAudit({
      entityType: "QA_ISSUE",
      entityId: req.params.id,
      action: "QA_RESOLUTION_CHANGED",
      fieldName: "resolution_status",
      oldValue: existing.resolution_status,
      newValue: resolution_status,
      notes: notes ?? null
    });
    res.json({ id: req.params.id, resolution_status });
  });
  app2.get("/api/reports/preview", requireAuth, (req, res) => {
    const db = getDb();
    const { channelKey, dateFrom, dateTo } = req.query;
    const entryWhere = ["is_deleted_record = 0"];
    const entryArgs = [];
    const issueWhere = [];
    const issueArgs = [];
    if (typeof channelKey === "string" && channelKey && channelKey !== "ALL") {
      entryWhere.push("channel_key = ?");
      entryArgs.push(channelKey);
      issueWhere.push("channel_key = ?");
      issueArgs.push(channelKey);
    }
    if (typeof dateFrom === "string" && dateFrom) {
      entryWhere.push("trans_date >= ?");
      entryArgs.push(dateFrom);
      issueWhere.push("trans_date >= ?");
      issueArgs.push(dateFrom);
    }
    if (typeof dateTo === "string" && dateTo) {
      entryWhere.push("trans_date <= ?");
      entryArgs.push(dateTo);
      issueWhere.push("trans_date <= ?");
      issueArgs.push(dateTo);
    }
    const entrySql = entryWhere.join(" AND ");
    const issueSql = issueWhere.length > 0 ? `AND ${issueWhere.join(" AND ")}` : "";
    const counts = db.prepare(
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
    ).get(...entryArgs);
    const dailyGroups = db.prepare(
      `SELECT COUNT(*) AS c FROM (
           SELECT channel_name, COALESCE(trans_date, 'Unspecified') FROM entries WHERE ${entrySql} GROUP BY 1, 2
         )`
    ).get(...entryArgs).c;
    const qaErrors = db.prepare(`SELECT COUNT(*) AS c FROM qa_issues WHERE severity = 'RED' ${issueSql}`).get(...issueArgs).c;
    const suspicious = db.prepare(`SELECT COUNT(*) AS c FROM qa_issues WHERE severity = 'YELLOW' ${issueSql}`).get(...issueArgs).c;
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
      daily_summary: dailyGroups
    });
  });
  app2.get("/api/reports/export", requireAuth, async (req, res) => {
    try {
      const reportType = req.query.reportType || "complete";
      const channelKey = typeof req.query.channelKey === "string" && req.query.channelKey !== "ALL" ? req.query.channelKey : void 0;
      const dateFrom = typeof req.query.dateFrom === "string" && req.query.dateFrom ? req.query.dateFrom : void 0;
      const dateTo = typeof req.query.dateTo === "string" && req.query.dateTo ? req.query.dateTo : void 0;
      const { buffer, fileName } = await generateExcelReport({
        reportType,
        channelKey,
        dateFrom,
        dateTo
      });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Excel export failed" });
    }
  });
  app2.get("/api/reports/export/csv", requireAuth, (req, res) => {
    try {
      const db = getDb();
      const reportType = req.query.reportType || "complete";
      const channelKey = typeof req.query.channelKey === "string" && req.query.channelKey !== "ALL" ? req.query.channelKey : void 0;
      const dateFrom = typeof req.query.dateFrom === "string" && req.query.dateFrom ? req.query.dateFrom : void 0;
      const dateTo = typeof req.query.dateTo === "string" && req.query.dateTo ? req.query.dateTo : void 0;
      const where = ["is_deleted_record = 0"];
      const args = [];
      if (channelKey) {
        where.push("channel_key = ?");
        args.push(channelKey);
      }
      if (dateFrom) {
        where.push("trans_date >= ?");
        args.push(dateFrom);
      }
      if (dateTo) {
        where.push("trans_date <= ?");
        args.push(dateTo);
      }
      if (reportType === "daily_summary") {
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
        FROM entries WHERE ${where.join(" AND ")}
        GROUP BY channel_name, trans_date
        ORDER BY channel_name, trans_date
      `).all(...args);
        const headers2 = [
          "Channel Name",
          "Broadcast Date",
          "Total Entries",
          "PROGRAM Count",
          "PROGRAM Duration (sec)",
          "SPOT/TVC Count",
          "SPOT/TVC Duration (sec)",
          "MEDIA Count",
          "MEDIA Duration (sec)",
          "SPONSORSHIP Count",
          "SPONSORSHIP Duration (sec)",
          "Total Airtime (sec)",
          "RED Errors",
          "YELLOW Warnings"
        ];
        const csvLines2 = [headers2.join(",")];
        for (const r of rows) {
          csvLines2.push([
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
            r.yellow_count
          ].join(","));
        }
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="Daily_Summary_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv"`);
        res.send(csvLines2.join("\r\n"));
        return;
      }
      if (reportType === "qa_errors" || reportType === "suspicious") {
        const sev = reportType === "qa_errors" ? "RED" : "YELLOW";
        const issWhere = ["q.severity = ?"];
        const issArgs = [sev];
        if (channelKey) {
          issWhere.push("q.channel_key = ?");
          issArgs.push(channelKey);
        }
        if (dateFrom) {
          issWhere.push("q.trans_date >= ?");
          issArgs.push(dateFrom);
        }
        if (dateTo) {
          issWhere.push("q.trans_date <= ?");
          issArgs.push(dateTo);
        }
        const issues = db.prepare(`
        SELECT q.*, COALESCE(e.entry_type, q.entry_type) AS entry_type
        FROM qa_issues q
        LEFT JOIN entries e ON e.id = q.entry_id
        WHERE ${issWhere.join(" AND ")}
        ORDER BY q.created_at DESC
      `).all(...issArgs);
        const headers2 = ["Issue ID", "Severity", "Content Category", "Rule Code", "Error Type", "Channel", "Date", "Reason", "Status", "Timestamp"];
        const csvLines2 = [headers2.join(",")];
        for (const i of issues) {
          csvLines2.push([
            `"${i.id}"`,
            `"${i.severity}"`,
            `"${(i.entry_type || "").replace(/"/g, '""')}"`,
            `"${i.rule_code}"`,
            `"${(i.error_type || "").replace(/"/g, '""')}"`,
            `"${(i.channel_name || "").replace(/"/g, '""')}"`,
            `"${i.trans_date || ""}"`,
            `"${(i.reason || "").replace(/"/g, '""')}"`,
            `"${i.resolution_status}"`,
            `"${i.created_at}"`
          ].join(","));
        }
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="QA_${sev}_Report_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv"`);
        res.send(csvLines2.join("\r\n"));
        return;
      }
      if (reportType === "spot_tvc" || reportType === "advertisements") where.push("entry_type = 'SPOT/TVC'");
      else if (reportType === "programs") where.push("entry_type = 'PROGRAM'");
      else if (reportType === "media" || reportType === "promos") where.push("entry_type = 'MEDIA'");
      else if (reportType === "sponsorship" || reportType === "spns") where.push("entry_type = 'SPONSORSHIP'");
      const entries = db.prepare(`
      SELECT channel_name, trans_date, start_time, end_time, duration_seconds, entry_type,
             caption_name, brand_name, category_name, subcategory_name, commercial_id, master_entry_id, qa_status
      FROM entries WHERE ${where.join(" AND ")}
      ORDER BY channel_name, trans_date, start_seconds
    `).all(...args);
      const headers = ["Channel", "Date", "Start Time", "End Time", "Duration (sec)", "Content Category", "Caption", "Brand", "XML Category", "Subcategory", "Commercial ID", "Master Entry ID", "QA Status"];
      const csvLines = [headers.join(",")];
      for (const e of entries) {
        csvLines.push([
          `"${(e.channel_name || "").replace(/"/g, '""')}"`,
          `"${e.trans_date || ""}"`,
          `"${e.start_time || ""}"`,
          `"${e.end_time || ""}"`,
          e.duration_seconds || 0,
          `"${e.entry_type || ""}"`,
          `"${(e.caption_name || "").replace(/"/g, '""')}"`,
          `"${(e.brand_name || "").replace(/"/g, '""')}"`,
          `"${(e.category_name || "").replace(/"/g, '""')}"`,
          `"${(e.subcategory_name || "").replace(/"/g, '""')}"`,
          `"${e.commercial_id || ""}"`,
          `"${e.master_entry_id || ""}"`,
          `"${e.qa_status || ""}"`
        ].join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="Broadcast_Report_${reportType}_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv"`);
      res.send(csvLines.join("\r\n"));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "CSV export failed" });
    }
  });
  app2.get("/api/backups", requireRole(["SUPER_ADMIN", "ADMIN"]), (_req, res) => {
    const db = getDb();
    const backups = db.prepare(`SELECT * FROM backups ORDER BY created_at DESC`).all();
    const dbSizeBytes = fs6.existsSync(DB_PATH) ? fs6.statSync(DB_PATH).size : 0;
    const xmlArchiveBytes = getDirectorySize(XML_ARCHIVE_DIR);
    const archiveFileCount = db.prepare(`SELECT COUNT(*) AS c FROM xml_archive_files`).get().c;
    const totalEntries = db.prepare(`SELECT COUNT(*) AS c FROM entries`).get().c;
    res.json({
      backups,
      storage: {
        dbPath: DB_PATH,
        dbSizeBytes,
        xmlArchiveBytes,
        archiveFileCount,
        totalEntries
      }
    });
  });
  app2.post("/api/backups", requireRole(["SUPER_ADMIN", "ADMIN"]), async (_req, res) => {
    try {
      const backup = await createDatabaseBackup("MANUAL");
      res.json(backup);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Backup creation failed" });
    }
  });
  app2.get("/api/backups/:id/download", requireRole(["SUPER_ADMIN", "ADMIN"]), (req, res) => {
    const backup = getDb().prepare(`SELECT file_name, file_path FROM backups WHERE id = ?`).get(req.params.id);
    if (!backup || !fs6.existsSync(backup.file_path)) {
      res.status(404).json({ error: "Backup file not found." });
      return;
    }
    res.download(backup.file_path, backup.file_name);
  });
  app2.post("/api/backups/:id/restore", requireRole(["SUPER_ADMIN", "ADMIN"]), async (req, res) => {
    try {
      const db = getDb();
      const backup = db.prepare(`SELECT id, file_name, file_path FROM backups WHERE id = ?`).get(req.params.id);
      if (!backup || !fs6.existsSync(backup.file_path)) {
        res.status(404).json({ error: "Backup file not found." });
        return;
      }
      await createDatabaseBackup("PRE_RESTORE");
      db.close();
      fs6.copyFileSync(backup.file_path, DB_PATH);
      reopenDatabase();
      logAudit({
        entityType: "BACKUP",
        entityId: backup.id,
        action: "DATABASE_RESTORED",
        newValue: backup.file_name
      });
      res.json({ ok: true, restoredFrom: backup.file_name });
    } catch (err) {
      reopenDatabase();
      res.status(500).json({ error: err instanceof Error ? err.message : "Restore failed" });
    }
  });
  app2.post("/api/backups/upload-restore", requireRole(["SUPER_ADMIN", "ADMIN"]), upload.single("backupFile"), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "No .db backup file uploaded." });
        return;
      }
      const header = file.buffer.subarray(0, 16).toString("utf8");
      if (!header.startsWith("SQLite format 3")) {
        res.status(400).json({ error: "Uploaded file is not a valid SQLite 3 database." });
        return;
      }
      await createDatabaseBackup("PRE_RESTORE");
      getDb().close();
      fs6.writeFileSync(DB_PATH, file.buffer);
      reopenDatabase();
      logAudit({
        entityType: "BACKUP",
        entityId: "uploaded_file",
        action: "DATABASE_RESTORED_FROM_FILE",
        newValue: file.originalname
      });
      res.json({ ok: true, restoredFrom: file.originalname });
    } catch (err) {
      reopenDatabase();
      res.status(500).json({ error: err instanceof Error ? err.message : "Restore failed" });
    }
  });
  app2.get("/api/audit-logs", requireRole(["SUPER_ADMIN", "ADMIN"]), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 150, 500);
    const logs = getDb().prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?`).all(limit);
    res.json(logs);
  });
  app2.get("/api/settings", requireAuth, (_req, res) => {
    res.json({
      qaThresholds: getQaThresholds(),
      customFieldMappings: getCustomFieldMappings(),
      customEntryTypeMappings: getCustomEntryTypeMappings()
    });
  });
  app2.put("/api/settings", requireRole(["SUPER_ADMIN", "ADMIN"]), (req, res) => {
    const db = getDb();
    const { qaThresholds, customFieldMappings, customEntryTypeMappings } = req.body;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (qaThresholds) {
      const merged = { ...getQaThresholds(), ...qaThresholds };
      db.prepare(
        `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('qa_thresholds', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      ).run(JSON.stringify(merged), now);
      logAudit({
        entityType: "SETTINGS",
        entityId: "qa_thresholds",
        action: "SETTINGS_UPDATED",
        newValue: JSON.stringify(merged)
      });
    }
    if (Array.isArray(customFieldMappings)) {
      db.prepare(
        `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('custom_field_mappings', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      ).run(JSON.stringify(customFieldMappings), now);
      logAudit({
        entityType: "SETTINGS",
        entityId: "custom_field_mappings",
        action: "FIELD_MAPPINGS_UPDATED",
        newValue: `${customFieldMappings.length} mappings`
      });
    }
    if (Array.isArray(customEntryTypeMappings)) {
      const cleaned = customEntryTypeMappings.map((m) => ({
        rawValue: m.rawValue?.trim() ?? "",
        targetType: normalizeEntryType(m.targetType) ?? ""
      })).filter((m) => m.rawValue && m.targetType);
      db.prepare(
        `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('custom_entry_type_mappings', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      ).run(JSON.stringify(cleaned), now);
      reclassifyStoredEntries({ log: true });
    }
    res.json({
      qaThresholds: getQaThresholds(),
      customFieldMappings: getCustomFieldMappings(),
      customEntryTypeMappings: getCustomEntryTypeMappings()
    });
  });
  app2.use("/api", (_req, res) => {
    res.status(404).json({ error: "API endpoint not found." });
  });
  return app2;
}

// server/vercelEntry.ts
var app = createApiApp();
function handler(req, res) {
  try {
    const rawUrl = req.url || "/";
    const parsed = new URL(rawUrl, "http://localhost");
    const routedPath = parsed.searchParams.get("__route");
    if (routedPath !== null) {
      parsed.searchParams.delete("__route");
      const cleanRoute = routedPath.replace(/^\/+/, "");
      const qs = parsed.searchParams.toString();
      req.url = `/api/${cleanRoute}${qs ? `?${qs}` : ""}`;
    }
  } catch {
  }
  return app(req, res);
}
export {
  handler as default
};
