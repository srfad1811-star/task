import type { EntryType } from '../src/types.ts';
import { getCustomEntryTypeMappings, getDb, logAudit } from './db.ts';
import { classifyEntryType, normalizeEntryType } from './xmlParser.ts';

export function buildCustomTypeMap(): Map<string, EntryType> {
  const list = getCustomEntryTypeMappings();
  const map = new Map<string, EntryType>();
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

export function reclassifyStoredEntries(options?: {
  onlyLegacy?: boolean;
  log?: boolean;
}): { updated: number; totalChecked: number } {
  const db = getDb();
  const customTypeMap = buildCustomTypeMap();

  const where = ['is_manually_edited = 0'];
  if (options?.onlyLegacy) {
    where.push(`entry_type NOT IN ('MEDIA', 'SPONSORSHIP', 'SPOT/TVC', 'PROGRAM')`);
  }

  const rows = db
    .prepare(
      `SELECT id, source_role, entry_type, raw_entry_type, commercial_type_name,
              category_name, subcategory_name, commercial_id, brand_name, caption_name,
              company_name, txt
       FROM entries
       WHERE ${where.join(' AND ')}`
    )
    .all() as Array<{
    id: string;
    source_role: string;
    entry_type: string;
    raw_entry_type: string | null;
    commercial_type_name: string | null;
    category_name: string | null;
    subcategory_name: string | null;
    commercial_id: string | null;
    brand_name: string | null;
    caption_name: string | null;
    company_name: string | null;
    txt: string | null;
  }>;

  const updateStmt = db.prepare(`UPDATE entries SET entry_type = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();
  let updated = 0;

  const tx = db.transaction(() => {
    // 1. Migrate any manually-edited rows that still hold legacy category names
    //    (ADVERTISEMENT -> SPOT/TVC, PROMO -> MEDIA, SPN -> SPONSORSHIP, OTHER -> PROGRAM)
    //    while preserving the user's manual selection.
    const legacyManualRows = db
      .prepare(
        `SELECT id, entry_type FROM entries
         WHERE is_manually_edited = 1
           AND entry_type NOT IN ('MEDIA', 'SPONSORSHIP', 'SPOT/TVC', 'PROGRAM')`
      )
      .all() as Array<{ id: string; entry_type: string }>;

    for (const r of legacyManualRows) {
      const migrated = normalizeEntryType(r.entry_type) ?? 'PROGRAM';
      if (migrated !== r.entry_type) {
        updateStmt.run(migrated, now, r.id);
        updated++;
      }
    }

    // 2. Re-run classification on all non-manually-edited entries
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
          txt: r.txt,
        },
        r.source_role,
        customTypeMap
      );

      if (nextType !== r.entry_type) {
        updateStmt.run(nextType, now, r.id);
        updated++;
      }
    }

    // 3. Keep qa_issues.entry_type synchronized with entries.entry_type everywhere
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

    // 4. Normalize any legacy custom_entry_type_mappings stored in app_settings
    const rawMappings = getCustomEntryTypeMappings();
    let mappingsChanged = false;
    const normalizedMappings = rawMappings
      .map((m) => {
        const norm = normalizeEntryType(m.targetType);
        if (norm && norm !== m.targetType) {
          mappingsChanged = true;
          return { rawValue: m.rawValue, targetType: norm };
        }
        return m;
      })
      .filter((m) => normalizeEntryType(m.targetType) !== null);
    if (mappingsChanged) {
      db.prepare(
        `UPDATE app_settings SET value_json = ?, updated_at = ? WHERE key = 'custom_entry_type_mappings'`
      ).run(JSON.stringify(normalizedMappings), now);
    }

    // 5. Backfill channel_name from channels table if entry had generic fallback name
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
      entityType: 'ENTRY',
      entityId: 'bulk_reclassify',
      action: 'ENTRIES_RECLASSIFIED',
      newValue: `${updated} entries updated`,
    });
  }

  return { updated, totalChecked: rows.length };
}
