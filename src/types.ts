export type EntryType = 'MEDIA' | 'SPONSORSHIP' | 'SPOT/TVC' | 'PROGRAM';
export type QaSeverity = 'RED' | 'YELLOW' | 'GREEN';
export type EntryQaStatus = 'PENDING' | 'GREEN' | 'YELLOW' | 'RED';
export type IssueResolutionStatus = 'OPEN' | 'REVIEWED' | 'RESOLVED' | 'IGNORED';

export type FileRole =
  | 'metadata'
  | 'tcommercial'
  | 'trcommercial'
  | 'trschedule'
  | 'trschedule_deleted'
  | 'selectedchannels'
  | 'reviewed_captions'
  | 'schema_only'
  | 'unknown'
  | 'invalid';

export interface QaThresholds {
  gapThresholdSeconds: number;
  overlapToleranceSeconds: number;
  durationToleranceStrictSeconds: number;
  durationToleranceWarnSeconds: number;
  duplicateWindowSeconds: number;
  minAdDurationSeconds: number;
  maxAdDurationSeconds: number;
  minProgramDurationSeconds: number;
  maxProgramDurationSeconds: number;
  minPromoDurationSeconds: number;
  maxPromoDurationSeconds: number;
  minSpnDurationSeconds: number;
  maxSpnDurationSeconds: number;
  minMatchCoverage: number;
  defaultFps: number;
  autoBackupBeforeImport: boolean;
}

export interface CustomFieldMapping {
  sourceTag: string;
  canonicalField: string;
}

export interface DashboardMetrics {
  totalChannels: number;
  importedChannels: number;
  storageUsageBytes: number;
  totalEntries: number;
  programs: number;
  spotTvcs: number;
  media: number;
  sponsorships: number;
  programDurationSec: number;
  spotTvcDurationSec: number;
  mediaDurationSec: number;
  sponsorshipDurationSec: number;
  suspiciousEntries: number;
  redErrorEntries: number;
  greenEntries: number;
  missingSequenceWarnings: number;
  duplicateEntries: number;
  durationErrors: number;
  pendingQa: number;
  deletedRecordsCount: number;
  reviewedCaptionsCount: number;
}

export interface ChannelSummary {
  id: string;
  channel_id: string | null;
  channel_name: string;
  is_selected: number;
  source_file: string | null;
  first_seen_at: string;
  last_updated_at: string;
  entry_count: number;
  program_count: number;
  spot_tvc_count: number;
  media_count: number;
  sponsorship_count: number;
  program_duration_sec: number;
  spot_tvc_duration_sec: number;
  media_duration_sec: number;
  sponsorship_duration_sec: number;
  red_count: number;
  yellow_count: number;
  green_count: number;
  pending_count: number;
  dates: string[];
}

export interface ChannelEntry {
  id: string;
  dedup_fingerprint: string;
  batch_id: string;
  source_file_id: string;
  source_role: string;
  is_deleted_record: number;
  is_reviewed_caption: number;
  channel_key: string;
  channel_id: string | null;
  channel_name: string;
  trans_date: string | null;
  raw_trans_date: string | null;
  entry_type: EntryType;
  raw_entry_type: string | null;
  master_entry_id: string | null;
  segment_detail_id: string | null;
  commercial_id: string | null;
  commercial_type_id: string | null;
  commercial_type_name: string | null;
  caption_id: string | null;
  caption_name: string | null;
  brand_id: string | null;
  brand_name: string | null;
  company_name: string | null;
  category_id: string | null;
  category_name: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
  start_time: string | null;
  end_time: string | null;
  start_seconds: number | null;
  end_seconds: number | null;
  duration_seconds: number | null;
  raw_duration: string | null;
  source_duration: number | null;
  custom_duration: number | null;
  start_index: number | null;
  end_index: number | null;
  diff_in_index: number | null;
  start_frame: number | null;
  end_frame: number | null;
  start_time_tts: string | null;
  end_time_tts: string | null;
  video_clip_id: string | null;
  video_file_name: string | null;
  file_path: string | null;
  action: string | null;
  left_adjust: number | null;
  right_adjust: number | null;
  quality_id: string | null;
  match_value: number | null;
  match_coverage: number | null;
  fdb: string | null;
  is_benchmarked: string | null;
  txt: string | null;
  extra_fields_json: string | null;
  original_values_json: string;
  raw_xml: string;
  is_manually_edited: number;
  qa_status: EntryQaStatus;
  updated_at: string;
}

export interface QaIssue {
  id: string;
  qa_run_id: string;
  entry_id: string;
  related_entry_id: string | null;
  channel_key: string;
  channel_name: string;
  trans_date: string | null;
  entry_type: EntryType;
  severity: QaSeverity;
  error_type: string;
  rule_code: string;
  reason: string;
  confidence_level: string;
  evidence_json: string | null;
  resolution_status: IssueResolutionStatus;
  created_at: string;
  // Joined entry context
  master_entry_id?: string | null;
  segment_detail_id?: string | null;
  category_name?: string | null;
  subcategory_name?: string | null;
  brand_name?: string | null;
  caption_name?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  duration_seconds?: number | null;
  raw_xml?: string | null;
}

export interface QaRun {
  id: string;
  started_at: string;
  completed_at: string;
  scope: string;
  total_analyzed: number;
  red_count: number;
  yellow_count: number;
  green_count: number;
  rules_config_json: string;
}

export interface ImportBatch {
  id: string;
  folder_name: string;
  imported_at: string;
  file_count: number;
  schema_file_count: number;
  data_file_count: number;
  records_inserted: number;
  records_updated: number;
  records_skipped_duplicate: number;
  error_count: number;
  content_hash: string;
  status: string;
  notes: string | null;
}

export interface XmlArchiveFile {
  id: string;
  batch_id: string;
  relative_path: string;
  file_name: string;
  file_size: number;
  sha256: string;
  detected_role: FileRole;
  has_inline_schema: number;
  root_element: string | null;
  record_element: string | null;
  record_count: number;
  schema_fields_json: string | null;
  unmapped_fields_json: string | null;
  parse_errors_json: string | null;
  archive_path: string;
}

export interface InspectedXmlFile {
  relativePath: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  isXml: boolean;
  detectedRole: FileRole;
  hasInlineSchema: boolean;
  rootElement: string | null;
  recordElement: string | null;
  recordCount: number;
  schemaFields: Array<{ name: string; type: string }>;
  mappedFields: Array<{ xmlTag: string; canonicalField: string; sampleValue: string }>;
  unmappedFields: Array<{ xmlTag: string; sampleValue: string }>;
  parseErrors: string[];
  alreadyImported: boolean;
}

export interface AuditLogItem {
  id: number;
  timestamp: string;
  entity_type: string;
  entity_id: string;
  action: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  notes: string | null;
}

export interface BackupItem {
  id: string;
  file_name: string;
  file_path: string;
  size_bytes: number;
  trigger_type: string;
  created_at: string;
  entry_count: number;
  channel_count: number;
}
