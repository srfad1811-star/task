import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { InspectedXmlFile } from '../src/types.ts';
import {
  XML_ARCHIVE_DIR,
  createDatabaseBackup,
  getCustomFieldMappings,
  getDb,
  getQaThresholds,
  logAudit,
} from './db.ts';
import { buildCustomTypeMap } from './reclassify.ts';
import { type ParsedRecord, parseAutosaveXmlBuffer } from './xmlParser.ts';

export interface UploadedFileInput {
  originalName: string;
  relativePath: string;
  buffer: Buffer;
}

function toNum(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

function toInt(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function deriveChannelKey(channelId: string | undefined, channelName: string | undefined): string {
  const idClean = channelId?.trim();
  const nameClean = channelName?.trim();
  if (idClean) return `ch_id_${idClean.toLowerCase()}`;
  if (nameClean) return `ch_name_${nameClean.toLowerCase().replace(/\s+/g, '_')}`;
  return 'ch_unknown';
}

function buildRecordFingerprint(rec: ParsedRecord, role: string, channelKey: string): string {
  const c = rec.canonical;
  // Use deterministic structural identity when IDs exist, else full canonical + start/end content hash
  const keyParts = [
    role,
    channelKey,
    c.MasterEntryID ?? '',
    c.segmentDetailID ?? '',
    rec.transDate ?? c.transDate ?? '',
    c.startTime ?? '',
    c.endTime ?? '',
    c.commercialID ?? '',
    c.captionID ?? '',
    c.captionName ?? '',
    c.brandName ?? '',
    c.startIndex ?? '',
    c.endIndex ?? '',
    c.Action ?? '',
  ];
  return crypto.createHash('sha256').update(keyParts.join('|')).digest('hex');
}

export function inspectAutosaveFiles(files: UploadedFileInput[]): {
  folderName: string;
  files: InspectedXmlFile[];
  totalRecords: number;
  schemaFiles: number;
  dataFiles: number;
  errorFiles: number;
  duplicateFiles: number;
} {
  const db = getDb();
  const existingHashes = new Set<string>(
    (db.prepare(`SELECT DISTINCT sha256 FROM xml_archive_files`).all() as Array<{ sha256: string }>).map(
      (r) => r.sha256
    )
  );
  const customMappings = getCustomFieldMappings();
  const customTypeMap = buildCustomTypeMap();

  let folderName = 'autosave_upload';
  if (files.length > 0 && files[0].relativePath.includes('/')) {
    folderName = files[0].relativePath.split('/')[0] || 'autosave_upload';
  }

  const inspected: InspectedXmlFile[] = [];
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
      customTypeMap,
    });
    inspected.push(parsed.inspection);
    totalRecords += parsed.inspection.recordCount;
    if (parsed.inspection.detectedRole === 'schema_only') schemaFiles++;
    else if (parsed.inspection.recordCount > 0 || parsed.inspection.detectedRole === 'metadata') dataFiles++;
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
    duplicateFiles,
  };
}

export async function commitAutosaveImport(params: {
  files: UploadedFileInput[];
  folderName?: string;
  notes?: string;
  forceReprocessDuplicates?: boolean;
}): Promise<{
  batchId: string;
  folderName: string;
  fileCount: number;
  schemaFileCount: number;
  dataFileCount: number;
  recordsInserted: number;
  recordsUpdated: number;
  recordsSkippedDuplicate: number;
  errorCount: number;
  inspectedFiles: InspectedXmlFile[];
}> {
  const db = getDb();
  const thresholds = getQaThresholds();
  const existingEntryCount = (db.prepare(`SELECT COUNT(*) AS c FROM entries`).get() as { c: number }).c;

  if (thresholds.autoBackupBeforeImport && existingEntryCount > 0) {
    await createDatabaseBackup('AUTO_PRE_IMPORT');
  }

  const batchId = `imp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const batchArchiveDir = path.join(XML_ARCHIVE_DIR, batchId);
  fs.mkdirSync(batchArchiveDir, { recursive: true });

  const existingHashes = new Set<string>(
    (db.prepare(`SELECT DISTINCT sha256 FROM xml_archive_files`).all() as Array<{ sha256: string }>).map(
      (r) => r.sha256
    )
  );
  const customMappings = getCustomFieldMappings();
  const customTypeMap = buildCustomTypeMap();

  let folderName = params.folderName?.trim() || 'autosave_import';
  if (!params.folderName && params.files.length > 0 && params.files[0].relativePath.includes('/')) {
    folderName = params.files[0].relativePath.split('/')[0] || folderName;
  }

  const parsedResults = params.files.map((file) => {
    const res = parseAutosaveXmlBuffer({
      buffer: file.buffer,
      fileName: file.originalName,
      relativePath: file.relativePath,
      customMappings,
      existingFileHashes: existingHashes,
      customTypeMap,
    });
    return { file, res };
  });

  const combinedHash = crypto
    .createHash('sha256')
    .update(parsedResults.map((r) => r.res.inspection.sha256).sort().join(':'))
    .digest('hex');

  const importedAt = new Date().toISOString();
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
      const safeRelPath = file.relativePath.replace(/^[/.\\]+/, '').replace(/\.\./g, '_');
      const archiveFilePath = path.join(batchArchiveDir, safeRelPath || file.originalName);
      fs.mkdirSync(path.dirname(archiveFilePath), { recursive: true });
      fs.writeFileSync(archiveFilePath, file.buffer);

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

      if (insp.detectedRole === 'schema_only') {
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

      if (insp.recordCount > 0 || insp.detectedRole === 'metadata') {
        dataFileCount++;
      }

      if (insp.alreadyImported && !params.forceReprocessDuplicates) {
        recordsSkippedDuplicate += insp.recordCount;
        continue;
      }

      // Process selected channels file
      if (insp.detectedRole === 'selectedchannels') {
        for (const rec of res.records) {
          const chId = rec.canonical.channelID || null;
          const chName = rec.canonical.channelName || (chId ? `Channel ${chId}` : 'Unknown Channel');
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

      // Process commercial master catalog
      if (insp.detectedRole === 'tcommercial') {
        for (const rec of res.records) {
          const c = rec.canonical;
          const catId = `cat_${crypto
            .createHash('sha256')
            .update(`${c.commercialID ?? ''}|${c.captionID ?? ''}|${c.brandID ?? ''}|${c.captionName ?? ''}`)
            .digest('hex')
            .slice(0, 20)}`;
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

      if (insp.detectedRole === 'metadata') {
        continue;
      }

      // Process schedule / commercial log / deleted / reviewed captions / generic records
      const isDeleted = insp.detectedRole === 'trschedule_deleted' ? 1 : 0;
      const isReviewed = insp.detectedRole === 'reviewed_captions' ? 1 : 0;

      for (const rec of res.records) {
        const c = rec.canonical;
        const chId = c.channelID || null;
        const chName = c.channelName || (chId ? `Channel ${chId}` : 'Unassigned Channel');
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
        const existing = findEntryByFingerprint.get(fingerprint) as
          | { id: string; is_manually_edited: number; raw_xml: string }
          | undefined;

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
          rawFields: c,
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

    const status = errorCount > 0 && recordsInserted === 0 ? 'failed' : errorCount > 0 ? 'partial' : 'completed';
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
    entityType: 'IMPORT',
    entityId: batchId,
    action: 'AUTOSAVE_IMPORTED',
    newValue: `${recordsInserted} inserted, ${recordsUpdated} updated, ${recordsSkippedDuplicate} skipped`,
    notes: `Folder: ${folderName} (${params.files.length} files)`,
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
    inspectedFiles: parsedResults.map((p) => p.res.inspection),
  };
}
