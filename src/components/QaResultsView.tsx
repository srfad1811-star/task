import { useEffect, useState } from 'react';
import { Code2, ExternalLink, Search, X } from 'lucide-react';
import type { ChannelSummary, IssueResolutionStatus, QaIssue } from '../types.ts';
import { formatDuration, getEntryTypeStyle, getQaStatusStyle } from '../lib/formatters.ts';
import { getAuthHeaders } from '../lib/apiAuth.ts';

interface QaResultsViewProps {
  refreshKey: number;
  onOpenEntryInChannelViewer: (channelKey: string, transDate: string | null, entryId: string) => void;
  onResolutionUpdated: () => void;
}

export function QaResultsView({
  refreshKey,
  onOpenEntryInChannelViewer,
  onResolutionUpdated,
}: QaResultsViewProps) {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [issues, setIssues] = useState<QaIssue[]>([]);
  const [loading, setLoading] = useState(true);

  const [severity, setSeverity] = useState<'ALL' | 'RED' | 'YELLOW' | 'GREEN'>('ALL');
  const [channelKey, setChannelKey] = useState('ALL');
  const [entryType, setEntryType] = useState('ALL');
  const [resolutionStatus, setResolutionStatus] = useState('ALL');
  const [search, setSearch] = useState('');
  const [xmlModalIssue, setXmlModalIssue] = useState<QaIssue | null>(null);

  useEffect(() => {
    fetch('/api/channels', { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((data) => setChannels(Array.isArray(data) ? data : []));
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({
      severity,
      channelKey,
      entryType,
      resolutionStatus,
    });
    if (search.trim()) params.set('search', search.trim());

    fetch(`/api/qa/issues?${params.toString()}`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setIssues(data.issues ?? []);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [severity, channelKey, entryType, resolutionStatus, search, refreshKey]);

  async function handleResolutionChange(issueId: string, nextStatus: IssueResolutionStatus) {
    await fetch(`/api/qa/issues/${encodeURIComponent(issueId)}`, {
      method: 'PATCH',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ resolution_status: nextStatus }),
    });
    setIssues((prev) =>
      prev.map((i) => (i.id === issueId ? { ...i, resolution_status: nextStatus } : i))
    );
    onResolutionUpdated();
  }

  return (
    <div className="space-y-4">
      {/* Severity Segmented Bar + Filters */}
      <div className="rounded border border-[#E5E2DC] bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1 rounded bg-[#F4F2ED] p-1">
            {[
              { id: 'ALL', label: 'All Issues (RED + YELLOW)' },
              { id: 'RED', label: 'RED · Confirmed Errors' },
              { id: 'YELLOW', label: 'YELLOW · Suspicious Review' },
              { id: 'GREEN', label: 'GREEN · Clean Entries' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setSeverity(tab.id as typeof severity)}
                className={`px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 transition-colors ${
                  severity === tab.id
                    ? 'bg-[#141413] text-white'
                    : 'text-[#57534E] hover:text-[#141413]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <span className="text-xs font-mono tabular-nums text-[#57534E]">
            {issues.length} record(s) displayed
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="h-3.5 w-3.5 text-[#8A847C] absolute left-3 top-2.5" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search channel, brand, caption, error type, reason…"
              className="w-full rounded border border-[#D4CFC5] bg-white pl-9 pr-3 py-1.5 text-xs text-[#141413] focus:border-[#141413] focus:outline-none"
            />
          </div>

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

          <select
            value={entryType}
            onChange={(e) => setEntryType(e.target.value)}
            className="rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs text-[#141413]"
          >
            <option value="ALL">All Categories</option>
            <option value="PROGRAM">PROGRAM</option>
            <option value="SPOT/TVC">SPOT/TVC</option>
            <option value="MEDIA">MEDIA</option>
            <option value="SPONSORSHIP">SPONSORSHIP</option>
          </select>

          {severity !== 'GREEN' && (
            <select
              value={resolutionStatus}
              onChange={(e) => setResolutionStatus(e.target.value)}
              className="rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs text-[#141413]"
            >
              <option value="ALL">All Statuses</option>
              <option value="OPEN">OPEN</option>
              <option value="REVIEWED">REVIEWED</option>
              <option value="RESOLVED">RESOLVED</option>
              <option value="IGNORED">IGNORED</option>
            </select>
          )}
        </div>
      </div>

      {/* QA Issues Table */}
      <div className="rounded border border-[#E5E2DC] bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#E5E2DC] bg-[#FCFBF9] text-[11px] font-semibold text-[#57534E]">
              <tr>
                <th className="px-3 py-2.5">Level</th>
                <th className="px-3 py-2.5">Channel Name</th>
                <th className="px-3 py-2.5">Date</th>
                <th className="px-3 py-2.5">Entry ID</th>
                <th className="px-3 py-2.5">Entry Type</th>
                <th className="px-3 py-2.5">Category / Brand</th>
                <th className="px-3 py-2.5">Start → End (Dur)</th>
                <th className="px-3 py-2.5">Error Type & Reason</th>
                <th className="px-3 py-2.5">Confidence / Evidence</th>
                <th className="px-3 py-2.5">XML / Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E2DC]">
              {loading ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-[#78716C]">
                    Loading QA results…
                  </td>
                </tr>
              ) : issues.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-[#78716C]">
                    No QA results match the selected criteria.
                  </td>
                </tr>
              ) : (
                issues.map((iss) => {
                  const sevStyle = getQaStatusStyle(iss.severity);
                  const typeStyle = getEntryTypeStyle(iss.entry_type);
                  return (
                    <tr key={iss.id} className="hover:bg-[#FCFBF9] align-top">
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold ${sevStyle.classes}`}>
                          {sevStyle.label}
                        </span>
                      </td>
                      <td className="px-3 py-3 font-medium text-[#141413] whitespace-nowrap">
                        {iss.channel_name}
                      </td>
                      <td className="px-3 py-3 font-mono tabular-nums text-[#57534E] whitespace-nowrap">
                        {iss.trans_date ?? '—'}
                      </td>
                      <td className="px-3 py-3 font-mono text-[11px] text-[#57534E] whitespace-nowrap">
                        {iss.master_entry_id ?? iss.entry_id.slice(0, 12)}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span
                          className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold ${typeStyle.bg} ${typeStyle.text} ${typeStyle.border}`}
                        >
                          {iss.entry_type}
                        </span>
                      </td>
                      <td className="px-3 py-3 max-w-[160px]">
                        <div className="text-[#141413] truncate">{iss.category_name ?? '—'}</div>
                        <div className="text-[11px] text-[#78716C] truncate">
                          {iss.brand_name || iss.caption_name || '—'}
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono tabular-nums text-[11px] text-[#57534E] whitespace-nowrap">
                        <div>{iss.start_time ?? '—'} → {iss.end_time ?? '—'}</div>
                        <div className="text-[#78716C]">{formatDuration(iss.duration_seconds)}</div>
                      </td>
                      <td className="px-3 py-3 max-w-[320px]">
                        <div className="font-semibold text-[#141413]">{iss.error_type}</div>
                        <p className="mt-0.5 text-[#57534E] leading-snug">{iss.reason}</p>
                      </td>
                      <td className="px-3 py-3 text-[11px] text-[#57534E] max-w-[160px]">
                        <div>{iss.confidence_level}</div>
                        {iss.severity !== 'GREEN' && (
                          <select
                            value={iss.resolution_status}
                            onChange={(e) =>
                              handleResolutionChange(iss.id, e.target.value as IssueResolutionStatus)
                            }
                            className="mt-1.5 rounded border border-[#D4CFC5] bg-white px-2 py-1 text-[11px] text-[#141413]"
                          >
                            <option value="OPEN">OPEN</option>
                            <option value="REVIEWED">REVIEWED</option>
                            <option value="RESOLVED">RESOLVED</option>
                            <option value="IGNORED">IGNORED</option>
                          </select>
                        )}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap space-y-1.5">
                        <button
                          onClick={() =>
                            onOpenEntryInChannelViewer(iss.channel_key, iss.trans_date, iss.entry_id)
                          }
                          className="flex items-center gap-1 rounded bg-[#141413] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#2A2927]"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Channel Viewer
                        </button>
                        {iss.raw_xml && (
                          <button
                            onClick={() => setXmlModalIssue(iss)}
                            className="flex items-center gap-1 rounded border border-[#D4CFC5] bg-white px-2.5 py-1 text-[11px] font-medium text-[#57534E] hover:bg-[#F4F2ED]"
                          >
                            <Code2 className="h-3 w-3" />
                            View XML
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Original XML Modal */}
      {xmlModalIssue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#141413]/50 p-4">
          <div className="w-full max-w-2xl rounded border border-[#D4CFC5] bg-white shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#E5E2DC] bg-[#141413] px-5 py-3 text-white">
              <div className="text-sm font-semibold">
                Original XML Record — {xmlModalIssue.channel_name} ({xmlModalIssue.error_type})
              </div>
              <button
                onClick={() => setXmlModalIssue(null)}
                className="rounded p-1 hover:bg-[#2A2927]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-5">
              <pre className="max-h-96 overflow-auto rounded border border-[#D4CFC5] bg-[#141413] p-4 text-xs font-mono text-slate-100">
                {xmlModalIssue.raw_xml}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
