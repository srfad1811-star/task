import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import type { ChannelEntry, ChannelSummary, EntryType } from '../types.ts';
import { formatDuration, getEntryTypeStyle, getQaStatusStyle } from '../lib/formatters.ts';
import { getAuthHeaders } from '../lib/apiAuth.ts';

interface AllEntriesViewProps {
  refreshKey: number;
  onSelectEntry: (entryId: string) => void;
  onEntriesUpdated: () => void;
}

interface TypeDiagnosticRow {
  source_role: string;
  entry_type: EntryType;
  raw_entry_type: string | null;
  commercial_type_name: string | null;
  category_name: string | null;
  count: number;
}

export function AllEntriesView({ refreshKey, onSelectEntry, onEntriesUpdated }: AllEntriesViewProps) {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [entries, setEntries] = useState<ChannelEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [channelKey, setChannelKey] = useState('ALL');
  const [entryType, setEntryType] = useState('ALL');
  const [qaStatus, setQaStatus] = useState('ALL');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [offset, setOffset] = useState(0);
  const limit = 100;

  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<TypeDiagnosticRow[]>([]);
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyNotice, setReclassifyNotice] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/channels', { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((data) => setChannels(Array.isArray(data) ? data : []));
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      channelKey,
      entryType,
      qaStatus,
      includeDeleted: String(includeDeleted),
    });
    if (search.trim()) params.set('search', search.trim());

    fetch(`/api/entries?${params.toString()}`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setEntries(data.entries ?? []);
        setTotal(data.total ?? 0);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, channelKey, entryType, qaStatus, includeDeleted, offset, refreshKey]);

  useEffect(() => {
    if (!showDiagnostics) return;
    fetch('/api/entries/type-diagnostics', { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((data) => setDiagnostics(Array.isArray(data) ? data : []));
  }, [showDiagnostics, refreshKey]);

  async function handleReclassify(rawValue?: string, targetType?: EntryType) {
    setReclassifying(true);
    setReclassifyNotice(null);
    try {
      const res = await fetch('/api/entries/reclassify', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(rawValue && targetType ? { rawValue, targetType } : {}),
      });
      const data = await res.json();
      setReclassifyNotice(
        `Checked ${data.totalChecked} entries and updated ${data.updated} classifications.`
      );
      onEntriesUpdated();
    } finally {
      setReclassifying(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded border border-[#E5E2DC] bg-white p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="h-3.5 w-3.5 text-[#8A847C] absolute left-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setOffset(0);
              setSearch(e.target.value);
            }}
            placeholder="Search by caption, brand, category, channel, or entry ID…"
            className="w-full rounded border border-[#D4CFC5] bg-white pl-9 pr-3 py-1.5 text-xs text-[#141413] focus:border-[#141413] focus:outline-none"
          />
        </div>

        <select
          value={channelKey}
          onChange={(e) => {
            setOffset(0);
            setChannelKey(e.target.value);
          }}
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
          onChange={(e) => {
            setOffset(0);
            setEntryType(e.target.value);
          }}
          className="rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs text-[#141413]"
        >
          <option value="ALL">All Categories</option>
          <option value="PROGRAM">PROGRAM</option>
          <option value="SPOT/TVC">SPOT/TVC</option>
          <option value="MEDIA">MEDIA</option>
          <option value="SPONSORSHIP">SPONSORSHIP</option>
        </select>

        <select
          value={qaStatus}
          onChange={(e) => {
            setOffset(0);
            setQaStatus(e.target.value);
          }}
          className="rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs text-[#141413]"
        >
          <option value="ALL">All QA Statuses</option>
          <option value="RED">RED · Error</option>
          <option value="YELLOW">YELLOW · Suspicious</option>
          <option value="GREEN">GREEN · Clean</option>
          <option value="PENDING">PENDING QA</option>
        </select>

        <label className="inline-flex items-center gap-1.5 text-xs text-[#57534E] cursor-pointer">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => {
              setOffset(0);
              setIncludeDeleted(e.target.checked);
            }}
            className="rounded border-[#D4CFC5]"
          />
          Include Deleted
        </label>

        <button
          onClick={() => setShowDiagnostics((s) => !s)}
          className="inline-flex items-center gap-1.5 rounded border border-[#D4CFC5] bg-[#FCFBF9] px-3 py-1.5 text-xs font-medium text-[#57534E] hover:bg-[#F4F2ED] whitespace-nowrap shrink-0"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Type Mapping Diagnostics
        </button>
      </div>

      {/* Entry Type Diagnostics & 1-Click Reclassification Panel */}
      {showDiagnostics && (
        <div className="rounded border border-[#D4CFC5] bg-white p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold text-[#141413]">
                XML Entry Type Diagnostics & Reclassification
              </h3>
              <p className="text-[11px] text-[#57534E]">
                Inspect raw XML EntryType / commercialTypeName / categoryName combinations and assign custom office codes (for example numeric codes or custom labels) to MEDIA, SPONSORSHIP, SPOT/TVC, or PROGRAM.
              </p>
            </div>
            <button
              onClick={() => handleReclassify()}
              disabled={reclassifying}
              className="inline-flex items-center gap-1.5 rounded bg-[#141413] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#2A2927] disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {reclassifying ? 'Reclassifying…' : 'Auto Re-detect Types'}
            </button>
          </div>

          {reclassifyNotice && (
            <div className="rounded border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-xs text-[#15803D]">
              {reclassifyNotice}
            </div>
          )}

          <div className="max-h-64 overflow-y-auto overflow-x-auto rounded border border-[#E5E2DC]">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#E5E2DC] bg-[#FCFBF9] text-[11px] font-semibold text-[#57534E]">
                <tr>
                  <th className="px-3 py-2">Source Role</th>
                  <th className="px-3 py-2">Raw EntryType</th>
                  <th className="px-3 py-2">CommercialTypeName</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Assigned Type</th>
                  <th className="px-3 py-2 text-right">Count</th>
                  <th className="px-3 py-2">Map Raw Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E2DC]">
                {diagnostics.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-4 text-center text-[#78716C]">
                      No imported entries to inspect.
                    </td>
                  </tr>
                ) : (
                  diagnostics.map((d, idx) => {
                    const candidateRaw = d.raw_entry_type || d.commercial_type_name || d.category_name;
                    return (
                      <tr key={idx} className="hover:bg-[#FCFBF9]">
                        <td className="px-3 py-2 font-mono text-[11px] text-[#57534E]">{d.source_role}</td>
                        <td className="px-3 py-2 font-mono text-[#141413]">{d.raw_entry_type ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-[#57534E]">{d.commercial_type_name ?? '—'}</td>
                        <td className="px-3 py-2 text-[#57534E]">{d.category_name ?? '—'}</td>
                        <td className="px-3 py-2 font-semibold">{d.entry_type}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{d.count}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {candidateRaw ? (
                            <select
                              value={d.entry_type}
                              disabled={reclassifying}
                              onChange={(e) => handleReclassify(candidateRaw, e.target.value as EntryType)}
                              className="rounded border border-[#D4CFC5] bg-white px-2 py-1 text-[11px]"
                            >
                              <option value="PROGRAM">Map to PROGRAM</option>
                              <option value="SPOT/TVC">Map to SPOT/TVC</option>
                              <option value="MEDIA">Map to MEDIA</option>
                              <option value="SPONSORSHIP">Map to SPONSORSHIP</option>
                            </select>
                          ) : (
                            <span className="text-[11px] text-[#8A847C]">No raw type label</span>
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
      )}

      <div className="rounded border border-[#E5E2DC] bg-white overflow-hidden">
        <div className="border-b border-[#E5E2DC] bg-[#FCFBF9] px-4 py-2.5 flex items-center justify-between text-xs text-[#57534E]">
          <span className="font-mono tabular-nums">
            Showing {entries.length === 0 ? 0 : offset + 1}–{offset + entries.length} of {total.toLocaleString()} entries
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={offset === 0}
              className="inline-flex items-center gap-1 rounded border border-[#D4CFC5] bg-white px-2.5 py-1 text-xs text-[#57534E] hover:bg-[#F4F2ED] disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </button>
            <button
              onClick={() => setOffset(offset + limit)}
              disabled={offset + limit >= total}
              className="inline-flex items-center gap-1 rounded border border-[#D4CFC5] bg-white px-2.5 py-1 text-xs text-[#57534E] hover:bg-[#F4F2ED] disabled:opacity-40"
            >
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#E5E2DC] bg-[#FCFBF9] text-[11px] font-semibold text-[#57534E]">
              <tr>
                <th className="px-3 py-2.5">Channel</th>
                <th className="px-3 py-2.5">Date</th>
                <th className="px-3 py-2.5">Start → End</th>
                <th className="px-3 py-2.5 text-right">Duration</th>
                <th className="px-3 py-2.5">Type</th>
                <th className="px-3 py-2.5">Caption / Brand</th>
                <th className="px-3 py-2.5">Category</th>
                <th className="px-3 py-2.5">IDs</th>
                <th className="px-3 py-2.5">QA Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E2DC]">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-[#78716C]">
                    Loading entries…
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-[#78716C]">
                    No entries found matching the current filters.
                  </td>
                </tr>
              ) : (
                entries.map((e) => {
                  const typeSt = getEntryTypeStyle(e.entry_type);
                  const qaSt = getQaStatusStyle(e.qa_status);
                  return (
                    <tr
                      key={e.id}
                      onClick={() => onSelectEntry(e.id)}
                      className="cursor-pointer hover:bg-[#FCFBF9]"
                    >
                      <td className="px-3 py-2.5 font-medium text-[#141413] whitespace-nowrap">
                        {e.channel_name}
                      </td>
                      <td className="px-3 py-2.5 font-mono tabular-nums text-[#57534E] whitespace-nowrap">
                        {e.trans_date ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 font-mono tabular-nums text-[#141413] whitespace-nowrap">
                        {e.start_time ?? '—'} → {e.end_time ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[#57534E] whitespace-nowrap">
                        {formatDuration(e.duration_seconds)}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span
                          className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold ${typeSt.bg} ${typeSt.text} ${typeSt.border}`}
                        >
                          {e.entry_type}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 max-w-[220px]">
                        <div className="font-medium text-[#141413] truncate">
                          {e.caption_name || e.brand_name || '—'}
                        </div>
                        {e.brand_name && e.caption_name && (
                          <div className="text-[11px] text-[#78716C] truncate">{e.brand_name}</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 max-w-[160px] truncate text-[#57534E]">
                        {e.category_name ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-[#78716C] whitespace-nowrap">
                        {e.master_entry_id ?? e.commercial_id ?? e.id.slice(0, 10)}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold ${qaSt.classes}`}>
                          {qaSt.label}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
