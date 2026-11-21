import ExcelJS from 'exceljs';
import type { ChannelEntry, QaIssue } from '../src/types.ts';
import { getDb } from './db.ts';

export type ReportType =
  | 'complete'
  | 'spot_tvc'
  | 'advertisements'
  | 'programs'
  | 'media'
  | 'promos'
  | 'sponsorship'
  | 'spns'
  | 'qa_errors'
  | 'suspicious'
  | 'daily_summary';

interface DailySummaryRow {
  channel_name: string;
  trans_date: string;
  total_entries: number;
  program_count: number;
  program_duration_sec: number;
  spot_tvc_count: number;
  spot_tvc_duration_sec: number;
  media_count: number;
  media_duration_sec: number;
  sponsorship_count: number;
  sponsorship_duration_sec: number;
  total_duration_sec: number;
  red_count: number;
  yellow_count: number;
  green_count: number;
  pending_count: number;
}

function styleHeaderRow(sheet: ExcelJS.Worksheet, columnCount: number) {
  const row = sheet.getRow(1);
  row.height = 24;
  row.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  row.alignment = { vertical: 'middle', horizontal: 'left' };
  for (let c = 1; c <= columnCount; c++) {
    const cell = row.getCell(c);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0B1528' },
    };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF334155' } },
    };
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columnCount },
  };
}

function applyQaCellColor(cell: ExcelJS.Cell, status: string) {
  if (status === 'RED') {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    cell.font = { bold: true, color: { argb: 'FFB91C1C' } };
  } else if (status === 'YELLOW') {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    cell.font = { bold: true, color: { argb: 'FFB45309' } };
  } else if (status === 'GREEN') {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
    cell.font = { bold: true, color: { argb: 'FF15803D' } };
  }
}

export async function generateExcelReport(params: {
  reportType: ReportType;
  channelKey?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<{ buffer: Buffer; fileName: string }> {
  const db = getDb();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TV-TASKVERIFY';
  workbook.created = new Date();

  const whereEntries: string[] = ['is_deleted_record = 0'];
  const entryArgs: unknown[] = [];

  if (params.channelKey) {
    whereEntries.push('channel_key = ?');
    entryArgs.push(params.channelKey);
  }
  if (params.dateFrom) {
    whereEntries.push('trans_date >= ?');
    entryArgs.push(params.dateFrom);
  }
  if (params.dateTo) {
    whereEntries.push('trans_date <= ?');
    entryArgs.push(params.dateTo);
  }

  const stamp = new Date().toISOString().slice(0, 10);

  if (params.reportType === 'daily_summary') {
    const sheet = workbook.addWorksheet('Daily Channel Summary');
    sheet.columns = [
      { header: 'Channel Name', key: 'channel_name', width: 24 },
      { header: 'Broadcast Date', key: 'trans_date', width: 15 },
      { header: 'Total Entries', key: 'total_entries', width: 14 },
      { header: 'PROGRAM Count', key: 'program_count', width: 15 },
      { header: 'PROGRAM Duration (sec)', key: 'program_duration_sec', width: 22 },
      { header: 'SPOT/TVC Count', key: 'spot_tvc_count', width: 16 },
      { header: 'SPOT/TVC Duration (sec)', key: 'spot_tvc_duration_sec', width: 23 },
      { header: 'MEDIA Count', key: 'media_count', width: 14 },
      { header: 'MEDIA Duration (sec)', key: 'media_duration_sec', width: 20 },
      { header: 'SPONSORSHIP Count', key: 'sponsorship_count', width: 19 },
      { header: 'SPONSORSHIP Duration (sec)', key: 'sponsorship_duration_sec', width: 25 },
      { header: 'Total Duration (sec)', key: 'total_duration_sec', width: 20 },
      { header: 'RED Errors', key: 'red_count', width: 13 },
      { header: 'YELLOW Suspicious', key: 'yellow_count', width: 17 },
      { header: 'GREEN Clean', key: 'green_count', width: 14 },
      { header: 'Pending QA', key: 'pending_count', width: 13 },
    ];

    const rows = db
      .prepare(
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
         WHERE ${whereEntries.join(' AND ')}
         GROUP BY channel_name, COALESCE(trans_date, 'Unspecified')
         ORDER BY trans_date DESC, channel_name ASC`
      )
      .all(...entryArgs) as DailySummaryRow[];

    for (const r of rows) {
      const added = sheet.addRow(r);
      added.getCell('program_duration_sec').numFmt = '#,##0.00';
      added.getCell('spot_tvc_duration_sec').numFmt = '#,##0.00';
      added.getCell('media_duration_sec').numFmt = '#,##0.00';
      added.getCell('sponsorship_duration_sec').numFmt = '#,##0.00';
      added.getCell('total_duration_sec').numFmt = '#,##0.00';
      if (r.red_count > 0) applyQaCellColor(added.getCell('red_count'), 'RED');
      if (r.yellow_count > 0) applyQaCellColor(added.getCell('yellow_count'), 'YELLOW');
    }

    styleHeaderRow(sheet, sheet.columns.length);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    return { buffer: buf, fileName: `Daily_Channel_Summary_${stamp}.xlsx` };
  }

  if (params.reportType === 'qa_errors' || params.reportType === 'suspicious') {
    const severity = params.reportType === 'qa_errors' ? 'RED' : 'YELLOW';
    const sheet = workbook.addWorksheet(
      severity === 'RED' ? 'QA Confirmed Errors (RED)' : 'Suspicious Entries (YELLOW)'
    );
    sheet.columns = [
      { header: 'Severity', key: 'severity', width: 12 },
      { header: 'Channel Name', key: 'channel_name', width: 22 },
      { header: 'Date', key: 'trans_date', width: 13 },
      { header: 'Entry ID', key: 'entry_id', width: 24 },
      { header: 'MasterEntryID', key: 'master_entry_id', width: 16 },
      { header: 'Content Category', key: 'entry_type', width: 16 },
      { header: 'Sub-Category / XML Category', key: 'category_name', width: 22 },
      { header: 'Brand Name', key: 'brand_name', width: 20 },
      { header: 'Caption Name', key: 'caption_name', width: 26 },
      { header: 'Start Time', key: 'start_time', width: 14 },
      { header: 'End Time', key: 'end_time', width: 14 },
      { header: 'Duration (s)', key: 'duration_seconds', width: 13 },
      { header: 'Error Type', key: 'error_type', width: 28 },
      { header: 'Reason for Detection', key: 'reason', width: 52 },
      { header: 'Confidence / Evidence', key: 'confidence_level', width: 28 },
      { header: 'Resolution Status', key: 'resolution_status', width: 16 },
    ];

    const whereIssues = ['q.severity = ?'];
    const issueArgs: unknown[] = [severity];
    if (params.channelKey) {
      whereIssues.push('q.channel_key = ?');
      issueArgs.push(params.channelKey);
    }
    if (params.dateFrom) {
      whereIssues.push('q.trans_date >= ?');
      issueArgs.push(params.dateFrom);
    }
    if (params.dateTo) {
      whereIssues.push('q.trans_date <= ?');
      issueArgs.push(params.dateTo);
    }

    const issues = db
      .prepare(
        `SELECT q.*, COALESCE(e.entry_type, q.entry_type) AS entry_type,
                e.master_entry_id, e.category_name, e.brand_name, e.caption_name,
                e.start_time, e.end_time, e.duration_seconds
         FROM qa_issues q
         LEFT JOIN entries e ON e.id = q.entry_id
         WHERE ${whereIssues.join(' AND ')}
         ORDER BY q.channel_name ASC, COALESCE(q.trans_date, '') ASC, COALESCE(e.start_seconds, 999999) ASC`
      )
      .all(...issueArgs) as QaIssue[];

    for (const item of issues) {
      const row = sheet.addRow(item);
      applyQaCellColor(row.getCell('severity'), item.severity);
      row.getCell('duration_seconds').numFmt = '0.00';
      row.getCell('reason').alignment = { wrapText: true };
    }

    styleHeaderRow(sheet, sheet.columns.length);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    const prefix = severity === 'RED' ? 'QA_Error_Report' : 'Suspicious_Entries_Report';
    return { buffer: buf, fileName: `${prefix}_${stamp}.xlsx` };
  }

  // Entry-based reports: complete, spot_tvc (advertisements), programs, media (promos), sponsorship (spns)
  const typeFilterMap: Record<string, string | null> = {
    complete: null,
    spot_tvc: 'SPOT/TVC',
    advertisements: 'SPOT/TVC',
    programs: 'PROGRAM',
    media: 'MEDIA',
    promos: 'MEDIA',
    sponsorship: 'SPONSORSHIP',
    spns: 'SPONSORSHIP',
  };
  const targetType = typeFilterMap[params.reportType];
  if (targetType) {
    whereEntries.push('entry_type = ?');
    entryArgs.push(targetType);
  }

  // Note: Excel worksheet tab names forbid "/" character
  const sheetNames: Record<string, string> = {
    complete: 'Complete Channel Data',
    spot_tvc: 'SPOT-TVC Report',
    advertisements: 'SPOT-TVC Report',
    programs: 'PROGRAM Report',
    media: 'MEDIA Report',
    promos: 'MEDIA Report',
    sponsorship: 'SPONSORSHIP Report',
    spns: 'SPONSORSHIP Report',
  };

  const sheet = workbook.addWorksheet(sheetNames[params.reportType] ?? 'Report');
  sheet.columns = [
    { header: 'QA Status', key: 'qa_status', width: 12 },
    { header: 'Channel ID', key: 'channel_id', width: 13 },
    { header: 'Channel Name', key: 'channel_name', width: 22 },
    { header: 'Date', key: 'trans_date', width: 13 },
    { header: 'Content Category', key: 'entry_type', width: 16 },
    { header: 'MasterEntryID', key: 'master_entry_id', width: 16 },
    { header: 'SegmentDetailID', key: 'segment_detail_id', width: 16 },
    { header: 'CommercialID', key: 'commercial_id', width: 15 },
    { header: 'Start Time', key: 'start_time', width: 14 },
    { header: 'End Time', key: 'end_time', width: 14 },
    { header: 'Duration (s)', key: 'duration_seconds', width: 13 },
    { header: 'SourceDuration (s)', key: 'source_duration', width: 16 },
    { header: 'XML Category', key: 'category_name', width: 18 },
    { header: 'Subcategory', key: 'subcategory_name', width: 18 },
    { header: 'Brand Name', key: 'brand_name', width: 20 },
    { header: 'Caption Name', key: 'caption_name', width: 28 },
    { header: 'Company', key: 'company_name', width: 20 },
    { header: 'Video File', key: 'video_file_name', width: 24 },
    { header: 'MatchCoverage', key: 'match_coverage', width: 14 },
    { header: 'Manually Edited', key: 'edited_label', width: 15 },
    { header: 'Source Role', key: 'source_role', width: 16 },
  ];

  const entries = db
    .prepare(
      `SELECT * FROM entries
       WHERE ${whereEntries.join(' AND ')}
       ORDER BY channel_name ASC, COALESCE(trans_date, '') ASC, COALESCE(start_seconds, 999999) ASC`
    )
    .all(...entryArgs) as ChannelEntry[];

  for (const e of entries) {
    const row = sheet.addRow({
      ...e,
      edited_label: e.is_manually_edited ? 'Yes' : 'No',
    });
    applyQaCellColor(row.getCell('qa_status'), e.qa_status);
    row.getCell('duration_seconds').numFmt = '0.00';
    row.getCell('source_duration').numFmt = '0.00';
  }

  styleHeaderRow(sheet, sheet.columns.length);
  const buf = Buffer.from(await workbook.xlsx.writeBuffer());
  const fileLabel = (sheetNames[params.reportType] ?? 'Report').replace(/[\s/]+/g, '_');
  return { buffer: buf, fileName: `${fileLabel}_${stamp}.xlsx` };
}
