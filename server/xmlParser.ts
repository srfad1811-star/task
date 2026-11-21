import crypto from 'node:crypto';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import type { CustomFieldMapping, EntryType, FileRole, InspectedXmlFile } from '../src/types.ts';

export const CANONICAL_FIELD_ALIASES: Record<string, string[]> = {
  MasterEntryID: ['masterentryid', 'master_entry_id', 'masterid', 'entryid', 'entry_id', 'scheduleid', 'schedule_id', 'trscheduleid'],
  segmentDetailID: ['segmentdetailid', 'segment_detail_id', 'segmentid', 'detailid'],
  startIndex: ['startindex', 'start_index'],
  endIndex: ['endindex', 'end_index'],
  DiffInIndex: ['diffinindex', 'diff_in_index', 'indexdiff'],
  startTime: ['starttime', 'start_time', 'startdt', 'airstarttime', 'begin_time', 'progstarttime'],
  endTime: ['endtime', 'end_time', 'enddt', 'airendtime', 'progendtime'],
  Duration: ['duration', 'dur', 'durationseconds', 'duration_sec', 'length'],
  channelID: ['channelid', 'channel_id', 'ch_id', 'chid'],
  channelName: ['channelname', 'channel_name', 'ch_name', 'chname', 'channel'],
  transDate: ['transdate', 'trans_date', 'broadcastdate', 'airdate', 'date', 'txdate'],
  captionID: ['captionid', 'caption_id', 'programid', 'program_id'],
  captionName: [
    'captionname',
    'caption_name',
    'caption',
    'title',
    'programname',
    'program_name',
    'program_title',
    'programtitle',
    'progname',
    'prog_name',
    'program',
    'showname',
    'show_name',
    'episodename',
  ],
  brandName: ['brandname', 'brand_name', 'brand'],
  FilePath: ['filepath', 'file_path', 'path'],
  EntryType: [
    'entrytype',
    'entry_type',
    'recordtype',
    'itemtype',
    'type',
    'mediatype',
    'media_type',
    'contenttype',
    'content_type',
    'scheduletype',
    'schedule_type',
  ],
  videoClipID: ['videoclipid', 'video_clip_id', 'clipid'],
  startFrame: ['startframe', 'start_frame'],
  endFrame: ['endframe', 'end_frame'],
  txt: ['txt', 'text', 'captiontext', 'subtitle', 'notes', 'remarks'],
  startTime_tts: ['starttime_tts', 'starttimetts'],
  endTime_tts: ['endtime_tts', 'endtimetts'],
  categoryName: ['categoryname', 'category_name', 'category', 'genre'],
  subcategoryName: ['subcategoryname', 'subcategory_name', 'subcategory', 'subgenre'],
  categoryID: ['categoryid', 'category_id'],
  subcategoryID: ['subcategoryid', 'subcategory_id'],
  brandID: ['brandid', 'brand_id'],
  commercialTypeID: ['commercialtypeid', 'commercial_type_id'],
  Action: ['action', 'operation', 'statusaction'],
  commercialID: ['commercialid', 'commercial_id', 'commid', 'adid'],
  videoFileName: ['videofilename', 'video_file_name', 'filename', 'clipfilename'],
  leftAdjust: ['leftadjust', 'left_adjust'],
  rightAdjust: ['rightadjust', 'right_adjust'],
  qualityID: ['qualityid', 'quality_id', 'quality'],
  matchValue: ['matchvalue', 'match_value'],
  fdb: ['fdb'],
  isBenchMarked: ['isbenchmarked', 'is_benchmarked', 'benchmarked'],
  companyName: ['companyname', 'company_name', 'clientname', 'advertiser'],
  customDuration: ['customduration', 'custom_duration'],
  commercialTypeName: ['commercialtypename', 'commercial_type_name', 'commtype'],
  MatchCoverage: ['matchcoverage', 'match_coverage', 'coverage'],
  SourceDuration: ['sourceduration', 'source_duration', 'refduration'],
};

const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(CANONICAL_FIELD_ALIASES)) {
  ALIAS_TO_CANONICAL.set(canonical.toLowerCase(), canonical);
  for (const alias of aliases) {
    ALIAS_TO_CANONICAL.set(alias.toLowerCase(), canonical);
  }
}

export interface ParsedRecord {
  canonical: Record<string, string>;
  extra: Record<string, string>;
  rawXml: string;
  entryType: EntryType;
  transDate: string | null;
  rawTransDate: string | null;
  startTimeNormalized: string | null;
  endTimeNormalized: string | null;
  startSeconds: number | null;
  endSeconds: number | null;
  durationSeconds: number | null;
}

export interface ParsedXmlFileResult {
  inspection: InspectedXmlFile;
  records: ParsedRecord[];
  metadataEntries: Record<string, string>[];
}

export function decodeBufferToText(buffer: Buffer): string {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return buffer.subarray(2).toString('utf16le');
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      const swapped = Buffer.allocUnsafe(buffer.length - 2);
      for (let i = 2; i + 1 < buffer.length; i += 2) {
        swapped[i - 2] = buffer[i + 1];
        swapped[i - 1] = buffer[i];
      }
      return swapped.toString('utf16le');
    }
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  // Heuristic check for UTF-16LE without BOM (frequent null bytes in odd positions)
  const sampleLen = Math.min(buffer.length, 200);
  let zeroOdd = 0;
  for (let i = 1; i < sampleLen; i += 2) {
    if (buffer[i] === 0) zeroOdd++;
  }
  if (sampleLen >= 20 && zeroOdd > sampleLen / 4) {
    return buffer.toString('utf16le');
  }
  return buffer.toString('utf8');
}

function isProbablyXmlText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('<');
}

function stripNs(tag: string): string {
  const idx = tag.indexOf(':');
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

function extractSchemaFields(schemaNode: unknown): Array<{ name: string; type: string }> {
  const fields: Array<{ name: string; type: string }> = [];
  const seen = new Set<string>();

  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const attrName = typeof obj['@_name'] === 'string' ? obj['@_name'] : null;
    const attrType = typeof obj['@_type'] === 'string' ? obj['@_type'] : null;

    if (attrName && attrType && !seen.has(attrName)) {
      seen.add(attrName);
      fields.push({ name: attrName, type: stripNs(attrType) });
    } else if (attrName && !obj['xs:complexType'] && !obj['xsd:complexType'] && !obj['complexType']) {
      const simple = (obj['xs:simpleType'] ?? obj['xsd:simpleType'] ?? obj['simpleType']) as Record<string, unknown> | undefined;
      const restriction = simple
        ? ((simple['xs:restriction'] ?? simple['xsd:restriction'] ?? simple['restriction']) as Record<string, unknown> | undefined)
        : undefined;
      const baseType = restriction && typeof restriction['@_base'] === 'string' ? stripNs(restriction['@_base']) : 'string';
      if (!seen.has(attrName) && attrName !== 'NewDataSet') {
        seen.add(attrName);
        fields.push({ name: attrName, type: baseType });
      }
    }

    for (const [k, v] of Object.entries(obj)) {
      if (!k.startsWith('@_')) walk(v);
    }
  }

  walk(schemaNode);
  return fields;
}

function isPlainRecordObject(val: unknown): val is Record<string, unknown> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const keys = Object.keys(val as Record<string, unknown>).filter((k) => !k.startsWith('@_') && k !== '#text');
  if (keys.length === 0) return false;
  let scalarOrKnownCount = 0;
  let nestedArrayCount = 0;
  let nestedObjectCount = 0;
  for (const k of keys) {
    const child = (val as Record<string, unknown>)[k];
    if (Array.isArray(child)) {
      nestedArrayCount++;
      continue;
    }
    if (child && typeof child === 'object') {
      const childKeys = Object.keys(child as Record<string, unknown>).filter((ck) => !ck.startsWith('@_'));
      if (childKeys.length > 0 && !('#text' in (child as Record<string, unknown>))) {
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

function extractRecordsFromNode(
  node: unknown
): { recordElement: string | null; rawObjects: Record<string, unknown>[] } {
  if (!node || typeof node !== 'object') {
    return { recordElement: null, rawObjects: [] };
  }

  const obj = node as Record<string, unknown>;
  const entries = Object.entries(obj).filter(
    ([k]) =>
      !k.startsWith('@_') &&
      k !== '?xml' &&
      !k.endsWith(':schema') &&
      k !== 'schema'
  );

  // Unwrap diffgram -> NewDataSet if present
  for (const [k, v] of entries) {
    if (stripNs(k).toLowerCase() === 'diffgram' && v && typeof v === 'object') {
      const inner = extractRecordsFromNode(v);
      if (inner.rawObjects.length > 0) return inner;
    }
  }

  // Look for direct arrays of record objects
  const collected: Record<string, unknown>[] = [];
  let detectedElement: string | null = null;

  for (const [k, v] of entries) {
    if (Array.isArray(v)) {
      const objs = v.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
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
    } else if (v && typeof v === 'object') {
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

function flattenScalarValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (typeof val === 'object') {
    const rec = val as Record<string, unknown>;
    if ('#text' in rec && rec['#text'] !== undefined) {
      return String(rec['#text']).trim();
    }
    if (Object.keys(rec).every((k) => k.startsWith('@_'))) {
      return '';
    }
    return JSON.stringify(rec);
  }
  return String(val).trim();
}

export function detectFileRole(
  fileName: string,
  rootElement: string | null,
  recordElement: string | null,
  mappedCanonicalKeys: Set<string>,
  hasRecords: boolean,
  isPureSchema: boolean
): FileRole {
  if (isPureSchema) return 'schema_only';

  const name = fileName.toLowerCase();
  const root = (rootElement ?? '').toLowerCase();
  const rec = (recordElement ?? '').toLowerCase();

  if (name.includes('metadata') || root.includes('metadata')) return 'metadata';
  if (name.includes('selectedchannel') || rec.includes('selectedchannel')) return 'selectedchannels';
  if (name.includes('reviewed_caption') || name.includes('reviewedcaption')) return 'reviewed_captions';
  if (name.includes('trschedule_deleted') || name.includes('schedule_deleted') || name.includes('deleted')) {
    return 'trschedule_deleted';
  }
  if (name.includes('trcommercial')) return 'trcommercial';
  if (name.includes('tcommercial')) return 'tcommercial';
  if (name.includes('trschedule') || name.includes('schedule')) return 'trschedule';

  if (!hasRecords) return 'unknown';

  // Structural inference if filename was renamed
  const hasTiming = mappedCanonicalKeys.has('startTime') || mappedCanonicalKeys.has('endTime') || mappedCanonicalKeys.has('transDate');
  const hasChannel = mappedCanonicalKeys.has('channelID') || mappedCanonicalKeys.has('channelName');
  const hasCommercial = mappedCanonicalKeys.has('commercialID') || mappedCanonicalKeys.has('brandName');

  if (hasChannel && !hasTiming && !hasCommercial) return 'selectedchannels';
  if (hasCommercial && !hasTiming) return 'tcommercial';
  if (hasTiming && hasCommercial && !mappedCanonicalKeys.has('EntryType')) return 'trcommercial';
  if (hasTiming && hasChannel) return 'trschedule';

  return 'unknown';
}

export function normalizeTransDate(rawDate: string | undefined, rawStartTime: string | undefined): {
  transDate: string | null;
  rawTransDate: string | null;
} {
  const raw = rawDate?.trim() || null;
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };

  const tryExtract = (str: string | undefined): string | null => {
    if (!str) return null;
    const s = str.trim();
    // YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
    }
    // Compact YYYYMMDD
    const compactMatch = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (compactMatch) {
      return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
    }
    // DD-MMM-YYYY (e.g. 16-Nov-2026)
    const dmyMon = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})/);
    if (dmyMon && months[dmyMon[2].toLowerCase()]) {
      return `${dmyMon[3]}-${months[dmyMon[2].toLowerCase()]}-${dmyMon[1].padStart(2, '0')}`;
    }
    // DD/MM/YYYY or MM/DD/YYYY
    const slashMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (slashMatch) {
      const p1 = Number(slashMatch[1]);
      const p2 = Number(slashMatch[2]);
      const year = slashMatch[3];
      if (p1 > 12) {
        return `${year}-${String(p2).padStart(2, '0')}-${String(p1).padStart(2, '0')}`;
      }
      if (p2 > 12) {
        return `${year}-${String(p1).padStart(2, '0')}-${String(p2).padStart(2, '0')}`;
      }
      return `${year}-${String(p1).padStart(2, '0')}-${String(p2).padStart(2, '0')}`;
    }
    return null;
  };

  const fromDate = tryExtract(rawDate);
  if (fromDate) return { transDate: fromDate, rawTransDate: raw };

  const fromStart = tryExtract(rawStartTime);
  if (fromStart) return { transDate: fromStart, rawTransDate: raw };

  return { transDate: null, rawTransDate: raw };
}

export function parseTimeToSeconds(raw: string | undefined): {
  normalized: string | null;
  seconds: number | null;
} {
  if (!raw) return { normalized: null, seconds: null };
  const s = raw.trim();
  if (!s) return { normalized: null, seconds: null };

  // Extract time part if ISO datetime or "YYYY-MM-DD HH:MM:SS"
  const timeMatch = s.match(/(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?\s*(AM|PM)?/i);
  if (timeMatch) {
    let hh = Number(timeMatch[1]);
    const mm = Number(timeMatch[2]);
    const ss = Number(timeMatch[3]);
    const frac = timeMatch[4] ? Number(`0.${timeMatch[4]}`) : 0;
    const ampm = timeMatch[5]?.toUpperCase();
    if (ampm === 'PM' && hh < 12) hh += 12;
    if (ampm === 'AM' && hh === 12) hh = 0;
    if (mm >= 0 && mm < 60 && ss >= 0 && ss < 60 && hh >= 0 && hh < 48) {
      const total = hh * 3600 + mm * 60 + ss + frac;
      const norm = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}${
        frac > 0 ? '.' + String(Math.round(frac * 1000)).padStart(3, '0') : ''
      }`;
      return { normalized: norm, seconds: Math.round(total * 1000) / 1000 };
    }
  }

  // HH:MM
  const hmMatch = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (hmMatch) {
    let hh = Number(hmMatch[1]);
    const mm = Number(hmMatch[2]);
    const ampm = hmMatch[3]?.toUpperCase();
    if (ampm === 'PM' && hh < 12) hh += 12;
    if (ampm === 'AM' && hh === 12) hh = 0;
    if (mm >= 0 && mm < 60 && hh >= 0 && hh < 48) {
      const total = hh * 3600 + mm * 60;
      return {
        normalized: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`,
        seconds: total,
      };
    }
  }

  return { normalized: s, seconds: null };
}

export function parseDurationToSeconds(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // Numeric seconds (e.g. "30", "30.5", "1800") or "30s" / "30 sec"
  const numSec = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)?$/i);
  if (numSec) {
    const n = Number(numSec[1]);
    return Number.isFinite(n) ? n : null;
  }

  // ISO 8601 duration PT1H2M30.5S
  const iso = s.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso) {
    const h = iso[1] ? Number(iso[1]) : 0;
    const m = iso[2] ? Number(iso[2]) : 0;
    const sec = iso[3] ? Number(iso[3]) : 0;
    return Math.round((h * 3600 + m * 60 + sec) * 1000) / 1000;
  }

  // HH:MM:SS(.fff)
  const hms = s.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/);
  if (hms) {
    const frac = hms[4] ? Number(`0.${hms[4]}`) : 0;
    return Math.round((Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]) + frac) * 1000) / 1000;
  }

  // MM:SS
  const ms = s.match(/^(\d{1,2}):(\d{2})$/);
  if (ms) {
    return Number(ms[1]) * 60 + Number(ms[2]);
  }

  return null;
}

function isMeaningfulValue(v: string | undefined | null): boolean {
  if (!v) return false;
  const u = v.trim().toUpperCase();
  return u !== '' && u !== '0' && u !== '-1' && u !== 'NULL' && u !== 'NONE' && u !== 'N/A' && u !== '-';
}

export const VALID_ENTRY_TYPES: readonly EntryType[] = [
  'MEDIA',
  'SPONSORSHIP',
  'SPOT/TVC',
  'PROGRAM',
] as const;

export function normalizeEntryType(raw?: string | null): EntryType | null {
  if (!raw) return null;
  const u = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!u) return null;
  if (u === 'SPONSORSHIP' || u === 'SPN' || u === 'SPONSOR' || u === 'SPNS' || u === 'SPONSORSHIPS') {
    return 'SPONSORSHIP';
  }
  if (u === 'MEDIA' || u === 'PROMO' || u === 'PROMOS' || u === 'PROMOTIONAL') {
    return 'MEDIA';
  }
  if (
    u === 'SPOT/TVC' ||
    u === 'SPOT / TVC' ||
    u === 'SPOT_TVC' ||
    u === 'SPOT' ||
    u === 'TVC' ||
    u === 'ADVERTISEMENT' ||
    u === 'ADVERTISEMENTS' ||
    u === 'COMMERCIAL' ||
    u === 'COMMERCIALS' ||
    u === 'AD' ||
    u === 'ADS'
  ) {
    return 'SPOT/TVC';
  }
  if (u === 'PROGRAM' || u === 'PROGRAMS' || u === 'PROGRAMME' || u === 'OTHER') {
    return 'PROGRAM';
  }
  return null;
}

// Priority 1: Sponsorship / SPN -> SPONSORSHIP
// Word-boundary match for SPN avoids false positives on ESPN, HOSPITAL, DISPLAY, etc.
const SPONSORSHIP_REGEX =
  /(?:^|[\s\-_/([.,])SPN(?:$|[\s\-_/)\].,0-9])|\bSPONSOR(?:SHIP|ED|ING|S)?\b|\bCO[-\s]?SPONSOR\b|\bTITLE\s+SPONSOR\b|\bASSOCIATE\s+SPONSOR\b|\bSPONSOR\s+BUMPER\b|\bPRESENTED\s+BY\b|\bCO[-\s]?PRESENTED\s+BY\b|\bPOWERED\s+BY\b|\bCO[-\s]?POWERED\s+BY\b|\bBROUGHT\s+TO\s+YOU\s+BY\b|\bIN\s+ASSOCIATION\s+WITH\b/i;

// Priority 2: Promo / Trailer / Teaser / Program Announcement -> MEDIA
// Checked across all text fields (without matching generic commercial marketing slogans)
const MEDIA_PROMO_GLOBAL_REGEX =
  /\bPROMOS?\b|\bPROMOTIONAL\b|\bSELF[-\s]?PROMO\b|\bIN[-\s]?HOUSE[-\s]?PROMO\b|\bCHANNEL[-\s]?PROMO\b|\bPROGRAM(?:ME)?[-\s]?PROMO\b|\bSHOW[-\s]?PROMO\b|\bDRAMA[-\s]?PROMO\b|\bUPCOMING\s+(?:SHOW|DRAMA|PROGRAM(?:ME)?|EPISODE|SERIAL|MOVIE|FILM|EVENT|MATCH)\b|\bTEASERS?\b|\bTRAILERS?\b|\bPRECAP\b|\bPROGRAM(?:ME)?\s+ANNOUNCEMENT\b|\bSHOW\s+ANNOUNCEMENT\b|\bCHANNEL\s+ANNOUNCEMENT\b|\bNEXT\s+ON\b|\bCOMING\s+SOON\b|\bCOMING\s+UP\s+NEXT\b|\bWATCH\s+TONIGHT\b|\bTONIGHT\s+AT\b|\bCHANNEL\s+ID\b|\bSTATION\s+ID\b/i;

// Additional MEDIA indicators valid specifically in type/category metadata fields
const MEDIA_TYPE_FIELD_REGEX =
  /^(?:MEDIA|PR|PRM|PROMO|PROMOS|TEASER|TRAILER|IDENT|BUMPER|STING|ANNOUNCEMENT|UPCOMING)$|\b(?:CHANNEL\s*MEDIA|SELF\s*MEDIA|IN[-\s]?HOUSE\s*MEDIA|BUMPERS?|IDENTS?|STINGS?|ANNOUNCEMENTS?|UPCOMING)\b/i;

// Priority 3: Commercial Advertisement / TVC -> SPOT/TVC
const COMMERCIAL_EXPLICIT_TYPE_REGEX =
  /^(?:SPOT\/TVC|SPOT\s*\/\s*TVC|SPOT|TVC|COMMERCIAL|COMMERCIALS|ADVERTISEMENT|ADVERTISEMENTS|ADVERT|AD|ADS|ADV|COM|PAID\s*AD|BRAND\s*AD|PRODUCT\s*AD|SERVICE\s*AD|AD\s*SPOT|COMMERCIAL\s*SPOT|TV\s*COMMERCIAL)$|\b(?:SPOT\/TVC|TVC|TV\s+COMMERCIAL|COMMERCIAL\s+SPOT|COMMERCIAL\s+AD|ADVERTISEMENT|ADVERT|BRAND\s+COMMERCIAL|PRODUCT\s+AD|SERVICE\s+AD|PAID\s+AD|CLIENT\s+AD|AD\s+SPOT)\b/i;

const COMMERCIAL_CAPTION_REGEX =
  /\b(?:SPOT\/TVC|TVC|TV\s+COMMERCIAL|COMMERCIAL\s+SPOT|ADVERTISEMENT|BRAND\s+COMMERCIAL|PRODUCT\s+AD|SERVICE\s+AD|AD\s+SPOT)\b/i;

// Priority 4: Regular broadcast content (Programs & Songs) -> PROGRAM
const PROGRAM_EXACT_TOKENS = new Set([
  'P',
  'PRG',
  'PGM',
  'PROG',
  'PROGRAM',
  'PROGRAMME',
  'SHOW',
  'REGULAR',
  'TRANSMISSION',
  'EDITORIAL',
  'CONTENT',
  'TX',
  'FILLER',
  'SONG',
  'SONGS',
  'MUSIC',
  'OST',
]);

// Explicit non-ad broadcast program / song keywords (word-boundary matched to avoid matching e.g. "Sportswear")
const PROGRAM_OR_SONG_TYPE_REGEX =
  /\b(?:NON[-\s]?COMMERCIAL|PROGRAM(?:ME)?S?|DRAMAS?|SERIALS?|SOAPS?|NEWS|BULLETIN|HEADLINES?|TALK\s*SHOWS?|INTERVIEWS?|ENTERTAINMENT(?:\s+SHOWS?)?|DOCUMENTAR(?:Y|IES)|REALITY(?:\s+SHOWS?)?|SPORTS?(?:\s+SHOW|\s+PROGRAM|\s+LIVE|\s+MATCH)?|CRICKET|FOOTBALL|MUSIC(?:\s+PROGRAM|\s+SHOW|\s+VIDEO)?|SONGS?|OST|QAWWALI|NAAT|HAMD|GHAZAL|GAZAL|CONCERT|SINGING|MOVIES?|FILMS?|TELEFILMS?|SITCOMS?|COMEDY|CARTOONS?|ANIME|KIDS\s+SHOW|MORNING\s+SHOW|CURRENT\s+AFFAIRS?|RELIGIOUS|ISLAMIC|QURAN|COOKING\s+SHOW|LIFESTYLE\s+SHOW|INFOTAINMENT|EPISODES?|DEBATE|MAGAZINE\s+SHOW|WEATHER\s+REPORT|LIVE\s+SHOW|SHOWS?)\b/i;

const SONG_OR_PROGRAM_CONTENT_REGEX =
  /\b(?:SONGS?|MUSIC\s+PROGRAM|MUSIC\s+SHOW|OST|QAWWALI|NAAT|HAMD|GHAZAL|DRAMA\s+SERIAL|TALK\s+SHOW|NEWS\s+BULLETIN|HEADLINES|INTERVIEW|DOCUMENTARY|REALITY\s+SHOW|MORNING\s+SHOW|EPISODE\s*\d+|EP\.?\s*\d+)\b/i;

export function classifyEntryType(
  canonical: {
    EntryType?: string | null;
    commercialTypeName?: string | null;
    categoryName?: string | null;
    subcategoryName?: string | null;
    commercialID?: string | null;
    brandName?: string | null;
    captionName?: string | null;
    companyName?: string | null;
    txt?: string | null;
  },
  role: FileRole | string,
  customTypeMap?: Map<string, EntryType>
): EntryType {
  // 0. User-configured explicit raw EntryType / commercialTypeName / categoryName overrides
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
    canonical.subcategoryName,
  ]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map((v) => v.trim().toUpperCase());

  const contentFields = [
    canonical.captionName,
    canonical.brandName,
    canonical.companyName,
    canonical.txt,
  ]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map((v) => v.trim().toUpperCase());

  const allFields = [...typeFields, ...contentFields];

  // =========================================================================
  // PRIORITY 1: Sponsorship / SPN -> SPONSORSHIP
  // Checked across ALL fields before Media/Promo or Spot/TVC.
  // Sponsor bumpers, SPN labels, sponsorship announcements, and sponsored
  // program identifiers are NEVER classified as SPOT/TVC or MEDIA.
  // =========================================================================
  for (const val of allFields) {
    if (SPONSORSHIP_REGEX.test(val)) {
      return 'SPONSORSHIP';
    }
  }

  // =========================================================================
  // PRIORITY 2: Promo / Trailer / Teaser / Program Announcement -> MEDIA
  // Checked across ALL fields before Spot/TVC.
  // Channel promos, program promos, upcoming show promos, teasers, trailers,
  // and program announcements are NEVER classified as SPOT/TVC.
  // =========================================================================
  for (const val of typeFields) {
    if (MEDIA_PROMO_GLOBAL_REGEX.test(val) || MEDIA_TYPE_FIELD_REGEX.test(val)) {
      return 'MEDIA';
    }
  }
  for (const val of contentFields) {
    if (MEDIA_PROMO_GLOBAL_REGEX.test(val)) {
      return 'MEDIA';
    }
  }

  // =========================================================================
  // Check explicit Program / Song signals in category/type/content fields so
  // Songs and Programs (even if mistakenly placed in trcommercial or carrying
  // an artist/channel in brandName) are NOT misclassified as SPOT/TVC.
  // =========================================================================
  const hasNonCommercialTag = typeFields.some((v) => /\bNON[-\s]?COMMERCIAL\b/i.test(v));
  if (hasNonCommercialTag) {
    return 'PROGRAM';
  }

  const primaryTypeFields = [canonical.EntryType, canonical.commercialTypeName]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map((v) => v.trim().toUpperCase());

  const categoryFields = [canonical.categoryName, canonical.subcategoryName]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map((v) => v.trim().toUpperCase());

  const isExplicitCommercialInPrimary = primaryTypeFields.some(
    (v) => COMMERCIAL_EXPLICIT_TYPE_REGEX.test(v) || /\bCOMMERCIAL\b/i.test(v)
  );
  const isStrictAdTagInPrimary = primaryTypeFields.some((v) =>
    /^(?:SPOT\/TVC|SPOT\s*\/\s*TVC|TVC|SPOT|ADVERTISEMENT|PAID\s*AD|BRAND\s*AD|PRODUCT\s*AD|SERVICE\s*AD|TV\s*COMMERCIAL)$|\b(?:SPOT\/TVC|TVC|TV\s+COMMERCIAL|ADVERTISEMENT)\b/i.test(
      v
    )
  );
  const isExplicitProgramOrSongInPrimary = primaryTypeFields.some(
    (v) => PROGRAM_EXACT_TOKENS.has(v) || PROGRAM_OR_SONG_TYPE_REGEX.test(v)
  );
  const isExplicitProgramOrSongInCategory = categoryFields.some(
    (v) => PROGRAM_EXACT_TOKENS.has(v) || PROGRAM_OR_SONG_TYPE_REGEX.test(v)
  );
  const isSongInCategoryOrPrimary = [...primaryTypeFields, ...categoryFields].some((v) =>
    /\b(?:SONGS?|MUSIC\s+PROGRAM|MUSIC\s+SHOW|OST|QAWWALI|NAAT|HAMD|GHAZAL)\b/i.test(v)
  );
  const isSongOrProgramInCaption = Boolean(
    canonical.captionName && SONG_OR_PROGRAM_CONTENT_REGEX.test(canonical.captionName.trim().toUpperCase())
  );

  // Songs or explicit program categories are ALWAYS PROGRAM unless explicitly tagged as a strict TVC/Spot ad
  if (isSongInCategoryOrPrimary && !isStrictAdTagInPrimary) {
    return 'PROGRAM';
  }
  if (isExplicitProgramOrSongInPrimary) {
    return 'PROGRAM';
  }
  if (isExplicitProgramOrSongInCategory && !isStrictAdTagInPrimary) {
    return 'PROGRAM';
  }

  // =========================================================================
  // PRIORITY 3: Commercial Advertisement / TVC -> SPOT/TVC
  // Exclusively for genuine commercial advertisements / TVCs / commercial spots.
  // Do NOT classify as SPOT/TVC based only on brandName, duration, music,
  // voiceover, or promotional language.
  // =========================================================================
  if (isExplicitCommercialInPrimary) {
    return 'SPOT/TVC';
  }

  for (const val of categoryFields) {
    if (COMMERCIAL_EXPLICIT_TYPE_REGEX.test(val) || /\bCOMMERCIAL\b/i.test(val)) {
      return 'SPOT/TVC';
    }
  }

  if (canonical.captionName && COMMERCIAL_CAPTION_REGEX.test(canonical.captionName.trim().toUpperCase())) {
    return 'SPOT/TVC';
  }

  // If caption strongly indicates a Song or Program (e.g. "Pasoori Song", "Drama Serial Ep 12"),
  // keep it as PROGRAM even if it appeared in a commercial file or has a commercialID/brandName.
  if (isSongOrProgramInCaption) {
    return 'PROGRAM';
  }

  // Relational/file-role cues ONLY when Sponsorship, Media/Promo, and Program/Song were ruled out:
  if (role === 'trcommercial' || role === 'tcommercial') {
    return 'SPOT/TVC';
  }

  // In schedule logs without an explicit EntryType, only treat as SPOT/TVC if an explicit
  // commercialID is present (never based solely on brandName or logo).
  if (role !== 'reviewed_captions' && isMeaningfulValue(canonical.commercialID)) {
    return 'SPOT/TVC';
  }

  // =========================================================================
  // PRIORITY 4: Regular broadcast content -> PROGRAM
  // All normal TV programming (dramas, news, talk shows, interviews,
  // entertainment, documentaries, reality, sports, music programs, songs).
  // =========================================================================
  return 'PROGRAM';
}

export function parseAutosaveXmlBuffer(params: {
  buffer: Buffer;
  fileName: string;
  relativePath: string;
  customMappings: CustomFieldMapping[];
  existingFileHashes: Set<string>;
  customTypeMap?: Map<string, EntryType>;
}): ParsedXmlFileResult {
  const { buffer, fileName, relativePath, customMappings, existingFileHashes, customTypeMap } = params;
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const alreadyImported = existingFileHashes.has(sha256);

  const customAliasMap = new Map<string, string>();
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
        detectedRole: 'invalid',
        hasInlineSchema: false,
        rootElement: null,
        recordElement: null,
        recordCount: 0,
        schemaFields: [],
        mappedFields: [],
        unmappedFields: [],
        parseErrors: ['File does not contain XML markup (skipped as non-XML file).'],
        alreadyImported,
      },
      records: [],
      metadataEntries: [],
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
        detectedRole: 'invalid',
        hasInlineSchema: false,
        rootElement: null,
        recordElement: null,
        recordCount: 0,
        schemaFields: [],
        mappedFields: [],
        unmappedFields: [],
        parseErrors: [
          `Malformed XML at line ${validation.err.line}, col ${validation.err.col}: ${validation.err.msg}`,
        ],
        alreadyImported,
      },
      records: [],
      metadataEntries: [],
    };
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: false,
    allowBooleanAttributes: true,
  });

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: true,
    suppressEmptyNode: true,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(text) as Record<string, unknown>;
  } catch (err) {
    return {
      inspection: {
        relativePath,
        fileName,
        fileSize: buffer.length,
        sha256,
        isXml: true,
        detectedRole: 'invalid',
        hasInlineSchema: false,
        rootElement: null,
        recordElement: null,
        recordCount: 0,
        schemaFields: [],
        mappedFields: [],
        unmappedFields: [],
        parseErrors: [err instanceof Error ? err.message : 'XML parsing failed'],
        alreadyImported,
      },
      records: [],
      metadataEntries: [],
    };
  }

  const rootKeys = Object.keys(parsed).filter((k) => k !== '?xml' && !k.startsWith('@_'));
  const rootElement = rootKeys[0] ?? null;
  const rootNode = rootElement ? parsed[rootElement] : null;

  // Check for pure schema root
  if (rootElement && stripNs(rootElement).toLowerCase() === 'schema') {
    const schemaFields = extractSchemaFields(rootNode);
    return {
      inspection: {
        relativePath,
        fileName,
        fileSize: buffer.length,
        sha256,
        isXml: true,
        detectedRole: 'schema_only',
        hasInlineSchema: true,
        rootElement,
        recordElement: null,
        recordCount: 0,
        schemaFields,
        mappedFields: [],
        unmappedFields: [],
        parseErrors: [],
        alreadyImported,
      },
      records: [],
      metadataEntries: [],
    };
  }

  // Check for inline xs:schema / xsd:schema inside rootNode
  let schemaFields: Array<{ name: string; type: string }> = [];
  let hasInlineSchema = false;
  if (rootNode && typeof rootNode === 'object' && !Array.isArray(rootNode)) {
    const rootObj = rootNode as Record<string, unknown>;
    for (const key of Object.keys(rootObj)) {
      if (stripNs(key).toLowerCase() === 'schema') {
        hasInlineSchema = true;
        schemaFields = extractSchemaFields(rootObj[key]);
      }
    }
  }

  const { recordElement, rawObjects } = extractRecordsFromNode(rootNode);

  const mappedSamples = new Map<string, { xmlTag: string; canonicalField: string; sampleValue: string }>();
  const unmappedSamples = new Map<string, { xmlTag: string; sampleValue: string }>();
  const mappedCanonicalKeys = new Set<string>();

  const records: ParsedRecord[] = [];
  const metadataEntries: Record<string, string>[] = [];

  for (const rawObj of rawObjects) {
    const canonical: Record<string, string> = {};
    const extra: Record<string, string> = {};

    for (const [rawKey, rawVal] of Object.entries(rawObj)) {
      if (rawKey.startsWith('@_diffgr:') || rawKey.startsWith('@_msdata:')) {
        continue;
      }
      const cleanTag = rawKey.startsWith('@_') ? rawKey.slice(2) : rawKey;
      const valStr = flattenScalarValue(rawVal);
      const lowerTag = cleanTag.toLowerCase();

      const mappedName =
        customAliasMap.get(lowerTag) ??
        ALIAS_TO_CANONICAL.get(lowerTag) ??
        ALIAS_TO_CANONICAL.get(lowerTag.replace(/[_-]/g, ''));

      if (mappedName) {
        if (!canonical[mappedName] && valStr !== '') {
          canonical[mappedName] = valStr;
        } else if (!(mappedName in canonical)) {
          canonical[mappedName] = valStr;
        }
        mappedCanonicalKeys.add(mappedName);
        if (!mappedSamples.has(cleanTag)) {
          mappedSamples.set(cleanTag, {
            xmlTag: cleanTag,
            canonicalField: mappedName,
            sampleValue: valStr.slice(0, 80),
          });
        }
      } else {
        if (valStr !== '') {
          extra[cleanTag] = valStr;
        }
        if (!unmappedSamples.has(cleanTag)) {
          unmappedSamples.set(cleanTag, {
            xmlTag: cleanTag,
            sampleValue: valStr.slice(0, 80),
          });
        }
      }
    }

    const rowTag = recordElement ?? 'Record';
    let rawXml = '';
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
      entryType: 'PROGRAM', // Refined after role detection
      transDate,
      rawTransDate,
      startTimeNormalized: startParsed.normalized,
      endTimeNormalized: endParsed.normalized,
      startSeconds: startParsed.seconds,
      endSeconds: endParsed.seconds,
      durationSeconds,
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

  // Refine entryType with detectedRole context
  for (const rec of records) {
    rec.entryType = classifyEntryType(rec.canonical, detectedRole, customTypeMap);
    if (detectedRole === 'metadata') {
      metadataEntries.push({ ...rec.canonical, ...rec.extra });
    }
  }

  // If root itself is flat metadata without child record elements
  if (detectedRole === 'metadata' && records.length === 0 && rootNode && typeof rootNode === 'object') {
    const flatMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(rootNode as Record<string, unknown>)) {
      if (!k.startsWith('@_') && stripNs(k).toLowerCase() !== 'schema') {
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
      alreadyImported,
    },
    records,
    metadataEntries,
  };
}
