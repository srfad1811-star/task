import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudDownload, Play, Search } from 'lucide-react';
import type { ChannelSummary } from '../types.ts';
import { getAuthHeaders } from '../lib/apiAuth.ts';
import { formatBytes } from '../lib/formatters.ts';

interface HistoricalDayResult {
  date: string;
  status: 'COMPLETE_24H' | 'PARTIAL' | 'UNAVAILABLE';
  coveredHours: number;
  availableHourList: number[];
  missingHourList: number[];
  segmentCount: number;
  totalBytes: number;
  autosaveEntryCount: number;
  segments: Array<{ id: string; start_seconds: number; end_seconds: number; duration_seconds: number }>;
}

interface HistoricalSearchResponse {
  channel: { id: string; channel_name: string };
  recordingPermission: string;
  historicalArchiveEndpoint: string | null;
  notice: string;
  days: HistoricalDayResult[];
}

interface HistoricalSearchViewProps {
  refreshKey: number;
  onPlaySegment: (archiveId: string, startOffsetSeconds?: number) => void;
}

export function HistoricalSearchView({ refreshKey, onPlaySegment }: HistoricalSearchViewProps) {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [channelKey, setChannelKey] = useState('');
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(Date.now() - 13 * 86400_000);
    return d.toISOString().slice(0, 10);
  });

  const [result, setResult] = useState<HistoricalSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);

  // Authorized Historical Import form
  const [importDate, setImportDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [importHour, setImportHour] = useState(0);
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/channels')
      .then((r) => r.json())
      .then((data: ChannelSummary[]) => {
        const list = data ?? [];
        setChannels(list);
        if (!channelKey && list.length > 0) {
          setChannelKey(list[0].id);
        }
      });
  }, [refreshKey]);

  async function runSearch(targetKey = channelKey) {
    if (!targetKey) return;
    setSearching(true);
    try {
      const params = new URLSearchParams({
        channelKey: targetKey,
        dateFrom,
        dateTo,
      });
      const res = await fetch(`/api/historical/search?${params.toString()}`);
      if (res.ok) {
        setResult(await res.json());
      }
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    if (channelKey) {
      runSearch(channelKey);
    }
  }, [channelKey]);

  async function handleImportHistorical(e: React.FormEvent) {
    e.preventDefault();
    if (!channelKey || !importUrl.trim()) return;
    setImporting(true);
    setNotice(null);
    try {
      const res = await fetch('/api/historical/import', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          channelKey,
          recordDate: importDate,
          startHour: importHour,
          sourceUrl: importUrl.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setNotice({ kind: 'err', text: json.error || 'Historical import failed.' });
      } else {
        setNotice({
          kind: 'ok',
          text: `Authorized historical recording imported and archived (${importDate} ${String(importHour).padStart(2, '0')}:00 UTC).`,
        });
        setImportUrl('');
        await runSearch(channelKey);
      }
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] text-[#141413] dark:text-stone-100">
          Historical Video Search
        </h2>
        <p className="mt-1 text-[13px] text-[#57534E] dark:text-stone-400">
          Inspect real 24-hour recording coverage per channel and date, or import an authorized catch-up recording into cloud storage.
        </p>
      </div>

      {/* Search Controls */}
      <section className="rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-white dark:bg-stone-900 p-4 flex flex-wrap items-end gap-3 text-xs">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-[11px] text-[#78716C] dark:text-stone-400 mb-1">Channel</label>
          <select
            value={channelKey}
            onChange={(e) => setChannelKey(e.target.value)}
            className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-1.5 text-[#141413] dark:text-stone-100"
          >
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.channel_name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] text-[#78716C] dark:text-stone-400 mb-1">From Date</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-1.5 font-mono text-[#141413] dark:text-stone-100"
          />
        </div>

        <div>
          <label className="block text-[11px] text-[#78716C] dark:text-stone-400 mb-1">To Date</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-1.5 font-mono text-[#141413] dark:text-stone-100"
          />
        </div>

        <button
          onClick={() => runSearch()}
          disabled={searching || !channelKey}
          className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#141413] dark:bg-stone-100 px-4 py-1.5 font-medium text-white dark:text-stone-900 hover:bg-[#2A2927] disabled:opacity-50"
        >
          <Search className="h-3.5 w-3.5" />
          {searching ? 'Searching…' : 'Check Availability'}
        </button>
      </section>

      {/* Honest Notice */}
      {result && (
        <div className="rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-[#FCFBF9] dark:bg-stone-950 px-4 py-3 text-xs text-[#57534E] dark:text-stone-400 flex flex-wrap items-center justify-between gap-2">
          <span>{result.notice}</span>
          <span className="font-mono text-[11px] text-[#78716C]">
            Permission: {result.recordingPermission}
          </span>
        </div>
      )}

      {/* Availability Table */}
      <section className="rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-white dark:bg-stone-900 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#E5E2DC] dark:border-stone-800 bg-[#FCFBF9] dark:bg-stone-950 text-[11px] font-medium text-[#78716C] dark:text-stone-400">
              <tr>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Archive Availability</th>
                <th className="px-4 py-2.5">24-Hour Coverage</th>
                <th className="px-4 py-2.5 text-right">Segments</th>
                <th className="px-4 py-2.5 text-right">Size</th>
                <th className="px-4 py-2.5 text-right">Autosave Records</th>
                <th className="px-4 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EFECE6] dark:divide-stone-800">
              {!result || result.days.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-[#78716C]">
                    Select a channel and date range to inspect historical archive availability.
                  </td>
                </tr>
              ) : (
                result.days.map((day) => (
                  <tr key={day.date} className="hover:bg-[#F8F7F4] dark:hover:bg-stone-800/50">
                    <td className="px-4 py-2.5 font-mono tabular-nums font-medium text-[#141413] dark:text-stone-100 whitespace-nowrap">
                      {day.date}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {day.status === 'COMPLETE_24H' ? (
                        <span className="text-[#15803D] dark:text-emerald-400 font-semibold">
                          Complete 24-Hour Recording
                        </span>
                      ) : day.status === 'PARTIAL' ? (
                        <span className="text-[#A16207] dark:text-amber-400 font-semibold">
                          Partial ({day.coveredHours}h / 24h)
                        </span>
                      ) : (
                        <span className="text-[#8A847C]">Unavailable</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-0.5">
                        {Array.from({ length: 24 }).map((_, hr) => {
                          const hasHr = day.availableHourList.includes(hr);
                          return (
                            <span
                              key={hr}
                              title={`${String(hr).padStart(2, '0')}:00 — ${hasHr ? 'Available' : 'Unavailable'}`}
                              className={`inline-block h-3 w-1.5 rounded-[1px] ${
                                hasHr
                                  ? 'bg-[#15803D] dark:bg-emerald-500'
                                  : 'bg-[#E5E2DC] dark:bg-stone-800'
                              }`}
                            />
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#57534E] dark:text-stone-300">
                      {day.segmentCount}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#57534E] dark:text-stone-300">
                      {formatBytes(day.totalBytes)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#57534E] dark:text-stone-300">
                      {day.autosaveEntryCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {day.segments.length > 0 ? (
                        <button
                          onClick={() => onPlaySegment(day.segments[0].id, 0)}
                          className="inline-flex items-center gap-1 rounded-[3px] bg-[#141413] dark:bg-stone-100 px-2.5 py-1 text-[11px] font-medium text-white dark:text-stone-900"
                        >
                          <Play className="h-3 w-3 fill-current" />
                          Play
                        </button>
                      ) : (
                        <span className="text-[11px] text-[#8A847C]">No Video</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Import Authorized Historical Recording into Cloud Storage */}
      <section className="rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-white dark:bg-stone-900 p-5 space-y-4">
        <div>
          <h3 className="font-display text-sm font-semibold text-[#141413] dark:text-stone-100">
            Import Authorized Historical Recording to Cloud Storage
          </h3>
          <p className="mt-0.5 text-xs text-[#78716C] dark:text-stone-400">
            Provide a permitted broadcaster catch-up or licensed archive media URL. The backend verifies reachability with FFprobe, downloads via FFmpeg, uploads to cloud object storage, and matches any imported autosave timestamps automatically.
          </p>
        </div>

        {notice && (
          <div
            className={`rounded-[3px] border px-3.5 py-2.5 text-xs flex items-center gap-2 ${
              notice.kind === 'ok'
                ? 'border-[#C7DEC9] bg-[#F0F5F2] text-[#14532D]'
                : 'border-[#FCA5A5] bg-[#FEF2F2] text-[#B91C1C]'
            }`}
          >
            {notice.kind === 'ok' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0" />
            )}
            <span>{notice.text}</span>
          </div>
        )}

        <form onSubmit={handleImportHistorical} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end text-xs">
          <div className="md:col-span-2">
            <label className="block text-[11px] text-[#57534E] dark:text-stone-400 mb-1">Broadcast Date</label>
            <input
              type="date"
              value={importDate}
              onChange={(e) => setImportDate(e.target.value)}
              required
              className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-1.5 font-mono"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-[11px] text-[#57534E] dark:text-stone-400 mb-1">Start Hour (UTC)</label>
            <select
              value={importHour}
              onChange={(e) => setImportHour(Number(e.target.value))}
              className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-1.5 font-mono"
            >
              {Array.from({ length: 24 }).map((_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-6">
            <label className="block text-[11px] text-[#57534E] dark:text-stone-400 mb-1">
              Authorized Catch-Up / Archive Media URL (.mp4 / .m3u8)
            </label>
            <input
              type="url"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="https://authorized-archive.example.com/2026-11-18/hour-09.mp4"
              required
              className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-1.5 font-mono"
            />
          </div>

          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={importing || !channelKey}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-[3px] bg-[#C83A1B] px-3.5 py-2 font-medium text-white hover:bg-[#A82E13] disabled:opacity-50"
            >
              <CloudDownload className="h-3.5 w-3.5" />
              {importing ? 'Importing…' : 'Import'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
