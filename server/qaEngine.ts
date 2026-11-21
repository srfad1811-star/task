import type {
  ChannelEntry,
  QaSeverity,
  QaThresholds,
} from '../src/types.ts';
import { getDb, getQaThresholds, logAudit } from './db.ts';

interface DraftIssue {
  entryId: string;
  relatedEntryId: string | null;
  channelKey: string;
  channelName: string;
  transDate: string | null;
  entryType: ChannelEntry['entry_type'];
  severity: QaSeverity;
  errorType: string;
  ruleCode: string;
  reason: string;
  confidenceLevel: string;
  evidence: Record<string, unknown>;
}

interface CatalogRow {
  commercial_id: string | null;
  caption_id: string | null;
  caption_name: string | null;
  brand_id: string | null;
  brand_name: string | null;
  category_name: string | null;
  source_duration: number | null;
  custom_duration: number | null;
}

function effectiveDuration(entry: ChannelEntry): number | null {
  if (entry.duration_seconds !== null && Number.isFinite(entry.duration_seconds)) {
    return entry.duration_seconds;
  }
  if (entry.start_seconds !== null && entry.end_seconds !== null) {
    let diff = entry.end_seconds - entry.start_seconds;
    if (diff < 0 && entry.start_seconds >= 20 * 3600 && entry.end_seconds <= 6 * 3600) {
      diff += 86400;
    }
    return Math.round(diff * 1000) / 1000;
  }
  return null;
}

function effectiveEndSeconds(entry: ChannelEntry): number | null {
  if (entry.end_seconds === null) return null;
  if (
    entry.start_seconds !== null &&
    entry.end_seconds < entry.start_seconds &&
    entry.start_seconds >= 20 * 3600 &&
    entry.end_seconds <= 6 * 3600
  ) {
    return entry.end_seconds + 86400;
  }
  return entry.end_seconds;
}

function normStr(v: string | null | undefined): string {
  return (v ?? '').trim().toUpperCase();
}

export function runAutomaticQa(options?: {
  channelKey?: string;
  transDate?: string;
  thresholdsOverride?: Partial<QaThresholds>;
}): {
  qaRunId: string;
  totalAnalyzed: number;
  redCount: number;
  yellowCount: number;
  greenCount: number;
  issuesCreated: number;
} {
  const db = getDb();
  const thresholds: QaThresholds = {
    ...getQaThresholds(),
    ...(options?.thresholdsOverride ?? {}),
  };

  const startedAt = new Date().toISOString();
  const qaRunId = `qarun_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const whereClauses = ['is_deleted_record = 0'];
  const queryParams: unknown[] = [];
  if (options?.channelKey) {
    whereClauses.push('channel_key = ?');
    queryParams.push(options.channelKey);
  }
  if (options?.transDate) {
    whereClauses.push('trans_date = ?');
    queryParams.push(options.transDate);
  }

  const entries = db
    .prepare(
      `SELECT * FROM entries
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY channel_key ASC, COALESCE(trans_date, '') ASC, COALESCE(start_seconds, 999999) ASC, COALESCE(start_index, 999999) ASC, id ASC`
    )
    .all(...queryParams) as ChannelEntry[];

  const deletedRecords = db
    .prepare(`SELECT * FROM entries WHERE is_deleted_record = 1`)
    .all() as ChannelEntry[];

  const deletedByChannelDate = new Map<string, ChannelEntry[]>();
  for (const d of deletedRecords) {
    const key = `${d.channel_key}::${d.trans_date ?? 'NODATE'}`;
    const arr = deletedByChannelDate.get(key) ?? [];
    arr.push(d);
    deletedByChannelDate.set(key, arr);
  }

  const catalogRows = db.prepare(`SELECT * FROM commercial_catalog`).all() as CatalogRow[];
  const catalogByCommId = new Map<string, CatalogRow>();
  for (const row of catalogRows) {
    if (row.commercial_id) {
      catalogByCommId.set(normStr(row.commercial_id), row);
    }
  }

  // Track commercialID -> set of brandNames across active entries to spot inconsistencies
  const commercialBrandMap = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.commercial_id && e.brand_name) {
      const cid = normStr(e.commercial_id);
      const set = commercialBrandMap.get(cid) ?? new Set<string>();
      set.add(normStr(e.brand_name));
      commercialBrandMap.set(cid, set);
    }
  }

  // Group active entries by channel_key + trans_date
  const groups = new Map<string, ChannelEntry[]>();
  for (const e of entries) {
    const key = `${e.channel_key}::${e.trans_date ?? 'NODATE'}`;
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }

  const draftIssues: DraftIssue[] = [];

  for (const [groupKey, groupEntries] of groups.entries()) {
    const deletedInGroup = deletedByChannelDate.get(groupKey) ?? [];

    // Check if siblings carry sequence IDs so missing sequence checks have context
    const siblingHasMasterId = groupEntries.some((x) => Boolean(x.master_entry_id));
    const siblingHasStartIndex = groupEntries.some((x) => x.start_index !== null);

    for (let i = 0; i < groupEntries.length; i++) {
      const curr = groupEntries[i];
      const prev = i > 0 ? groupEntries[i - 1] : null;
      const next = i + 1 < groupEntries.length ? groupEntries[i + 1] : null;

      const pushIssue = (
        severity: QaSeverity,
        errorType: string,
        ruleCode: string,
        reason: string,
        confidenceLevel: string,
        evidence: Record<string, unknown>,
        relatedEntryId: string | null = null
      ) => {
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
          evidence,
        });
      };

      const currEffEnd = effectiveEndSeconds(curr);
      const currDur = effectiveDuration(curr);
      const catUpper = normStr(curr.category_name);
      const subCatUpper = normStr(curr.subcategory_name);

      // -----------------------------------------------------------------
      // E. TIMELINE & FRAME CONSISTENCY CHECKS
      // -----------------------------------------------------------------
      if (curr.start_seconds === null || curr.end_seconds === null) {
        pushIssue(
          'YELLOW',
          'Missing Timeline Bounds',
          'TL_MISSING_TIMESTAMPS',
          `Entry is missing parseable startTime (${curr.start_time ?? 'null'}) or endTime (${curr.end_time ?? 'null'}).`,
          'MEDIUM (Missing Fields)',
          { startTime: curr.start_time, endTime: curr.end_time }
        );
      } else if (currEffEnd !== null && currEffEnd < curr.start_seconds) {
        pushIssue(
          'RED',
          'Invalid Time Range',
          'TL_INVALID_TIME_RANGE',
          `End time (${curr.end_time}) is earlier than Start time (${curr.start_time}).`,
          'HIGH (Structural)',
          { startTime: curr.start_time, endTime: curr.end_time, startSeconds: curr.start_seconds, endSeconds: curr.end_seconds }
        );
      }

      if (
        curr.start_seconds !== null &&
        currEffEnd !== null &&
        currEffEnd >= curr.start_seconds &&
        curr.duration_seconds !== null
      ) {
        const computedSpan = Math.round((currEffEnd - curr.start_seconds) * 1000) / 1000;
        const diff = Math.abs(computedSpan - curr.duration_seconds);
        if (diff > thresholds.durationToleranceStrictSeconds) {
          pushIssue(
            'RED',
            'Duration Error',
            'TL_DURATION_MISMATCH',
            `Recorded Duration (${curr.duration_seconds}s) differs from (endTime - startTime) (${computedSpan}s) by ${diff.toFixed(2)}s.`,
            'HIGH (Structural)',
            { recordedDuration: curr.duration_seconds, computedSpan, diffSeconds: diff }
          );
        } else if (diff > thresholds.durationToleranceWarnSeconds) {
          pushIssue(
            'YELLOW',
            'Duration Variance',
            'TL_DURATION_VARIANCE',
            `Recorded Duration (${curr.duration_seconds}s) differs from (endTime - startTime) (${computedSpan}s) by ${diff.toFixed(2)}s.`,
            'MEDIUM (Timing Tolerance)',
            { recordedDuration: curr.duration_seconds, computedSpan, diffSeconds: diff }
          );
        }
      }

      // Frame & Index checks
      if (curr.start_frame !== null && curr.end_frame !== null && curr.end_frame < curr.start_frame) {
        pushIssue(
          'RED',
          'Invalid Frame Sequence',
          'TL_INVALID_FRAME_RANGE',
          `endFrame (${curr.end_frame}) is smaller than startFrame (${curr.start_frame}).`,
          'HIGH (Structural)',
          { startFrame: curr.start_frame, endFrame: curr.end_frame }
        );
      }
      if (curr.start_index !== null && curr.end_index !== null) {
        if (curr.end_index < curr.start_index) {
          pushIssue(
            'RED',
            'Invalid Index Sequence',
            'TL_INVALID_INDEX_RANGE',
            `endIndex (${curr.end_index}) is smaller than startIndex (${curr.start_index}).`,
            'HIGH (Structural)',
            { startIndex: curr.start_index, endIndex: curr.end_index }
          );
        } else if (curr.diff_in_index !== null) {
          const expectedDiff = curr.end_index - curr.start_index;
          if (Math.abs(expectedDiff - curr.diff_in_index) > 1) {
            pushIssue(
              'YELLOW',
              'Index Difference Mismatch',
              'TL_DIFF_IN_INDEX_MISMATCH',
              `DiffInIndex (${curr.diff_in_index}) does not match endIndex - startIndex (${expectedDiff}).`,
              'MEDIUM (Structural)',
              { startIndex: curr.start_index, endIndex: curr.end_index, diffInIndex: curr.diff_in_index, expectedDiff }
            );
          }
        }
      }

      // Consecutive Timeline Overlap & Gap Checks
      if (prev && prev.start_seconds !== null && curr.start_seconds !== null) {
        const prevEffEnd = effectiveEndSeconds(prev);
        if (prevEffEnd !== null) {
          const gap = curr.start_seconds - prevEffEnd;
          if (gap < -thresholds.overlapToleranceSeconds) {
            const overlapSec = Math.abs(gap);
            const isProgOverlap = curr.entry_type === 'PROGRAM' && prev.entry_type === 'PROGRAM';
            pushIssue(
              'RED',
              isProgOverlap ? 'Overlapping Program Entries' : 'Overlapping Entries',
              isProgOverlap ? 'PROG_OVERLAPPING' : 'TL_OVERLAPPING_ENTRIES',
              `Entry starts at ${curr.start_time}, overlapping previous ${prev.entry_type} (${prev.caption_name || prev.brand_name || prev.id}, ended ${prev.end_time}) by ${overlapSec.toFixed(2)}s.`,
              'HIGH (Structural)',
              { overlapSeconds: overlapSec, prevEntryId: prev.id, prevEnd: prev.end_time, currStart: curr.start_time },
              prev.id
            );
          } else if (gap < -0.25) {
            pushIssue(
              'YELLOW',
              'Minor Boundary Overlap',
              'TL_MINOR_OVERLAP',
              `Entry overlaps previous entry (${prev.end_time}) by ${Math.abs(gap).toFixed(2)}s.`,
              'MEDIUM (Boundary)',
              { overlapSeconds: Math.abs(gap), prevEntryId: prev.id },
              prev.id
            );
          } else if (gap > thresholds.gapThresholdSeconds) {
            // Check if a deleted schedule record falls inside this exact gap!
            const matchingDeleted = deletedInGroup.find(
              (d) =>
                d.start_seconds !== null &&
                d.end_seconds !== null &&
                d.start_seconds >= prevEffEnd - 2 &&
                d.start_seconds <= curr.start_seconds! + 2
            );

            if (matchingDeleted) {
              pushIssue(
                'RED',
                matchingDeleted.entry_type === 'SPOT/TVC'
                  ? 'Confirmed Deleted / Missing SPOT/TVC Gap'
                  : 'Deleted Record Gap Detected',
                'TL_DELETED_RECORD_GAP',
                `Timeline gap of ${gap.toFixed(1)}s (${prev.end_time} -> ${curr.start_time}) matches deleted ${matchingDeleted.entry_type} record (${matchingDeleted.brand_name || matchingDeleted.caption_name || matchingDeleted.master_entry_id || matchingDeleted.id}).`,
                'HIGH (Corroborated by Deleted Autosave Record)',
                {
                  gapSeconds: gap,
                  gapStart: prev.end_time,
                  gapEnd: curr.start_time,
                  deletedRecordId: matchingDeleted.id,
                  deletedAction: matchingDeleted.action,
                },
                matchingDeleted.id
              );
            } else {
              pushIssue(
                'YELLOW',
                'Suspected Timeline Gap / Missing Entry',
                'TL_SUSPECTED_GAP',
                `Unexplained ${gap.toFixed(1)}s timeline gap between previous entry ending at ${prev.end_time} and this entry starting at ${curr.start_time}. No reference schedule available to confirm drop.`,
                'LOW (Suspected Gap - No Reference Schedule)',
                { gapSeconds: gap, gapStart: prev.end_time, gapEnd: curr.start_time, prevEntryId: prev.id },
                prev.id
              );
            }
          }
        }
      }

      // Missing Sequence Warning
      if (siblingHasMasterId && !curr.master_entry_id) {
        pushIssue(
          'YELLOW',
          'Missing Sequence Identifier',
          'TL_MISSING_MASTER_ID',
          `MasterEntryID is missing on this ${curr.entry_type} while sibling records on this channel include sequence IDs.`,
          'MEDIUM (Schema Completeness)',
          { siblingHasMasterId: true }
        );
      } else if (
        prev &&
        siblingHasStartIndex &&
        prev.end_index !== null &&
        curr.start_index !== null &&
        curr.start_index - prev.end_index > 100
      ) {
        pushIssue(
          'YELLOW',
          'Missing Sequence Index Jump',
          'TL_INDEX_SEQUENCE_JUMP',
          `startIndex jumped from previous endIndex (${prev.end_index}) to ${curr.start_index} (delta ${curr.start_index - prev.end_index}).`,
          'LOW (Sequence Heuristic)',
          { prevEndIndex: prev.end_index, currStartIndex: curr.start_index },
          prev.id
        );
      }

      // -----------------------------------------------------------------
      // A. SPOT/TVC (COMMERCIAL ADVERTISEMENT) CHECKS
      // -----------------------------------------------------------------
      if (curr.entry_type === 'SPOT/TVC') {
        if (currDur !== null) {
          if (currDur <= 0 || currDur > thresholds.maxAdDurationSeconds) {
            pushIssue(
              'RED',
              'Incorrect SPOT/TVC Duration',
              'AD_INVALID_DURATION',
              `SPOT/TVC duration (${currDur}s) is outside valid structural bounds (0s < d <= ${thresholds.maxAdDurationSeconds}s).`,
              'HIGH (Structural)',
              { duration: currDur, maxAllowed: thresholds.maxAdDurationSeconds }
            );
          } else if (currDur < thresholds.minAdDurationSeconds) {
            pushIssue(
              'YELLOW',
              'Short SPOT/TVC Duration',
              'AD_SHORT_DURATION',
              `SPOT/TVC duration (${currDur}s) is shorter than minimum threshold (${thresholds.minAdDurationSeconds}s).`,
              'MEDIUM (Duration Threshold)',
              { duration: currDur, minAllowed: thresholds.minAdDurationSeconds }
            );
          }
        }

        // Check against SourceDuration / customDuration / catalog
        const refDur =
          curr.custom_duration ??
          curr.source_duration ??
          (curr.commercial_id ? catalogByCommId.get(normStr(curr.commercial_id))?.source_duration ?? null : null);
        if (refDur !== null && currDur !== null && Math.abs(currDur - refDur) > thresholds.durationToleranceStrictSeconds) {
          pushIssue(
            'YELLOW',
            'SPOT/TVC Cut / Reference Duration Mismatch',
            'AD_SOURCE_DURATION_MISMATCH',
            `Aired SPOT/TVC duration (${currDur}s) differs from commercial reference/source duration (${refDur}s) by ${Math.abs(currDur - refDur).toFixed(2)}s.`,
            'MEDIUM (Catalog Reference)',
            { airedDuration: currDur, referenceDuration: refDur }
          );
        }

        // Category conflict check (Promo, SPN, Program, or Song must never be SPOT/TVC)
        if (
          /\b(?:PROGRAM|DRAMA|NEWS|SERIAL|MOVIE|SONG|SONGS|PROMO|TEASER|TRAILER|SPN|SPONSOR|SPONSORSHIP)\b/i.test(
            catUpper
          )
        ) {
          pushIssue(
            'RED',
            'Invalid SPOT/TVC Category',
            'AD_INVALID_CATEGORY',
            `SPOT/TVC entry has conflicting non-commercial category "${curr.category_name}".`,
            'HIGH (Category Conflict)',
            { categoryName: curr.category_name, subcategoryName: curr.subcategory_name }
          );
        } else if (!curr.category_name && !curr.brand_name) {
          pushIssue(
            'YELLOW',
            'Missing SPOT/TVC Metadata',
            'AD_MISSING_METADATA',
            `SPOT/TVC entry lacks both categoryName and brandName.`,
            'LOW (Incomplete Metadata)',
            { categoryName: curr.category_name, brandName: curr.brand_name }
          );
        }

        // Commercial ID consistency
        if (curr.commercial_id) {
          const cid = normStr(curr.commercial_id);
          const catalogEntry = catalogByCommId.get(cid);
          if (
            catalogEntry &&
            catalogEntry.brand_name &&
            curr.brand_name &&
            normStr(catalogEntry.brand_name) !== normStr(curr.brand_name)
          ) {
            pushIssue(
              'RED',
              'Inconsistent Commercial ID',
              'AD_COMMERCIAL_ID_CONFLICT',
              `commercialID "${curr.commercial_id}" maps to brand "${catalogEntry.brand_name}" in commercial catalog, but this entry lists "${curr.brand_name}".`,
              'HIGH (Catalog Cross-Check)',
              { commercialId: curr.commercial_id, catalogBrand: catalogEntry.brand_name, entryBrand: curr.brand_name }
            );
          } else {
            const brands = commercialBrandMap.get(cid);
            if (brands && brands.size > 1) {
              pushIssue(
                'RED',
                'Inconsistent Commercial ID Across Entries',
                'AD_COMMERCIAL_ID_MULTI_BRAND',
                `commercialID "${curr.commercial_id}" appears with multiple different brand names (${Array.from(brands).join(', ')}).`,
                'HIGH (Cross-Entry Conflict)',
                { commercialId: curr.commercial_id, brands: Array.from(brands) }
              );
            }
          }
        } else {
          pushIssue(
            'YELLOW',
            'Missing Commercial ID',
            'AD_MISSING_COMMERCIAL_ID',
            `SPOT/TVC entry does not specify a commercialID.`,
            'LOW (Incomplete Identifier)',
            { brandName: curr.brand_name, captionName: curr.caption_name }
          );
        }

        // Duplicate SPOT/TVC check
        if (prev && prev.entry_type === 'SPOT/TVC') {
          const sameComm =
            (curr.commercial_id && prev.commercial_id && normStr(curr.commercial_id) === normStr(prev.commercial_id)) ||
            (curr.caption_id && prev.caption_id && normStr(curr.caption_id) === normStr(prev.caption_id)) ||
            (curr.brand_name &&
              prev.brand_name &&
              curr.caption_name &&
              prev.caption_name &&
              normStr(curr.brand_name) === normStr(prev.brand_name) &&
              normStr(curr.caption_name) === normStr(prev.caption_name));

          if (sameComm) {
            const exactTime = curr.start_time && prev.start_time && curr.start_time === prev.start_time;
            const timeGap =
              curr.start_seconds !== null && prev.end_seconds !== null
                ? Math.abs(curr.start_seconds - prev.end_seconds)
                : 0;
            if (exactTime) {
              pushIssue(
                'RED',
                'Duplicate SPOT/TVC Entry',
                'AD_EXACT_DUPLICATE',
                `Exact duplicate SPOT/TVC (${curr.brand_name || curr.caption_name || curr.commercial_id}) at ${curr.start_time}.`,
                'HIGH (Exact Duplicate)',
                { prevEntryId: prev.id, commercialId: curr.commercial_id, startTime: curr.start_time },
                prev.id
              );
            } else if (timeGap <= thresholds.duplicateWindowSeconds) {
              pushIssue(
                'YELLOW',
                'Back-to-Back Duplicate SPOT/TVC',
                'AD_CONSECUTIVE_DUPLICATE',
                `Same SPOT/TVC (${curr.brand_name || curr.caption_name || curr.commercial_id}) repeats within ${timeGap.toFixed(1)}s of previous airing.`,
                'MEDIUM (Consecutive Repeat)',
                { prevEntryId: prev.id, gapSeconds: timeGap },
                prev.id
              );
            }
          }
        }

        // Suspicious SPOT/TVC Placement
        if (
          prev &&
          next &&
          prev.entry_type === 'PROGRAM' &&
          next.entry_type === 'PROGRAM' &&
          currDur !== null &&
          currDur < 10
        ) {
          pushIssue(
            'YELLOW',
            'Suspicious SPOT/TVC Placement',
            'AD_ISOLATED_SHORT_PLACEMENT',
            `Very short (${currDur}s) single SPOT/TVC isolated between two PROGRAM blocks (${prev.caption_name || 'Program'} -> ${next.caption_name || 'Program'}).`,
            'LOW (Placement Heuristic)',
            { duration: currDur, prevEntryId: prev.id, nextEntryId: next.id }
          );
        }
        if (curr.match_coverage !== null && curr.match_coverage < thresholds.minMatchCoverage) {
          pushIssue(
            'YELLOW',
            'Low SPOT/TVC Match Coverage',
            'AD_LOW_MATCH_COVERAGE',
            `MatchCoverage (${curr.match_coverage}%) is below threshold (${thresholds.minMatchCoverage}%).`,
            'MEDIUM (Confidence Metric)',
            { matchCoverage: curr.match_coverage, threshold: thresholds.minMatchCoverage }
          );
        }
      }

      // -----------------------------------------------------------------
      // B. PROGRAM CHECKS
      // -----------------------------------------------------------------
      if (curr.entry_type === 'PROGRAM') {
        if (
          /\b(?:COMMERCIAL|ADVERT|ADVERTISEMENT|TVC|SPOT\/TVC|PROMO|SPN|SPONSORSHIP)\b/i.test(catUpper) &&
          !/\bNON[-\s]?COMMERCIAL\b/i.test(catUpper)
        ) {
          pushIssue(
            'RED',
            'Incorrect PROGRAM Category',
            'PROG_INVALID_CATEGORY',
            `PROGRAM entry is tagged with non-program category "${curr.category_name}".`,
            'HIGH (Category Conflict)',
            { categoryName: curr.category_name, subcategoryName: curr.subcategory_name }
          );
        } else if (!curr.category_name && !subCatUpper) {
          pushIssue(
            'YELLOW',
            'Missing PROGRAM Category',
            'PROG_MISSING_CATEGORY',
            `PROGRAM entry does not specify a categoryName or subcategoryName.`,
            'LOW (Metadata Completeness)',
            { captionName: curr.caption_name }
          );
        }

        const isSongOrMusicSegment =
          /\b(?:SONGS?|MUSIC|OST|NAAT|QAWWALI|HAMD|GHAZAL)\b/i.test(catUpper) ||
          /\b(?:SONGS?|MUSIC|OST|NAAT|QAWWALI|HAMD|GHAZAL)\b/i.test(subCatUpper) ||
          /\b(?:SONGS?|OST|NAAT|QAWWALI)\b/i.test(normStr(curr.caption_name));

        if (currDur !== null) {
          if (currDur <= 0 || currDur > thresholds.maxProgramDurationSeconds) {
            pushIssue(
              'RED',
              'Invalid PROGRAM Duration',
              'PROG_INVALID_DURATION',
              `PROGRAM duration (${currDur}s) is outside valid structural bounds (0s < d <= ${thresholds.maxProgramDurationSeconds}s).`,
              'HIGH (Structural)',
              { duration: currDur, maxAllowed: thresholds.maxProgramDurationSeconds }
            );
          } else if (!isSongOrMusicSegment && currDur < thresholds.minProgramDurationSeconds) {
            pushIssue(
              'YELLOW',
              'Suspicious Short PROGRAM Duration',
              'PROG_SHORT_DURATION',
              `PROGRAM duration (${currDur}s) is shorter than minimum program threshold (${thresholds.minProgramDurationSeconds}s). Review whether this segment belongs to MEDIA or SPOT/TVC.`,
              'MEDIUM (Duration Threshold)',
              { duration: currDur, minAllowed: thresholds.minProgramDurationSeconds }
            );
          }
        }

        if (prev && prev.entry_type === 'PROGRAM') {
          const sameCaption =
            curr.caption_name && prev.caption_name && normStr(curr.caption_name) === normStr(prev.caption_name);
          if (sameCaption && curr.start_time && prev.start_time && curr.start_time === prev.start_time) {
            pushIssue(
              'RED',
              'Duplicate PROGRAM Entry',
              'PROG_EXACT_DUPLICATE',
              `Duplicate PROGRAM entry "${curr.caption_name}" at ${curr.start_time}.`,
              'HIGH (Exact Duplicate)',
              { prevEntryId: prev.id, startTime: curr.start_time },
              prev.id
            );
          } else if (sameCaption && !isSongOrMusicSegment && currDur !== null && currDur < thresholds.minProgramDurationSeconds) {
            pushIssue(
              'YELLOW',
              'Suspicious PROGRAM Sequence',
              'PROG_SUSPICIOUS_SEQUENCE',
              `Short PROGRAM fragment "${curr.caption_name}" (${currDur}s) directly follows an identically titled program.`,
              'MEDIUM (Sequence Heuristic)',
              { prevEntryId: prev.id, duration: currDur },
              prev.id
            );
          }
        }
      }

      // -----------------------------------------------------------------
      // C. MEDIA (PROMO / TEASER / TRAILER) CHECKS
      // -----------------------------------------------------------------
      if (curr.entry_type === 'MEDIA') {
        if (
          catUpper.includes('PAID AD') ||
          catUpper === 'TVC' ||
          catUpper === 'SPOT/TVC' ||
          (/\bPROGRAM\b/i.test(catUpper) && !/\bPROMO|ANNOUNCEMENT|TEASER|TRAILER\b/i.test(catUpper))
        ) {
          pushIssue(
            'RED',
            'Wrong MEDIA Category',
            'PROMO_WRONG_CATEGORY',
            `MEDIA entry has conflicting category "${curr.category_name}".`,
            'HIGH (Category Conflict)',
            { categoryName: curr.category_name }
          );
        }

        if (currDur !== null) {
          if (currDur <= 0 || currDur > thresholds.maxPromoDurationSeconds) {
            pushIssue(
              'RED',
              'Invalid MEDIA Duration',
              'PROMO_INVALID_DURATION',
              `MEDIA duration (${currDur}s) exceeds valid bounds (0s < d <= ${thresholds.maxPromoDurationSeconds}s).`,
              'HIGH (Structural)',
              { duration: currDur, maxAllowed: thresholds.maxPromoDurationSeconds }
            );
          } else if (currDur < thresholds.minPromoDurationSeconds) {
            pushIssue(
              'YELLOW',
              'Short MEDIA Duration',
              'PROMO_SHORT_DURATION',
              `MEDIA duration (${currDur}s) is below ${thresholds.minPromoDurationSeconds}s.`,
              'MEDIUM (Duration Threshold)',
              { duration: currDur }
            );
          }
        }

        if (prev && prev.entry_type === 'MEDIA') {
          const samePromo =
            (curr.caption_name && prev.caption_name && normStr(curr.caption_name) === normStr(prev.caption_name)) ||
            (curr.commercial_id && prev.commercial_id && normStr(curr.commercial_id) === normStr(prev.commercial_id));
          if (samePromo) {
            if (curr.start_time && prev.start_time && curr.start_time === prev.start_time) {
              pushIssue(
                'RED',
                'Duplicate MEDIA Record',
                'PROMO_EXACT_DUPLICATE',
                `Exact duplicate MEDIA promo "${curr.caption_name || curr.brand_name}" at ${curr.start_time}.`,
                'HIGH (Exact Duplicate)',
                { prevEntryId: prev.id },
                prev.id
              );
            } else {
              pushIssue(
                'YELLOW',
                'Consecutive Duplicate MEDIA',
                'PROMO_CONSECUTIVE_DUPLICATE',
                `MEDIA promo "${curr.caption_name || curr.brand_name}" appears back-to-back.`,
                'MEDIUM (Consecutive Repeat)',
                { prevEntryId: prev.id },
                prev.id
              );
            }
          }
        }

        if (
          prev &&
          next &&
          prev.entry_type === 'PROGRAM' &&
          next.entry_type === 'PROGRAM' &&
          prev.caption_name &&
          next.caption_name &&
          normStr(prev.caption_name) === normStr(next.caption_name)
        ) {
          pushIssue(
            'YELLOW',
            'Unexpected MEDIA Placement',
            'PROMO_MID_PROGRAM_PLACEMENT',
            `MEDIA promo interrupts two segments of the same program "${prev.caption_name}" without an accompanying SPOT/TVC break.`,
            'LOW (Placement Heuristic)',
            { prevEntryId: prev.id, nextEntryId: next.id }
          );
        }
      }

      // -----------------------------------------------------------------
      // D. SPONSORSHIP (SPN) CHECKS
      // -----------------------------------------------------------------
      if (curr.entry_type === 'SPONSORSHIP') {
        if (
          /\b(?:NEWS|DRAMA|MOVIE)\b/i.test(catUpper) &&
          !/\bSPONSOR|SPN\b/i.test(catUpper)
        ) {
          pushIssue(
            'RED',
            'Wrong SPONSORSHIP Category',
            'SPN_WRONG_CATEGORY',
            `SPONSORSHIP entry has conflicting program category "${curr.category_name}".`,
            'HIGH (Category Conflict)',
            { categoryName: curr.category_name }
          );
        }

        if (currDur !== null) {
          if (currDur <= 0 || currDur > thresholds.maxSpnDurationSeconds) {
            pushIssue(
              'RED',
              'Incorrect SPONSORSHIP Duration',
              'SPN_INVALID_DURATION',
              `SPONSORSHIP duration (${currDur}s) is outside valid bounds (0s < d <= ${thresholds.maxSpnDurationSeconds}s).`,
              'HIGH (Structural)',
              { duration: currDur, maxAllowed: thresholds.maxSpnDurationSeconds }
            );
          } else if (currDur < thresholds.minSpnDurationSeconds) {
            pushIssue(
              'YELLOW',
              'Short SPONSORSHIP Duration',
              'SPN_SHORT_DURATION',
              `SPONSORSHIP duration (${currDur}s) is shorter than ${thresholds.minSpnDurationSeconds}s.`,
              'MEDIUM (Duration Threshold)',
              { duration: currDur }
            );
          }
        }

        if (prev && prev.entry_type === 'SPONSORSHIP') {
          const sameSpn =
            (curr.brand_name && prev.brand_name && normStr(curr.brand_name) === normStr(prev.brand_name)) ||
            (curr.caption_name && prev.caption_name && normStr(curr.caption_name) === normStr(prev.caption_name));
          if (sameSpn) {
            const exact = curr.start_time && prev.start_time && curr.start_time === prev.start_time;
            pushIssue(
              exact ? 'RED' : 'YELLOW',
              'Duplicate SPONSORSHIP',
              exact ? 'SPN_EXACT_DUPLICATE' : 'SPN_CONSECUTIVE_DUPLICATE',
              `Duplicate SPONSORSHIP (${curr.brand_name || curr.caption_name}) detected back-to-back.`,
              exact ? 'HIGH (Exact Duplicate)' : 'MEDIUM (Consecutive Repeat)',
              { prevEntryId: prev.id },
              prev.id
            );
          }
        }

        if (!curr.brand_name && !curr.commercial_id && !curr.caption_name) {
          pushIssue(
            'YELLOW',
            'Inconsistent SPONSORSHIP Record',
            'SPN_MISSING_IDENTITY',
            `SPONSORSHIP entry has no brandName, commercialID, or captionName.`,
            'MEDIUM (Incomplete Record)',
            {}
          );
        }
      }
    }
  }

  // Persist results atomically inside a transaction
  const entrySeverity = new Map<string, 'RED' | 'YELLOW' | 'GREEN'>();
  for (const e of entries) {
    entrySeverity.set(e.id, 'GREEN');
  }
  for (const issue of draftIssues) {
    const existing = entrySeverity.get(issue.entryId);
    if (issue.severity === 'RED') {
      entrySeverity.set(issue.entryId, 'RED');
    } else if (issue.severity === 'YELLOW' && existing !== 'RED') {
      entrySeverity.set(issue.entryId, 'YELLOW');
    }
  }

  let redEntries = 0;
  let yellowEntries = 0;
  let greenEntries = 0;
  for (const sev of entrySeverity.values()) {
    if (sev === 'RED') redEntries++;
    else if (sev === 'YELLOW') yellowEntries++;
    else greenEntries++;
  }

  const completedAt = new Date().toISOString();
  const scopeLabel = options?.channelKey
    ? `${options.channelKey}${options.transDate ? ` (${options.transDate})` : ''}`
    : 'ALL_CHANNELS';

  const tx = db.transaction(() => {
    // Clear previous issues for the analyzed entries so reruns stay fresh without stale duplicates
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
    entityType: 'QA_RUN',
    entityId: qaRunId,
    action: 'QA_SCAN_COMPLETED',
    newValue: `${entries.length} analyzed (${redEntries} RED, ${yellowEntries} YELLOW, ${greenEntries} GREEN)`,
    notes: `Scope: ${scopeLabel}`,
  });

  return {
    qaRunId,
    totalAnalyzed: entries.length,
    redCount: redEntries,
    yellowCount: yellowEntries,
    greenCount: greenEntries,
    issuesCreated: draftIssues.length,
  };
}
