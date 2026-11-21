import { useEffect, useState } from 'react';
import { ArrowRight, Play } from 'lucide-react';
import type { DashboardMetrics, ImportBatch, QaIssue, QaRun } from '../types.ts';
import { formatBytes, formatDateTime, formatDuration, getQaStatusStyle } from '../lib/formatters.ts';
import { getAuthHeaders } from '../lib/apiAuth.ts';

interface DashboardViewProps {
  refreshKey: number;
  onNavigate: (tab: string) => void;
  onOpenEntryInChannelViewer: (channelKey: string, transDate: string | null, entryId: string) => void;
  onRunQaNow: () => Promise<void>;
  qaRunning: boolean;
}

export function DashboardView({
  refreshKey,
  onNavigate,
  onOpenEntryInChannelViewer,
  onRunQaNow,
  qaRunning,
}: DashboardViewProps) {
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [recentImports, setRecentImports] = useState<ImportBatch[]>([]);
  const [latestQaRun, setLatestQaRun] = useState<QaRun | null>(null);
  const [recentIssues, setRecentIssues] = useState<QaIssue[]>([]);
  const [recentActivity, setRecentActivity] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/dashboard', { headers: getAuthHeaders() })
      .then(async (r) => {
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || `Failed to load dashboard (${r.status})`);
        }
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setMetrics(data.metrics ?? null);
        setRecentImports(data.recentImports ?? []);
        setLatestQaRun(data.latestQaRun ?? null);
        setRecentIssues(data.recentIssues ?? []);
        setRecentActivity(data.recentActivity ?? []);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Dashboard load error:', err);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (loading && !metrics) {
    return (
      <div className="space-y-6">
        <div className="h-28 rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] animate-pulse" />
        <div className="h-24 rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] animate-pulse" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-64 rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] animate-pulse" />
          <div className="h-64 rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] animate-pulse" />
        </div>
      </div>
    );
  }

  const m: DashboardMetrics = metrics ?? {
    totalChannels: 0,
    importedChannels: 0,
    storageUsageBytes: 0,
    totalEntries: 0,
    programs: 0,
    spotTvcs: 0,
    media: 0,
    sponsorships: 0,
    programDurationSec: 0,
    spotTvcDurationSec: 0,
    mediaDurationSec: 0,
    sponsorshipDurationSec: 0,
    suspiciousEntries: 0,
    redErrorEntries: 0,
    greenEntries: 0,
    missingSequenceWarnings: 0,
    duplicateEntries: 0,
    durationErrors: 0,
    pendingQa: 0,
    deletedRecordsCount: 0,
    reviewedCaptionsCount: 0,
  };

  const totalClassified = Math.max(
    1,
    m.programs + m.spotTvcs + m.media + m.sponsorships
  );

  const compositionSegments = [
    { label: 'PROGRAM', count: m.programs, durationSec: m.programDurationSec, color: '#1E293B' },
    { label: 'SPOT/TVC', count: m.spotTvcs, durationSec: m.spotTvcDurationSec, color: '#DC2626' },
    { label: 'MEDIA', count: m.media, durationSec: m.mediaDurationSec, color: '#F43F5E' },
    { label: 'SPONSORSHIP', count: m.sponsorships, durationSec: m.sponsorshipDurationSec, color: '#D97706' },
  ];

  return (
    <div className="space-y-7">
      {/* Studio Overview Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] text-[#141413] dark:text-[#F4F2ED]">
            Broadcast Operations Ledger
          </h2>
          <p className="mt-1 text-[13px] text-[#57534E] dark:text-[#A8A29E]">
            Live summary across synchronized cloud channels, imported autosave logs, and rule-based QA diagnostics.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs text-[#57534E] dark:text-[#A8A29E]">
          <button
            onClick={() => onNavigate('channels')}
            className="font-medium text-[#141413] dark:text-[#F4F2ED] hover:text-[#C83A1B] transition-colors inline-flex items-center gap-1"
          >
            Open Channel Master <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <span className="text-[#D4CFC5] dark:text-[#343432]" aria-hidden="true">/</span>
          <button
            onClick={() => onNavigate('import')}
            className="font-medium text-[#141413] dark:text-[#F4F2ED] hover:text-[#C83A1B] transition-colors"
          >
            Import XML Folder
          </button>
        </div>
      </div>

      {/* Primary Studio Ledger Strip — Single Elevation, Vertical Hairlines */}
      <section className="rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A]">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-[#E5E2DC] dark:divide-[#2C2C2A]">
          <div className="p-5">
            <div className="text-xs text-[#78716C] dark:text-[#A8A29E]">Channels Registered</div>
            <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-[#141413] dark:text-[#F4F2ED]">
              {m.totalChannels.toLocaleString()}
            </div>
            <div className="mt-1.5 text-xs text-[#78716C] dark:text-[#A8A29E]">
              <span className="font-mono tabular-nums text-[#141413] dark:text-[#F4F2ED] font-medium">
                {m.importedChannels.toLocaleString()}
              </span>{' '}
              with autosave logs
            </div>
          </div>

          <div className="p-5">
            <div className="text-xs text-[#78716C] dark:text-[#A8A29E]">Timeline Records</div>
            <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-[#141413] dark:text-[#F4F2ED]">
              {m.totalEntries.toLocaleString()}
            </div>
            <div className="mt-1.5 text-xs text-[#78716C] dark:text-[#A8A29E]">
              <span className="font-mono tabular-nums text-[#15803D] dark:text-emerald-400 font-medium">
                {m.greenEntries.toLocaleString()}
              </span>{' '}
              verified ·{' '}
              <span className="font-mono tabular-nums">{m.pendingQa.toLocaleString()}</span> pending
            </div>
          </div>

          <div className="p-5">
            <div className="text-xs text-[#78716C] dark:text-[#A8A29E]">QA Exceptions</div>
            <div className="mt-2 flex items-baseline gap-3">
              <span
                className={`font-mono text-3xl font-semibold tabular-nums ${
                  m.redErrorEntries > 0 ? 'text-[#B91C1C] dark:text-red-400' : 'text-[#141413] dark:text-[#F4F2ED]'
                }`}
              >
                {m.redErrorEntries.toLocaleString()}
              </span>
              <span className="text-xs text-[#78716C] dark:text-[#A8A29E]">
                errors ·{' '}
                <span
                  className={`font-mono tabular-nums font-medium ${
                    m.suspiciousEntries > 0 ? 'text-[#A16207] dark:text-amber-400' : 'text-[#57534E]'
                  }`}
                >
                  {m.suspiciousEntries.toLocaleString()}
                </span>{' '}
                review
              </span>
            </div>
            <div className="mt-1.5 text-xs text-[#78716C] dark:text-[#A8A29E]">
              {m.missingSequenceWarnings} gaps · {m.duplicateEntries} duplicates · {m.durationErrors} duration
            </div>
          </div>

          <div className="p-5">
            <div className="text-xs text-[#78716C] dark:text-[#A8A29E]">Local Archive & Captions</div>
            <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-[#141413] dark:text-[#F4F2ED]">
              {formatBytes(m.storageUsageBytes)}
            </div>
            <div className="mt-1.5 text-xs text-[#78716C] dark:text-[#A8A29E]">
              <span className="font-mono tabular-nums text-[#141413] dark:text-[#F4F2ED] font-medium">
                {m.reviewedCaptionsCount.toLocaleString()}
              </span>{' '}
              reviewed captions · {recentImports.length} recent imports
            </div>
          </div>
        </div>

        {/* Integrated Broadcast Classification Distribution */}
        <div className="border-t border-[#E5E2DC] dark:border-[#2C2C2A] px-5 py-4 bg-[#FCFBF9] dark:bg-[#161614] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-medium text-[#141413] dark:text-[#F4F2ED]">Broadcast Schedule Composition</span>
            <span className="text-[#78716C] dark:text-[#A8A29E] font-mono tabular-nums">
              {m.deletedRecordsCount.toLocaleString()} deleted in schedule
            </span>
          </div>

          {/* Crisp 6px proportional rule */}
          <div className="h-1.5 w-full overflow-hidden rounded-[2px] bg-[#EAE7E0] dark:bg-[#2A2A27] flex">
            {m.totalEntries > 0 &&
              compositionSegments.map((seg) =>
                seg.count > 0 ? (
                  <div
                    key={seg.label}
                    style={{
                      width: `${(seg.count / totalClassified) * 100}%`,
                      backgroundColor: seg.color,
                    }}
                    title={`${seg.label}: ${seg.count.toLocaleString()}`}
                  />
                ) : null
              )}
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs text-[#57534E] dark:text-[#A8A29E]">
            {compositionSegments.map((seg) => (
              <div key={seg.label} className="inline-flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-[1px]"
                  style={{ backgroundColor: seg.color }}
                  aria-hidden="true"
                />
                <span className="font-mono font-medium">{seg.label}</span>
                <span className="font-mono tabular-nums font-semibold text-[#141413] dark:text-[#F4F2ED]">
                  {seg.count.toLocaleString()}
                </span>
                <span className="font-mono tabular-nums text-[11px] text-[#78716C] dark:text-[#A8A29E]">
                  ({formatDuration(seg.durationSec)})
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Latest QA Run Control Strip */}
      <section className="rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] px-5 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-xs font-semibold text-[#141413] dark:text-[#F4F2ED]">Automatic Quality Inspection</div>
          {latestQaRun ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#57534E] dark:text-[#A8A29E]">
              <span>
                Last run{' '}
                <span className="font-mono tabular-nums text-[#141413] dark:text-[#F4F2ED]">
                  {formatDateTime(latestQaRun.completed_at)}
                </span>
              </span>
              <span className="text-[#D4CFC5]" aria-hidden="true">·</span>
              <span>
                <span className="font-mono tabular-nums font-medium text-[#141413] dark:text-[#F4F2ED]">
                  {latestQaRun.total_analyzed.toLocaleString()}
                </span>{' '}
                analyzed
              </span>
              <span className="text-[#D4CFC5]" aria-hidden="true">·</span>
              <span className="font-mono tabular-nums font-medium text-[#B91C1C] dark:text-red-400">
                {latestQaRun.red_count} errors
              </span>
              <span className="text-[#D4CFC5]" aria-hidden="true">·</span>
              <span className="font-mono tabular-nums font-medium text-[#A16207] dark:text-amber-400">
                {latestQaRun.yellow_count} review
              </span>
              <span className="text-[#D4CFC5]" aria-hidden="true">·</span>
              <span className="font-mono tabular-nums font-medium text-[#15803D] dark:text-emerald-400">
                {latestQaRun.green_count} clean
              </span>
            </div>
          ) : (
            <p className="text-xs text-[#78716C] dark:text-[#A8A29E]">
              No automatic QA run completed yet. Import an autosave XML folder to analyze timelines.
            </p>
          )}
        </div>

        <button
          onClick={onRunQaNow}
          disabled={qaRunning}
          className="inline-flex items-center gap-2 rounded-[4px] bg-[#DC2626] hover:bg-[#B91C1C] px-4 py-2 text-xs font-medium text-white shadow-xs disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
        >
          <Play className="h-3 w-3 fill-current" />
          {qaRunning ? 'Running Scan…' : 'Run Full QA Scan'}
        </button>
      </section>

      {/* Operational Data Tables: QA Findings & Audit Ledger */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Latest QA Findings */}
        <section className="rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#E5E2DC] dark:border-[#2C2C2A] px-5 py-3.5">
            <h3 className="font-display text-sm font-semibold text-[#141413] dark:text-[#F4F2ED]">
              Latest QA Findings
            </h3>
            <button
              onClick={() => onNavigate('qa-results')}
              className="inline-flex items-center gap-1 text-xs font-medium text-[#C83A1B] hover:underline underline-offset-2"
            >
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {recentIssues.length === 0 ? (
            <div className="px-5 py-10 text-center text-xs text-[#78716C] dark:text-[#A8A29E]">
              {m.totalEntries === 0
                ? 'Import channel autosave data to inspect QA findings.'
                : 'No QA errors or review items currently open.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-[#E5E2DC] dark:border-[#2C2C2A] bg-[#FCFBF9] dark:bg-[#161614] text-[11px] font-medium text-[#78716C] dark:text-[#A8A29E]">
                  <tr>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Channel</th>
                    <th className="px-4 py-2.5">Finding</th>
                    <th className="px-4 py-2.5 text-right">Timecode</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EFECE6] dark:divide-[#262624]">
                  {recentIssues.map((iss) => {
                    const st = getQaStatusStyle(iss.severity);
                    return (
                      <tr
                        key={iss.id}
                        onClick={() => onOpenEntryInChannelViewer(iss.channel_key, iss.trans_date, iss.entry_id)}
                        className="cursor-pointer hover:bg-[#F8F7F4] dark:hover:bg-[#222220] transition-colors"
                      >
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <span className={st.classes}>{st.label}</span>
                        </td>
                        <td className="px-4 py-2.5 font-medium text-[#141413] dark:text-[#F4F2ED] whitespace-nowrap">
                          {iss.channel_name}
                        </td>
                        <td className="px-4 py-2.5 text-[#57534E] dark:text-[#A8A29E] truncate max-w-[200px]">
                          {iss.error_type}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#57534E] dark:text-[#A8A29E] whitespace-nowrap">
                          {iss.start_time ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Recent Operations Activity */}
        <section className="rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#E5E2DC] dark:border-[#2C2C2A] px-5 py-3.5">
            <h3 className="font-display text-sm font-semibold text-[#141413] dark:text-[#F4F2ED]">
              Recent Activity
            </h3>
            <span className="text-xs text-[#8A847C] font-mono tabular-nums">
              {recentActivity.length} entries
            </span>
          </div>
          {recentActivity.length === 0 ? (
            <div className="px-5 py-10 text-center text-xs text-[#78716C] dark:text-[#A8A29E]">
              No recent operations recorded yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-[#E5E2DC] dark:border-[#2C2C2A] bg-[#FCFBF9] dark:bg-[#161614] text-[11px] font-medium text-[#78716C] dark:text-[#A8A29E]">
                  <tr>
                    <th className="px-4 py-2.5">Event</th>
                    <th className="px-4 py-2.5">Details</th>
                    <th className="px-4 py-2.5 text-right">Recorded</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EFECE6] dark:divide-[#262624]">
                  {recentActivity.map((log) => (
                    <tr key={log.id} className="hover:bg-[#F8F7F4] dark:hover:bg-[#222220] transition-colors">
                      <td className="px-4 py-2.5 font-medium text-[#141413] dark:text-[#F4F2ED] whitespace-nowrap">
                        {String(log.action || '')
                          .toLowerCase()
                          .replace(/_/g, ' ')
                          .replace(/^\w/, (c) => c.toUpperCase())}
                      </td>
                      <td className="px-4 py-2.5 text-[#57534E] dark:text-[#A8A29E] truncate max-w-[220px]" title={log.notes}>
                        {log.notes || log.entity_type || '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[11px] text-[#78716C] dark:text-[#A8A29E] whitespace-nowrap">
                        {formatDateTime(log.timestamp)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
