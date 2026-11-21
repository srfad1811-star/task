import { useEffect, useState } from 'react';
import { Download, FileSpreadsheet, FileText, Printer, ShieldAlert, ShieldCheck, Tv2 } from 'lucide-react';
import type { ChannelSummary } from '../types.ts';
import { formatDuration } from '../lib/formatters.ts';
import { getAuthHeaders } from '../lib/apiAuth.ts';

interface ReportsViewProps {
  refreshKey: number;
}

const REPORT_CARDS = [
  {
    key: 'complete',
    durationKey: null,
    title: 'Complete Channel Broadcast Report',
    desc: 'All active monitoring entries across MEDIA, SPONSORSHIP, SPOT/TVC, and PROGRAM with timestamps, durations, and QA status.',
    icon: Tv2,
  },
  {
    key: 'daily_summary',
    durationKey: null,
    title: 'Daily Channel Summary Report',
    desc: 'Separate daily counts & durations per channel for PROGRAM, SPOT/TVC, MEDIA, SPONSORSHIP, total airtime, and QA breakdown.',
    icon: FileSpreadsheet,
  },
  {
    key: 'spot_tvc',
    durationKey: 'spot_tvc_duration_sec',
    title: 'SPOT/TVC Report (Commercial Ads)',
    desc: 'Exclusively genuine commercial SPOT/TVC entries including CommercialID, Brand, SourceDuration, and MatchCoverage.',
    icon: FileText,
  },
  {
    key: 'programs',
    durationKey: 'programs_duration_sec',
    title: 'PROGRAM Broadcast Report',
    desc: 'All PROGRAM entries (dramas, news, talk shows, sports, music programs, songs) with durations and QA status.',
    icon: Tv2,
  },
  {
    key: 'media',
    durationKey: 'media_duration_sec',
    title: 'MEDIA Report (Promos / Teasers / Trailers)',
    desc: 'All MEDIA entries (channel promos, show promos, upcoming promos, teasers, trailers, announcements) with timing and QA status.',
    icon: FileText,
  },
  {
    key: 'sponsorship',
    durationKey: 'sponsorship_duration_sec',
    title: 'SPONSORSHIP Report (SPN)',
    desc: 'All SPONSORSHIP (SPN, sponsor bumpers, sponsorship announcements, sponsored identifiers) with brand, duration, and QA status.',
    icon: FileText,
  },
  {
    key: 'qa_errors',
    durationKey: null,
    title: 'Autosave QA Error Report (RED)',
    desc: 'Confirmed structural, overlap, duration, category, and deleted-record gap errors.',
    icon: ShieldAlert,
  },
  {
    key: 'suspicious',
    durationKey: null,
    title: 'Suspicious & Gap Report (YELLOW)',
    desc: 'Suspected timeline gaps, missing metadata, placement anomalies, and items pending manual review.',
    icon: ShieldCheck,
  },
] as const;

export function ReportsView({ refreshKey }: ReportsViewProps) {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [channelKey, setChannelKey] = useState('ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/channels', { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((data) => setChannels(Array.isArray(data) ? data : []));
  }, [refreshKey]);

  useEffect(() => {
    const params = new URLSearchParams({ channelKey });
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    fetch(`/api/reports/preview?${params.toString()}`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((data) => setCounts(data ?? {}));
  }, [channelKey, dateFrom, dateTo, refreshKey]);

  async function downloadWithAuth(url: string, fallbackName: string, key: string) {
    setDownloading(key);
    try {
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (!res.ok) return;
      const blob = await res.blob();
      const disp = res.headers.get('content-disposition') || '';
      const match = disp.match(/filename="([^"]+)"/i);
      const fileName = match?.[1] || fallbackName;
      const objUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objUrl);
    } finally {
      setTimeout(() => setDownloading(null), 400);
    }
  }

  function handleDownloadExcel(reportType: string) {
    const params = new URLSearchParams({ reportType, channelKey });
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    downloadWithAuth(
      `/api/reports/export?${params.toString()}`,
      `Broadcast_Report_${reportType}.xlsx`,
      `excel_${reportType}`
    );
  }

  function handleDownloadCsv(reportType: string) {
    const params = new URLSearchParams({ reportType, channelKey });
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    downloadWithAuth(
      `/api/reports/export/csv?${params.toString()}`,
      `Broadcast_Report_${reportType}.csv`,
      `csv_${reportType}`
    );
  }

  function handlePrint() {
    window.print();
  }

  return (
    <div className="space-y-6">
      {/* Filter Toolbar */}
      <div className="rounded border border-[#E5E2DC] bg-white p-5 flex flex-wrap items-end justify-between gap-4 ">
        <div>
          <h2 className="text-base font-semibold text-[#141413] flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-[#C83A1B]" /> Broadcast QA & Monitoring Reports
          </h2>
          <p className="mt-1 text-xs text-[#57534E]">
            Export formatted Excel workbooks (.xlsx) and CSV spreadsheets, or print broadcast compliance certificates.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="block text-[11px] font-medium text-[#57534E] mb-1">Filter Channel</label>
            <select
              value={channelKey}
              onChange={(e) => setChannelKey(e.target.value)}
              className="rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs text-[#141413]"
            >
              <option value="ALL">All Channels</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.channel_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-[#57534E] mb-1">Date From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs font-mono text-[#141413]"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-[#57534E] mb-1">Date To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs font-mono text-[#141413]"
            />
          </div>

          <button
            onClick={handlePrint}
            className="inline-flex items-center gap-1.5 rounded border border-[#D4CFC5] bg-[#FCFBF9] px-3.5 py-1.5 text-xs font-medium text-[#57534E] hover:bg-[#F4F2ED]"
            title="Print or Save as PDF"
          >
            <Printer className="h-3.5 w-3.5" /> Print / PDF
          </button>
        </div>
      </div>

      {/* Report Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {REPORT_CARDS.map((rep) => {
          const rowCount = counts[rep.key] ?? 0;
          const durSec = rep.durationKey ? counts[rep.durationKey] : undefined;
          const isExcelLoading = downloading === `excel_${rep.key}`;
          const isCsvLoading = downloading === `csv_${rep.key}`;

          return (
            <div
              key={rep.key}
              className="rounded border border-[#E5E2DC] bg-white p-5 flex flex-col justify-between gap-4  hover: transition-shadow"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <rep.icon className="h-4 w-4 text-[#C83A1B] shrink-0" />
                    <h3 className="text-xs font-semibold text-[#141413] leading-tight">{rep.title}</h3>
                  </div>
                  <span className="font-mono tabular-nums text-xs font-bold text-[#57534E] bg-[#F4F2ED] px-2 py-0.5 rounded">
                    {rowCount.toLocaleString()}
                  </span>
                </div>
                {durSec !== undefined && (
                  <div className="text-[11px] font-mono tabular-nums text-[#57534E]">
                    Total Airtime: <strong className="text-[#141413]">{formatDuration(durSec)}</strong>
                  </div>
                )}
                <p className="text-[11px] text-[#78716C] leading-relaxed">{rep.desc}</p>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-[#E5E2DC]">
                <button
                  onClick={() => handleDownloadExcel(rep.key)}
                  disabled={Boolean(downloading)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded bg-[#141413] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[#2A2927] disabled:opacity-50"
                  title="Download Formatted Excel Workbook"
                >
                  <Download className="h-3 w-3" />
                  <span>{isExcelLoading ? 'Exporting…' : 'Excel (.xlsx)'}</span>
                </button>
                <button
                  onClick={() => handleDownloadCsv(rep.key)}
                  disabled={Boolean(downloading)}
                  className="inline-flex items-center justify-center gap-1 rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs font-medium text-[#57534E] hover:bg-[#F4F2ED] disabled:opacity-50"
                  title="Download CSV Spreadsheet"
                >
                  <span>{isCsvLoading ? '…' : 'CSV'}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
