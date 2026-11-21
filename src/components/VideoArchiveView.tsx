import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, Play, Search } from 'lucide-react';
import type { ChannelSummary } from '../types.ts';
import { formatBytes, formatSecondsClock } from '../lib/formatters.ts';

interface ArchiveSegmentItem {
  id: string;
  channel_key: string;
  channel_name: string;
  record_date: string;
  year: number;
  month: number;
  day: number;
  start_time_iso: string;
  end_time_iso: string;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  file_size_bytes: number;
  storage_provider: string;
  source_origin: string;
}

interface ArchiveDateNode {
  recordDate: string;
  day: number;
  coveredHoursCount: number;
  missingHours: number[];
  segments: ArchiveSegmentItem[];
}

interface ArchiveMonthNode {
  month: number;
  dates: ArchiveDateNode[];
}

interface ArchiveYearNode {
  year: number;
  months: ArchiveMonthNode[];
}

interface ArchiveChannelNode {
  channelKey: string;
  channelName: string;
  totalSegments: number;
  totalBytes: number;
  years: ArchiveYearNode[];
}

interface VideoArchiveViewProps {
  refreshKey: number;
  initialChannelKey?: string | null;
  onPlaySegment: (archiveId: string, startOffsetSeconds?: number) => void;
  onNavigate: (tab: string) => void;
}

const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function VideoArchiveView({
  refreshKey,
  initialChannelKey,
  onPlaySegment,
  onNavigate,
}: VideoArchiveViewProps) {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [channelKey, setChannelKey] = useState(initialChannelKey || 'ALL');
  const [dateFilter, setDateFilter] = useState('');
  const [timeFilter, setTimeFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [tree, setTree] = useState<ArchiveChannelNode[]>([]);
  const [totalSegments, setTotalSegments] = useState(0);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (initialChannelKey) setChannelKey(initialChannelKey);
  }, [initialChannelKey]);

  useEffect(() => {
    fetch('/api/channels')
      .then((r) => r.json())
      .then((data) => setChannels(data ?? []));
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (channelKey && channelKey !== 'ALL') params.set('channelKey', channelKey);
    if (dateFilter) params.set('date', dateFilter);
    if (timeFilter) params.set('time', timeFilter);

    fetch(`/api/archive/tree?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const nodes: ArchiveChannelNode[] = data.tree ?? [];
        setTree(nodes);
        setTotalSegments(data.totalSegments ?? 0);
        // Auto-expand first channel/year/month/date so hierarchy is immediately scannable
        const nextOpen = new Set<string>();
        for (const ch of nodes.slice(0, 3)) {
          nextOpen.add(`ch:${ch.channelKey}`);
          for (const y of ch.years.slice(0, 1)) {
            nextOpen.add(`y:${ch.channelKey}:${y.year}`);
            for (const m of y.months.slice(0, 1)) {
              nextOpen.add(`m:${ch.channelKey}:${y.year}:${m.month}`);
              for (const d of m.dates.slice(0, 1)) {
                nextOpen.add(`d:${ch.channelKey}:${d.recordDate}`);
              }
            }
          }
        }
        setExpandedKeys(nextOpen);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [channelKey, dateFilter, timeFilter, refreshKey]);

  function toggleKey(k: string) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] text-[#141413] dark:text-stone-100">
            Channel-Wise Video Archive
          </h2>
          <p className="mt-1 text-[13px] text-[#57534E] dark:text-stone-400">
            Verified cloud-stored recording segments organized by Channel → Year → Month → Date → Hourly Segments.
          </p>
        </div>

        <span className="text-xs font-mono tabular-nums text-[#78716C] dark:text-stone-400">
          {totalSegments.toLocaleString()} verified segment{totalSegments === 1 ? '' : 's'}
        </span>
      </div>

      {/* Search & Filter Toolbar */}
      <section className="rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-white dark:bg-stone-900 p-4 flex flex-wrap items-end gap-3 text-xs">
        <div className="min-w-[200px] flex-1">
          <label className="block text-[11px] text-[#78716C] dark:text-stone-400 mb-1">Channel</label>
          <select
            value={channelKey}
            onChange={(e) => setChannelKey(e.target.value)}
            className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-1.5 text-[#141413] dark:text-stone-100"
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
          <label className="block text-[11px] text-[#78716C] dark:text-stone-400 mb-1">Date</label>
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-1.5 font-mono text-[#141413] dark:text-stone-100"
          />
        </div>

        <div>
          <label className="block text-[11px] text-[#78716C] dark:text-stone-400 mb-1">Time (UTC)</label>
          <input
            type="time"
            value={timeFilter}
            onChange={(e) => setTimeFilter(e.target.value)}
            className="rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-1.5 font-mono text-[#141413] dark:text-stone-100"
          />
        </div>

        {(channelKey !== 'ALL' || dateFilter || timeFilter) && (
          <button
            onClick={() => {
              setChannelKey('ALL');
              setDateFilter('');
              setTimeFilter('');
            }}
            className="rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 px-3 py-1.5 text-[#57534E] dark:text-stone-300 hover:bg-[#F4F2ED] dark:hover:bg-stone-800"
          >
            Reset
          </button>
        )}
      </section>

      {/* Hierarchical Archive Tree */}
      {loading ? (
        <div className="h-48 rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-white dark:bg-stone-900 animate-pulse" />
      ) : tree.length === 0 ? (
        <section className="rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-white dark:bg-stone-900 p-12 text-center space-y-3">
          <Search className="h-6 w-6 text-[#8A847C] mx-auto" />
          <h3 className="font-display text-base font-semibold text-[#141413] dark:text-stone-100">
            No Verified Video Recordings Found
          </h3>
          <p className="text-xs text-[#57534E] dark:text-stone-400 max-w-md mx-auto leading-relaxed">
            No completed, verified cloud recordings exist for this filter yet. Configure an authorized stream source in 24/7 Recording Monitor or import an authorized historical recording.
          </p>
          <div className="flex flex-wrap justify-center gap-3 pt-1">
            <button
              onClick={() => onNavigate('recording-monitor')}
              className="rounded-[3px] bg-[#C83A1B] px-4 py-2 text-xs font-medium text-white hover:bg-[#A82E13]"
            >
              Open 24/7 Recording Monitor
            </button>
            <button
              onClick={() => onNavigate('historical-search')}
              className="rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-800 px-4 py-2 text-xs font-medium text-[#141413] dark:text-stone-200"
            >
              Historical Video Search
            </button>
          </div>
        </section>
      ) : (
        <div className="space-y-4">
          {tree.map((ch) => {
            const chOpen = expandedKeys.has(`ch:${ch.channelKey}`);
            return (
              <section
                key={ch.channelKey}
                className="rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-white dark:bg-stone-900 overflow-hidden"
              >
                <button
                  onClick={() => toggleKey(`ch:${ch.channelKey}`)}
                  className="w-full px-5 py-3.5 flex items-center justify-between gap-4 bg-[#FCFBF9] dark:bg-stone-950 border-b border-[#E5E2DC] dark:border-stone-800 text-left"
                >
                  <div className="flex items-center gap-2.5">
                    {chOpen ? (
                      <ChevronDown className="h-4 w-4 text-[#78716C]" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-[#78716C]" />
                    )}
                    <Folder className="h-4 w-4 text-[#C83A1B]" />
                    <span className="font-display text-sm font-semibold text-[#141413] dark:text-stone-100">
                      {ch.channelName}
                    </span>
                  </div>
                  <div className="text-xs text-[#78716C] dark:text-stone-400 font-mono tabular-nums">
                    {ch.totalSegments} segments · {formatBytes(ch.totalBytes)}
                  </div>
                </button>

                {chOpen && (
                  <div className="p-4 space-y-3">
                    {ch.years.map((y) => {
                      const yKey = `y:${ch.channelKey}:${y.year}`;
                      const yOpen = expandedKeys.has(yKey);
                      return (
                        <div key={y.year} className="pl-2">
                          <button
                            onClick={() => toggleKey(yKey)}
                            className="flex items-center gap-2 text-xs font-semibold text-[#141413] dark:text-stone-200 py-1"
                          >
                            {yOpen ? (
                              <ChevronDown className="h-3.5 w-3.5 text-[#78716C]" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-[#78716C]" />
                            )}
                            <span className="font-mono">{y.year}</span>
                          </button>

                          {yOpen && (
                            <div className="pl-5 space-y-2.5 mt-1">
                              {y.months.map((m) => {
                                const mKey = `m:${ch.channelKey}:${y.year}:${m.month}`;
                                const mOpen = expandedKeys.has(mKey);
                                return (
                                  <div key={m.month}>
                                    <button
                                      onClick={() => toggleKey(mKey)}
                                      className="flex items-center gap-2 text-xs font-medium text-[#57534E] dark:text-stone-300 py-1"
                                    >
                                      {mOpen ? (
                                        <ChevronDown className="h-3.5 w-3.5 text-[#8A847C]" />
                                      ) : (
                                        <ChevronRight className="h-3.5 w-3.5 text-[#8A847C]" />
                                      )}
                                      <span>{MONTH_NAMES[m.month] || `Month ${m.month}`}</span>
                                    </button>

                                    {mOpen && (
                                      <div className="pl-5 space-y-3 mt-1.5">
                                        {m.dates.map((d) => {
                                          const dKey = `d:${ch.channelKey}:${d.recordDate}`;
                                          const dOpen = expandedKeys.has(dKey);
                                          return (
                                            <div
                                              key={d.recordDate}
                                              className="rounded-[3px] border border-[#EFECE6] dark:border-stone-800 bg-[#FCFBF9] dark:bg-stone-950"
                                            >
                                              <button
                                                onClick={() => toggleKey(dKey)}
                                                className="w-full px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-left text-xs"
                                              >
                                                <div className="flex items-center gap-2">
                                                  {dOpen ? (
                                                    <ChevronDown className="h-3.5 w-3.5 text-[#78716C]" />
                                                  ) : (
                                                    <ChevronRight className="h-3.5 w-3.5 text-[#78716C]" />
                                                  )}
                                                  <span className="font-mono font-semibold text-[#141413] dark:text-stone-100">
                                                    {d.recordDate}
                                                  </span>
                                                  <span className="text-[#8A847C]">·</span>
                                                  <span className="font-mono tabular-nums text-[#57534E] dark:text-stone-400">
                                                    {d.coveredHoursCount}/24h covered
                                                  </span>
                                                </div>

                                                {/* 24-hour coverage strip showing available vs missing hours */}
                                                <div className="flex items-center gap-0.5" title="24-hour recording coverage (00:00–23:00 UTC)">
                                                  {Array.from({ length: 24 }).map((_, hr) => {
                                                    const missing = d.missingHours.includes(hr);
                                                    return (
                                                      <span
                                                        key={hr}
                                                        title={`${String(hr).padStart(2, '0')}:00 — ${missing ? 'Missing' : 'Available'}`}
                                                        className={`inline-block h-3 w-1.5 rounded-[1px] ${
                                                          missing
                                                            ? 'bg-[#E5E2DC] dark:bg-stone-800'
                                                            : 'bg-[#15803D] dark:bg-emerald-500'
                                                        }`}
                                                      />
                                                    );
                                                  })}
                                                </div>
                                              </button>

                                              {dOpen && (
                                                <div className="border-t border-[#EFECE6] dark:border-stone-800 bg-white dark:bg-stone-900 divide-y divide-[#F2EFE9] dark:divide-stone-800">
                                                  {d.missingHours.length > 0 && (
                                                    <div className="px-4 py-2 text-[11px] text-[#A16207] dark:text-amber-400 bg-[#FBF6E8] dark:bg-amber-950/20">
                                                      Missing recording hours ({d.missingHours.length}):{' '}
                                                      <span className="font-mono">
                                                        {d.missingHours
                                                          .map((h) => `${String(h).padStart(2, '0')}:00`)
                                                          .join(', ')}
                                                      </span>
                                                    </div>
                                                  )}

                                                  {d.segments.map((seg) => (
                                                    <div
                                                      key={seg.id}
                                                      className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs hover:bg-[#F8F7F4] dark:hover:bg-stone-800/50"
                                                    >
                                                      <div className="flex flex-wrap items-center gap-3">
                                                        <span className="font-mono tabular-nums font-semibold text-[#141413] dark:text-stone-100">
                                                          {formatSecondsClock(seg.start_seconds)} –{' '}
                                                          {formatSecondsClock(seg.end_seconds)}
                                                        </span>
                                                        <span className="text-[#8A847C]">·</span>
                                                        <span className="font-mono tabular-nums text-[#57534E] dark:text-stone-400">
                                                          {formatBytes(seg.file_size_bytes)}
                                                        </span>
                                                        <span className="text-[#8A847C]">·</span>
                                                        <span className="text-[#78716C] dark:text-stone-400">
                                                          {seg.storage_provider}
                                                        </span>
                                                      </div>

                                                      <button
                                                        onClick={() => onPlaySegment(seg.id, 0)}
                                                        className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#141413] dark:bg-stone-100 px-3 py-1 text-[11px] font-medium text-white dark:text-stone-900 hover:bg-[#2A2927]"
                                                      >
                                                        <Play className="h-3 w-3 fill-current" />
                                                        Play
                                                      </button>
                                                    </div>
                                                  ))}
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
