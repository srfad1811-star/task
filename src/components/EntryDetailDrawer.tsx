import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Code2, Edit3, History, RotateCcw, Save, X, XCircle } from 'lucide-react';
import type { AuditLogItem, ChannelEntry, EntryType, QaIssue } from '../types.ts';
import { formatDateTime, formatDuration, getEntryTypeStyle, getQaStatusStyle } from '../lib/formatters.ts';
import { getAuthHeaders } from '../lib/apiAuth.ts';

interface EntryDetailDrawerProps {
  entryId: string | null;
  onClose: () => void;
  onEntryUpdated: () => void;
}

export function EntryDetailDrawer({ entryId, onClose, onEntryUpdated }: EntryDetailDrawerProps) {
  const [loading, setLoading] = useState(false);
  const [entry, setEntry] = useState<ChannelEntry | null>(null);
  const [issues, setIssues] = useState<QaIssue[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [activeTab, setActiveTab] = useState<'details' | 'edit' | 'xml' | 'audit'>('details');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Edit form state
  const [editType, setEditType] = useState<EntryType>('PROGRAM');
  const [editCategory, setEditCategory] = useState('');
  const [editSubcategory, setEditSubcategory] = useState('');
  const [editBrand, setEditBrand] = useState('');
  const [editCaption, setEditCaption] = useState('');
  const [editStartTime, setEditStartTime] = useState('');
  const [editEndTime, setEditEndTime] = useState('');
  const [editDuration, setEditDuration] = useState('');
  const [editNotes, setEditNotes] = useState('');

  useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    setLoading(true);
    setMessage(null);
    setActiveTab('details');

    fetch(`/api/entries/${encodeURIComponent(entryId)}`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const e = data.entry as ChannelEntry;
        setEntry(e);
        setIssues(data.issues ?? []);
        setAuditLogs(data.auditLogs ?? []);
        setEditType(e.entry_type);
        setEditCategory(e.category_name ?? '');
        setEditSubcategory(e.subcategory_name ?? '');
        setEditBrand(e.brand_name ?? '');
        setEditCaption(e.caption_name ?? '');
        setEditStartTime(e.start_time ?? '');
        setEditEndTime(e.end_time ?? '');
        setEditDuration(e.duration_seconds !== null ? String(e.duration_seconds) : '');
        setEditNotes('');
      })
      .catch(() => {
        if (!cancelled) setMessage({ type: 'err', text: 'Failed to load entry details.' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [entryId]);

  if (!entryId) return null;

  async function handleSaveEdit() {
    if (!entry) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/entries/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          entry_type: editType,
          category_name: editCategory || null,
          subcategory_name: editSubcategory || null,
          brand_name: editBrand || null,
          caption_name: editCaption || null,
          start_time: editStartTime || null,
          end_time: editEndTime || null,
          duration_seconds: editDuration === '' ? null : editDuration,
          edit_notes: editNotes || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');
      setEntry(data.entry);
      if (Array.isArray(data.issues)) setIssues(data.issues);
      setAuditLogs(data.auditLogs ?? []);
      setMessage({ type: 'ok', text: 'Category & entry updated everywhere (monitoring records, QA, dashboard, reports, and exports).' });
      onEntryUpdated();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  }

  async function handleRestoreOriginal() {
    if (!entry) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/entries/${encodeURIComponent(entry.id)}/reset`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Restore failed');
      const e = data.entry as ChannelEntry;
      setEntry(e);
      if (Array.isArray(data.issues)) setIssues(data.issues);
      setEditType(e.entry_type);
      setEditCategory(e.category_name ?? '');
      setEditSubcategory(e.subcategory_name ?? '');
      setEditBrand(e.brand_name ?? '');
      setEditCaption(e.caption_name ?? '');
      setEditStartTime(e.start_time ?? '');
      setEditEndTime(e.end_time ?? '');
      setEditDuration(e.duration_seconds !== null ? String(e.duration_seconds) : '');
      setMessage({ type: 'ok', text: 'Restored original imported XML values.' });
      onEntryUpdated();
      // refresh audit logs
      const detailRes = await fetch(`/api/entries/${encodeURIComponent(entry.id)}`, {
        headers: getAuthHeaders(),
      }).then((r) => r.json());
      setAuditLogs(detailRes.auditLogs ?? []);
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Restore failed' });
    } finally {
      setSaving(false);
    }
  }

  const originalValues = entry
    ? (JSON.parse(entry.original_values_json) as {
        entryType: string;
        categoryName: string | null;
        subcategoryName: string | null;
        brandName: string | null;
        captionName: string | null;
        startTime: string | null;
        endTime: string | null;
        durationSeconds: number | null;
      })
    : null;

  const extraFields = entry?.extra_fields_json
    ? (JSON.parse(entry.extra_fields_json) as Record<string, string>)
    : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[#141413]/50">
      <div className="flex h-full w-full max-w-3xl flex-col bg-white border-l border-[#D4CFC5] shadow-2xl">
        {/* Drawer Header */}
        <div className="flex items-center justify-between border-b border-[#E5E2DC] bg-[#141413] px-6 py-4 text-white">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <span className="font-mono">{entry?.channel_name ?? 'Channel'}</span>
              <span>·</span>
              <span className="font-mono tabular-nums">{entry?.trans_date ?? 'No Date'}</span>
              {entry?.is_manually_edited === 1 && (
                <>
                  <span>·</span>
                  <span className="text-amber-300 font-medium">Manually Edited</span>
                </>
              )}
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-white">
              {entry?.caption_name || entry?.brand_name || entry?.master_entry_id || 'Entry Inspector'}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close entry details"
            className="rounded border border-slate-600 p-1.5 text-slate-200 hover:bg-[#2A2927] hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 border-b border-[#E5E2DC] bg-[#FCFBF9] px-6 py-2">
          <button
            onClick={() => setActiveTab('details')}
            className={`px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 transition-colors ${
              activeTab === 'details'
                ? 'bg-[#141413] text-white'
                : 'text-[#57534E] hover:bg-slate-200/70 hover:text-[#141413]'
            }`}
          >
            Overview & QA ({issues.length})
          </button>
          <button
            onClick={() => setActiveTab('edit')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 transition-colors ${
              activeTab === 'edit'
                ? 'bg-[#141413] text-white'
                : 'text-[#57534E] hover:bg-slate-200/70 hover:text-[#141413]'
            }`}
          >
            <Edit3 className="h-3.5 w-3.5" />
            Edit Entry
          </button>
          <button
            onClick={() => setActiveTab('xml')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 transition-colors ${
              activeTab === 'xml'
                ? 'bg-[#141413] text-white'
                : 'text-[#57534E] hover:bg-slate-200/70 hover:text-[#141413]'
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
            Original XML
          </button>
          <button
            onClick={() => setActiveTab('audit')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 transition-colors ${
              activeTab === 'audit'
                ? 'bg-[#141413] text-white'
                : 'text-[#57534E] hover:bg-slate-200/70 hover:text-[#141413]'
            }`}
          >
            <History className="h-3.5 w-3.5" />
            Audit History ({auditLogs.length})
          </button>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {message && (
            <div
              className={`rounded border px-4 py-2.5 text-xs font-medium ${
                message.type === 'ok'
                  ? 'border-[#BBF7D0] bg-[#F0FDF4] text-[#15803D]'
                  : 'border-[#FECACA] bg-[#FEF2F2] text-[#B91C1C]'
              }`}
            >
              {message.text}
            </div>
          )}

          {loading || !entry ? (
            <div className="py-12 text-center text-sm text-[#78716C]">Loading entry record…</div>
          ) : activeTab === 'details' ? (
            <>
              {/* Status Strip */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E5E2DC] pb-4">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center px-2.5 py-1 text-xs font-semibold rounded border ${
                      getEntryTypeStyle(entry.entry_type).bg
                    } ${getEntryTypeStyle(entry.entry_type).text} ${getEntryTypeStyle(entry.entry_type).border}`}
                  >
                    {entry.entry_type}
                  </span>
                  <span
                    className={`inline-flex items-center px-2.5 py-1 text-xs font-semibold rounded ${
                      getQaStatusStyle(entry.qa_status).classes
                    }`}
                  >
                    {getQaStatusStyle(entry.qa_status).label}
                  </span>
                  {entry.is_deleted_record === 1 && (
                    <span className="inline-flex items-center px-2.5 py-1 text-xs font-semibold rounded border border-red-200 bg-red-50 text-red-700">
                      Deleted Schedule Record
                    </span>
                  )}
                </div>
                <div className="text-xs text-[#78716C] font-mono">ID: {entry.id}</div>
              </div>

              {/* QA Issues for this entry */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#78716C] mb-2">
                  QA Analysis Findings ({issues.length})
                </h3>
                {issues.length === 0 ? (
                  <div className="flex items-center gap-2 rounded border border-[#E5E2DC] bg-[#FCFBF9] px-4 py-3 text-xs text-[#57534E]">
                    <CheckCircle2 className="h-4 w-4 text-[#15803D] shrink-0" />
                    {entry.qa_status === 'PENDING'
                      ? 'This entry has not been scanned by Automatic QA yet.'
                      : 'No structural, duration, category, or timeline issues detected.'}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {issues.map((iss) => (
                      <div
                        key={iss.id}
                        className={`rounded border p-3 text-xs ${
                          iss.severity === 'RED'
                            ? 'border-[#FECACA] bg-[#FEF2F2]'
                            : 'border-[#FDE68A] bg-[#FFFBEB]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 font-semibold">
                            {iss.severity === 'RED' ? (
                              <XCircle className="h-4 w-4 text-[#DC2626]" />
                            ) : (
                              <AlertTriangle className="h-4 w-4 text-[#D97706]" />
                            )}
                            <span className={iss.severity === 'RED' ? 'text-[#991B1B]' : 'text-[#92400E]'}>
                              {iss.error_type}
                            </span>
                          </div>
                          <span className="font-mono text-[11px] text-[#57534E]">{iss.rule_code}</span>
                        </div>
                        <p className="mt-1.5 text-[#141413] leading-relaxed">{iss.reason}</p>
                        <div className="mt-1.5 flex items-center gap-3 text-[11px] text-[#57534E]">
                          <span>Evidence: {iss.confidence_level}</span>
                          <span>·</span>
                          <span>Status: {iss.resolution_status}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Core Broadcast Metadata Grid */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#78716C] mb-2">
                  Timing & Classification
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-[#E5E2DC] border border-[#E5E2DC] rounded overflow-hidden">
                  {[
                    ['Broadcast Date', entry.trans_date ?? entry.raw_trans_date ?? '—'],
                    ['Start Time', entry.start_time ?? '—'],
                    ['End Time', entry.end_time ?? '—'],
                    ['Duration', formatDuration(entry.duration_seconds)],
                    ['Source Duration', formatDuration(entry.source_duration)],
                    ['Custom Duration', formatDuration(entry.custom_duration)],
                    ['Category', entry.category_name ?? '—'],
                    ['Subcategory', entry.subcategory_name ?? '—'],
                    ['Brand Name', entry.brand_name ?? '—'],
                    ['Caption Name', entry.caption_name ?? '—'],
                    ['Company', entry.company_name ?? '—'],
                    ['Commercial Type', entry.commercial_type_name ?? '—'],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-white p-3">
                      <div className="text-[11px] text-[#78716C]">{k}</div>
                      <div className="mt-0.5 text-xs font-medium text-[#141413] font-mono tabular-nums break-words">
                        {v}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Technical Identifiers & Frames */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#78716C] mb-2">
                  Identifiers, Frames & Matching Telemetry
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-[#E5E2DC] border border-[#E5E2DC] rounded overflow-hidden">
                  {[
                    ['MasterEntryID', entry.master_entry_id ?? '—'],
                    ['SegmentDetailID', entry.segment_detail_id ?? '—'],
                    ['CommercialID', entry.commercial_id ?? '—'],
                    ['CaptionID', entry.caption_id ?? '—'],
                    ['ChannelID', entry.channel_id ?? '—'],
                    ['VideoClipID', entry.video_clip_id ?? '—'],
                    ['Start / End Index', `${entry.start_index ?? '—'} → ${entry.end_index ?? '—'}`],
                    ['DiffInIndex', entry.diff_in_index !== null ? String(entry.diff_in_index) : '—'],
                    ['Start / End Frame', `${entry.start_frame ?? '—'} → ${entry.end_frame ?? '—'}`],
                    ['Match Value', entry.match_value !== null ? String(entry.match_value) : '—'],
                    ['Match Coverage', entry.match_coverage !== null ? `${entry.match_coverage}%` : '—'],
                    ['QualityID / Action', `${entry.quality_id ?? '—'} / ${entry.action ?? '—'}`],
                    ['Video File', entry.video_file_name ?? '—'],
                    ['Source Role', entry.source_role],
                    ['TTS Window', `${entry.start_time_tts ?? '—'} → ${entry.end_time_tts ?? '—'}`],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-white p-3">
                      <div className="text-[11px] text-[#78716C]">{k}</div>
                      <div className="mt-0.5 text-xs font-medium text-[#141413] font-mono tabular-nums break-all">
                        {v}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Extra / Unmapped XML fields */}
              {extraFields && Object.keys(extraFields).length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[#78716C] mb-2">
                    Additional Unmapped XML Fields
                  </h3>
                  <div className="grid grid-cols-2 gap-px bg-[#E5E2DC] border border-[#E5E2DC] rounded overflow-hidden">
                    {Object.entries(extraFields).map(([k, v]) => (
                      <div key={k} className="bg-white p-2.5">
                        <div className="text-[11px] font-mono text-[#78716C]">{k}</div>
                        <div className="text-xs font-mono text-[#141413] break-all">{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Original Immutable Snapshot Comparison */}
              {entry.is_manually_edited === 1 && originalValues && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-700 mb-2">
                    Original Imported Values (Preserved Separately)
                  </h3>
                  <div className="rounded border border-[#FDE68A] bg-[#FFFBEB] p-3 text-xs space-y-1 font-mono">
                    <div>Type: {originalValues.entryType} · Category: {originalValues.categoryName ?? '—'} / {originalValues.subcategoryName ?? '—'}</div>
                    <div>Brand: {originalValues.brandName ?? '—'} · Caption: {originalValues.captionName ?? '—'}</div>
                    <div>Time: {originalValues.startTime ?? '—'} → {originalValues.endTime ?? '—'} ({originalValues.durationSeconds ?? '—'}s)</div>
                  </div>
                </div>
              )}
            </>
          ) : activeTab === 'edit' ? (
            <div className="space-y-4">
              <div className="rounded border border-[#E5E2DC] bg-[#FCFBF9] p-3 text-xs text-[#57534E]">
                Manual corrections are stored in SQLite without altering original office autosave XML files. Original imported values remain preserved and every change is logged in Audit History.
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[#57534E] mb-1">Content Category</label>
                  <select
                    value={editType}
                    onChange={(e) => setEditType(e.target.value as EntryType)}
                    className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-2 text-xs text-[#141413] focus:border-[#141413] focus:outline-none"
                  >
                    <option value="MEDIA">MEDIA (Promo / Teaser / Trailer)</option>
                    <option value="SPONSORSHIP">SPONSORSHIP (SPN / Sponsor)</option>
                    <option value="SPOT/TVC">SPOT/TVC (Commercial Ad)</option>
                    <option value="PROGRAM">PROGRAM (Shows / News / Songs)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#57534E] mb-1">Duration (seconds)</label>
                  <input
                    type="text"
                    value={editDuration}
                    onChange={(e) => setEditDuration(e.target.value)}
                    placeholder="e.g. 30"
                    className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-2 text-xs font-mono text-[#141413] focus:border-[#141413] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#57534E] mb-1">Category</label>
                  <input
                    type="text"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-2 text-xs text-[#141413] focus:border-[#141413] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#57534E] mb-1">Subcategory</label>
                  <input
                    type="text"
                    value={editSubcategory}
                    onChange={(e) => setEditSubcategory(e.target.value)}
                    className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-2 text-xs text-[#141413] focus:border-[#141413] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#57534E] mb-1">Brand</label>
                  <input
                    type="text"
                    value={editBrand}
                    onChange={(e) => setEditBrand(e.target.value)}
                    className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-2 text-xs text-[#141413] focus:border-[#141413] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#57534E] mb-1">Caption</label>
                  <input
                    type="text"
                    value={editCaption}
                    onChange={(e) => setEditCaption(e.target.value)}
                    className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-2 text-xs text-[#141413] focus:border-[#141413] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#57534E] mb-1">Start Time (HH:mm:ss)</label>
                  <input
                    type="text"
                    value={editStartTime}
                    onChange={(e) => setEditStartTime(e.target.value)}
                    placeholder="HH:mm:ss"
                    className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-2 text-xs font-mono text-[#141413] focus:border-[#141413] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#57534E] mb-1">End Time (HH:mm:ss)</label>
                  <input
                    type="text"
                    value={editEndTime}
                    onChange={(e) => setEditEndTime(e.target.value)}
                    placeholder="HH:mm:ss"
                    className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-2 text-xs font-mono text-[#141413] focus:border-[#141413] focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[#57534E] mb-1">Audit Reason / Notes</label>
                <input
                  type="text"
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  placeholder="Optional reason for manual QA correction"
                  className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-2 text-xs text-[#141413] focus:border-[#141413] focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-[#E5E2DC]">
                {entry.is_manually_edited === 1 ? (
                  <button
                    onClick={handleRestoreOriginal}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded border border-[#D4CFC5] bg-white px-3.5 py-2 text-xs font-medium text-[#57534E] hover:bg-[#F4F2ED]"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restore Original XML Values
                  </button>
                ) : (
                  <span className="text-xs text-[#78716C]">Currently matches original XML import.</span>
                )}

                <button
                  onClick={handleSaveEdit}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded bg-[#141413] px-4 py-2 text-xs font-medium text-white hover:bg-[#2A2927] disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? 'Saving…' : 'Save Correction'}
                </button>
              </div>
            </div>
          ) : activeTab === 'xml' ? (
            <div>
              <div className="mb-2 flex items-center justify-between text-xs text-[#78716C]">
                <span>Preserved Original Record XML</span>
                <span className="font-mono">Role: {entry.source_role}</span>
              </div>
              <pre className="overflow-x-auto rounded border border-[#D4CFC5] bg-[#141413] p-4 text-xs font-mono text-slate-100 leading-relaxed">
                {entry.raw_xml}
              </pre>
            </div>
          ) : (
            <div className="space-y-2">
              {auditLogs.length === 0 ? (
                <div className="rounded border border-[#E5E2DC] bg-[#FCFBF9] p-6 text-center text-xs text-[#78716C]">
                  No manual modifications recorded for this entry.
                </div>
              ) : (
                auditLogs.map((log) => (
                  <div key={log.id} className="rounded border border-[#E5E2DC] bg-white p-3 text-xs">
                    <div className="flex items-center justify-between text-[#78716C]">
                      <span className="font-semibold text-[#141413]">{log.action}</span>
                      <span className="font-mono tabular-nums">{formatDateTime(log.timestamp)}</span>
                    </div>
                    {log.field_name && (
                      <div className="mt-1 font-mono text-[#57534E]">
                        <span className="font-semibold">{log.field_name}:</span>{' '}
                        <span className="text-red-700 line-through">{log.old_value ?? 'null'}</span>{' '}
                        <span>→</span>{' '}
                        <span className="text-emerald-700">{log.new_value ?? 'null'}</span>
                      </div>
                    )}
                    {log.notes && <div className="mt-1 text-[#57534E]">Note: {log.notes}</div>}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
