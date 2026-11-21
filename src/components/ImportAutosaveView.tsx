import { Fragment, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileCode2,
  Film,
  FolderOpen,
  Play,
  RefreshCw,
  Upload,
} from 'lucide-react';
import type { InspectedXmlFile } from '../types.ts';
import { formatBytes, formatSecondsClock } from '../lib/formatters.ts';
import { getAuthHeaders } from '../lib/apiAuth.ts';

interface ImportAutosaveViewProps {
  onImportCompleted: () => void;
  onNavigate: (tab: string) => void;
  onPlayArchiveSegment?: (archiveId: string, seekSeconds: number) => void;
}

interface InspectionResponse {
  folderName: string;
  files: InspectedXmlFile[];
  totalRecords: number;
  schemaFiles: number;
  dataFiles: number;
  errorFiles: number;
  duplicateFiles: number;
}

interface VideoMatchRow {
  entry_id: string;
  channel_key: string;
  channel_name: string;
  trans_date: string | null;
  entry_type: string;
  caption_name: string | null;
  brand_name: string | null;
  start_time: string | null;
  end_time: string | null;
  start_seconds: number | null;
  duration_seconds: number | null;
  qa_status: string;
  match_status: 'MATCHED' | 'VIDEO_NOT_AVAILABLE';
  archive_id: string | null;
  offset_seconds: number | null;
  matched_at: string | null;
}

export function ImportAutosaveView({
  onImportCompleted,
  onNavigate,
  onPlayArchiveSegment,
}: ImportAutosaveViewProps) {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [inspecting, setInspecting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [inspection, setInspection] = useState<InspectionResponse | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [forceDuplicates, setForceDuplicates] = useState(false);
  const [runQaAfter, setRunQaAfter] = useState(true);
  const [notes, setNotes] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<{
    batchId: string;
    folderName: string;
    recordsInserted: number;
    recordsUpdated: number;
    recordsSkippedDuplicate: number;
    errorCount: number;
    qaSummary?: { totalAnalyzed: number; redCount: number; yellowCount: number; greenCount: number } | null;
    videoMatchSummary?: { totalEntries: number; matched: number; unavailable: number } | null;
  } | null>(null);

  // Autosave <-> Cloud Video Archive Matching State
  const [channels, setChannels] = useState<Array<{ id: string; channel_name: string }>>([]);
  const [matchChannel, setMatchChannel] = useState('ALL');
  const [matchDate, setMatchDate] = useState('');
  const [matchRows, setMatchRows] = useState<VideoMatchRow[]>([]);
  const [matchingBusy, setMatchingBusy] = useState(false);
  const [loadingMatches, setLoadingMatches] = useState(false);

  useEffect(() => {
    fetch('/api/channels', { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((list) => {
        if (Array.isArray(list)) setChannels(list);
      })
      .catch(() => {});
  }, []);

  async function fetchMatches(opts?: { batchId?: string; channelKey?: string; recordDate?: string }) {
    setLoadingMatches(true);
    try {
      const qs = new URLSearchParams();
      if (opts?.batchId) qs.set('batchId', opts.batchId);
      else {
        const ch = opts?.channelKey ?? matchChannel;
        const dt = opts?.recordDate ?? matchDate;
        if (ch && ch !== 'ALL') qs.set('channelKey', ch);
        if (dt) qs.set('recordDate', dt);
      }
      const res = await fetch(`/api/autosave/matches?${qs.toString()}`, {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (Array.isArray(data)) setMatchRows(data);
    } finally {
      setLoadingMatches(false);
    }
  }

  useEffect(() => {
    fetchMatches();
  }, [matchChannel, matchDate]);

  async function handleRematchArchive() {
    setMatchingBusy(true);
    try {
      await fetch('/api/autosave/match-video', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          channelKey: matchChannel !== 'ALL' ? matchChannel : undefined,
          recordDate: matchDate || undefined,
          batchId: commitResult?.batchId,
        }),
      });
      await fetchMatches(commitResult?.batchId ? { batchId: commitResult.batchId } : undefined);
    } finally {
      setMatchingBusy(false);
    }
  }

  function buildFormData(files: File[]) {
    const fd = new FormData();
    const relPaths: string[] = [];
    for (const f of files) {
      fd.append('files', f, f.name);
      const webkitRel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
      relPaths.push(webkitRel && webkitRel.length > 0 ? webkitRel : f.name);
    }
    fd.append('relativePaths', JSON.stringify(relPaths));
    return fd;
  }

  async function handleFilesChosen(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setSelectedFiles(files);
    setCommitResult(null);
    setErrorMsg(null);
    setInspecting(true);

    try {
      const fd = buildFormData(files);
      const res = await fetch('/api/import/inspect', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'XML inspection failed');
      setInspection(data);
      if (data.files?.length > 0) {
        setExpandedFile(data.files[0].relativePath);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to inspect selected files.');
      setInspection(null);
    } finally {
      setInspecting(false);
    }
  }

  async function handleCommitImport() {
    if (selectedFiles.length === 0 || !inspection) return;
    setCommitting(true);
    setErrorMsg(null);

    try {
      const fd = buildFormData(selectedFiles);
      fd.append('folderName', inspection.folderName);
      fd.append('forceReprocessDuplicates', String(forceDuplicates));
      fd.append('runQaAfter', String(runQaAfter));
      if (notes.trim()) fd.append('notes', notes.trim());

      const res = await fetch('/api/import/commit', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import commit failed');

      setCommitResult(data);
      onImportCompleted();
      if (data.batchId) {
        fetchMatches({ batchId: data.batchId });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setCommitting(false);
    }
  }

  const roleBadgeLabel: Record<string, string> = {
    metadata: 'Autosave Metadata',
    tcommercial: 'Commercial Catalog (ds_tcommercial)',
    trcommercial: 'Commercial Log (ds_trcommercial)',
    trschedule: 'Schedule Log (ds_trschedule)',
    trschedule_deleted: 'Deleted Schedule (ds_trschedule_deleted)',
    selectedchannels: 'Selected Channels (ds_selectedchannels)',
    reviewed_captions: 'Reviewed Captions',
    schema_only: 'XML Schema Definition (No Data Rows)',
    unknown: 'Generic XML Data Table',
    invalid: 'Non-XML / Parse Error',
  };

  const matchedCount = matchRows.filter((r) => r.match_status === 'MATCHED' && r.archive_id).length;
  const unavailableCount = matchRows.length - matchedCount;

  return (
    <div className="space-y-6">
      {/* Step 1: Folder / Files Selection */}
      <div className="rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-semibold text-[#141413] dark:text-[#F4F2ED]">
              Import Office Autosave Folder or XML Files
            </h2>
            <p className="mt-1 text-xs text-[#57534E] dark:text-[#A8A29E] max-w-2xl leading-relaxed">
              Select your office software autosave folder. The parser inspects XML contents regardless of extension (e.g.{' '}
              <span className="font-mono">ds_trschedule</span>,{' '}
              <span className="font-mono">ds_tcommercial.xml</span>,{' '}
              <span className="font-mono">ds_trcommercial.xml</span>,{' '}
              <span className="font-mono">ds_selectedchannels</span>), extracts channel, date, program, ad, and promo timestamps, and automatically matches them against verified cloud video recordings.
            </p>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <input
              ref={folderInputRef}
              type="file"
              // @ts-expect-error webkitdirectory is supported in Chromium/Firefox/Edge/Safari
              webkitdirectory=""
              directory=""
              multiple
              className="hidden"
              onChange={(e) => handleFilesChosen(e.target.files)}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleFilesChosen(e.target.files)}
            />

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={inspecting || committing}
              className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-3.5 py-2 text-xs font-medium text-[#57534E] dark:text-[#D6D3D1] hover:bg-[#F4F2ED] dark:hover:bg-[#242422] whitespace-nowrap shrink-0"
            >
              <Upload className="h-3.5 w-3.5" />
              Select XML Files
            </button>

            <button
              onClick={() => folderInputRef.current?.click()}
              disabled={inspecting || committing}
              className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#C83A1B] px-4 py-2 text-xs font-medium text-white hover:bg-[#A82E13] whitespace-nowrap shrink-0"
            >
              <FolderOpen className="h-4 w-4" />
              Select Autosave Folder
            </button>
          </div>
        </div>

        {inspecting && (
          <div className="mt-4 rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-[#FCFBF9] dark:bg-[#141413] px-4 py-3 text-xs text-[#57534E] dark:text-[#A8A29E]">
            Inspecting {selectedFiles.length} file(s), separating XML schemas from records, and mapping fields…
          </div>
        )}

        {errorMsg && (
          <div className="mt-4 flex items-center gap-2 rounded-[3px] border border-[#FECACA] dark:border-[#7F1D1D] bg-[#FEF2F2] dark:bg-[#2A1515] px-4 py-3 text-xs text-[#B91C1C] dark:text-[#FCA5A5]">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {commitResult && (
          <div className="mt-4 rounded-[3px] border border-[#BBF7D0] dark:border-[#14532D] bg-[#F0FDF4] dark:bg-[#112318] p-4 text-xs text-[#14532D] dark:text-[#86EFAC] space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-sm">
                <CheckCircle2 className="h-4 w-4 text-[#15803D]" />
                Import Committed — {commitResult.folderName}
              </div>
              <span className="font-mono text-[11px]">Batch: {commitResult.batchId}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono tabular-nums">
              <span>Inserted: {commitResult.recordsInserted}</span>
              <span>·</span>
              <span>Updated: {commitResult.recordsUpdated}</span>
              <span>·</span>
              <span>Skipped Duplicates: {commitResult.recordsSkippedDuplicate}</span>
              <span>·</span>
              <span>Errors: {commitResult.errorCount}</span>
            </div>
            {commitResult.videoMatchSummary && (
              <div className="pt-1 border-t border-[#BBF7D0] dark:border-[#14532D] font-mono tabular-nums">
                Cloud Video Archive Match: <strong>{commitResult.videoMatchSummary.matched}</strong> matched to verified video segments ·{' '}
                <span>{commitResult.videoMatchSummary.unavailable} Video Not Available</span>
              </div>
            )}
            {commitResult.qaSummary && (
              <div className="pt-1 border-t border-[#BBF7D0] dark:border-[#14532D] flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono tabular-nums">
                  Automatic QA Scan: {commitResult.qaSummary.totalAnalyzed} analyzed ·{' '}
                  <strong className="text-[#B91C1C]">{commitResult.qaSummary.redCount} RED</strong> ·{' '}
                  <strong className="text-[#B45309]">{commitResult.qaSummary.yellowCount} YELLOW</strong> ·{' '}
                  <strong className="text-[#15803D]">{commitResult.qaSummary.greenCount} GREEN</strong>
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onNavigate('channels')}
                    className="rounded-[3px] border border-[#15803D] bg-white dark:bg-[#141413] px-3 py-1 text-xs font-medium text-[#15803D] hover:bg-[#DCFCE7] dark:hover:bg-[#16311F]"
                  >
                    Open Channel Viewer
                  </button>
                  <button
                    onClick={() => onNavigate('qa-results')}
                    className="rounded-[3px] bg-[#141413] px-3 py-1 text-xs font-medium text-white hover:bg-[#2A2927]"
                  >
                    Inspect QA Results
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Step 2: Pre-Import XML Structure & Schema Inspector */}
      {inspection && (
        <div className="rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] overflow-hidden">
          <div className="border-b border-[#E5E2DC] dark:border-[#2C2C2A] bg-[#FCFBF9] dark:bg-[#161614] px-6 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-[#78716C] dark:text-[#A8A29E]">
                Pre-Import XML Inspection Report
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#57534E] dark:text-[#A8A29E] font-mono tabular-nums">
                <span className="font-semibold text-[#141413] dark:text-[#F4F2ED]">{inspection.folderName}</span>
                <span>·</span>
                <span>{inspection.files.length} files</span>
                <span>·</span>
                <span>{inspection.dataFiles} data files</span>
                <span>·</span>
                <span>{inspection.schemaFiles} schema-only</span>
                <span>·</span>
                <span>{inspection.totalRecords.toLocaleString()} records detected</span>
                {inspection.duplicateFiles > 0 && (
                  <>
                    <span>·</span>
                    <span className="text-amber-700">{inspection.duplicateFiles} already archived</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-1.5 text-xs text-[#57534E] dark:text-[#A8A29E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={forceDuplicates}
                  onChange={(e) => setForceDuplicates(e.target.checked)}
                  className="rounded border-[#D4CFC5]"
                />
                Re-check already imported files
              </label>

              <label className="inline-flex items-center gap-1.5 text-xs text-[#57534E] dark:text-[#A8A29E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={runQaAfter}
                  onChange={(e) => setRunQaAfter(e.target.checked)}
                  className="rounded border-[#D4CFC5]"
                />
                Run Automatic QA after import
              </label>

              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional batch note…"
                className="rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-2.5 py-1.5 text-xs text-[#141413] dark:text-[#F4F2ED] w-44"
              />

              <button
                onClick={handleCommitImport}
                disabled={committing || inspection.files.length === 0}
                className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#141413] dark:bg-[#C83A1B] px-4 py-2 text-xs font-medium text-white hover:bg-[#2A2927] dark:hover:bg-[#A82E13] disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Play className="h-3.5 w-3.5" />
                {committing ? 'Importing & Matching…' : 'Commit Autosave Import'}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#E5E2DC] dark:border-[#2C2C2A] bg-[#FCFBF9] dark:bg-[#161614] text-[11px] font-semibold text-[#57534E] dark:text-[#A8A29E]">
                <tr>
                  <th className="px-4 py-2.5">File Name</th>
                  <th className="px-4 py-2.5">Detected Role</th>
                  <th className="px-4 py-2.5">Root / Record Tag</th>
                  <th className="px-4 py-2.5 text-right">Records</th>
                  <th className="px-4 py-2.5 text-right">Mapped / Unmapped Fields</th>
                  <th className="px-4 py-2.5 text-right">Size</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E2DC] dark:divide-[#262624]">
                {inspection.files.map((f) => {
                  const isExpanded = expandedFile === f.relativePath;
                  return (
                    <Fragment key={f.relativePath}>
                      <tr
                        onClick={() => setExpandedFile(isExpanded ? null : f.relativePath)}
                        className="cursor-pointer hover:bg-[#FCFBF9] dark:hover:bg-[#222220]"
                      >
                        <td className="px-4 py-2.5 font-mono font-medium text-[#141413] dark:text-[#F4F2ED]">
                          <div className="flex items-center gap-1.5">
                            <FileCode2 className="h-3.5 w-3.5 text-[#8A847C] shrink-0" />
                            <span>{f.relativePath}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-[#57534E] dark:text-[#A8A29E]">
                          {roleBadgeLabel[f.detectedRole] ?? f.detectedRole}
                          {f.hasInlineSchema && f.detectedRole !== 'schema_only' && (
                            <span className="ml-1.5 text-[11px] text-[#78716C]">(+inline schema stripped)</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[#57534E] dark:text-[#A8A29E]">
                          {f.rootElement ? `<${f.rootElement}>` : '—'}
                          {f.recordElement ? ` / <${f.recordElement}>` : ''}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums font-medium text-[#141413] dark:text-[#F4F2ED]">
                          {f.recordCount.toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                          <span className="text-[#15803D]">{f.mappedFields.length}</span>
                          <span className="text-[#8A847C]"> / </span>
                          <span className={f.unmappedFields.length > 0 ? 'text-[#B45309] font-semibold' : 'text-[#78716C]'}>
                            {f.unmappedFields.length}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#78716C]">
                          {formatBytes(f.fileSize)}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          {f.parseErrors.length > 0 ? (
                            <span className="text-[#B91C1C] font-medium">
                              {f.isXml ? 'XML Error' : 'Skipped (Non-XML)'}
                            </span>
                          ) : f.alreadyImported ? (
                            <span className="text-[#B45309] font-medium">Duplicate Hash</span>
                          ) : (
                            <span className="text-[#15803D] font-medium">Ready</span>
                          )}
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="bg-[#FCFBF9] dark:bg-[#161614]">
                          <td colSpan={7} className="px-6 py-4 space-y-3 border-t border-[#E5E2DC] dark:border-[#2C2C2A]">
                            {f.parseErrors.length > 0 && (
                              <div className="rounded border border-[#FECACA] bg-[#FEF2F2] p-3 text-xs text-[#B91C1C]">
                                {f.parseErrors.map((e, idx) => (
                                  <div key={idx}>{e}</div>
                                ))}
                              </div>
                            )}

                            {f.schemaFields.length > 0 && (
                              <div>
                                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#78716C] mb-1.5">
                                  Detected XML Schema Columns ({f.schemaFields.length})
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {f.schemaFields.map((sf) => (
                                    <span
                                      key={sf.name}
                                      className="rounded border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-2 py-0.5 text-[11px] font-mono text-[#57534E] dark:text-[#A8A29E]"
                                    >
                                      {sf.name}: <span className="text-[#8A847C]">{sf.type}</span>
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                              <div>
                                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#78716C] mb-1.5">
                                  Mapped Canonical Fields ({f.mappedFields.length})
                                </div>
                                {f.mappedFields.length === 0 ? (
                                  <div className="text-xs text-[#78716C]">No data records in this file.</div>
                                ) : (
                                  <div className="max-h-48 overflow-y-auto rounded border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#141413] divide-y divide-[#E5E2DC] dark:divide-[#262624]">
                                    {f.mappedFields.map((mf) => (
                                      <div key={mf.xmlTag} className="px-3 py-1.5 flex items-center justify-between gap-2 text-xs">
                                        <span className="font-mono text-[#141413] dark:text-[#F4F2ED]">
                                          {mf.xmlTag} → <strong>{mf.canonicalField}</strong>
                                        </span>
                                        <span className="font-mono text-[#78716C] truncate max-w-[200px]">
                                          {mf.sampleValue || '—'}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>

                              <div>
                                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#78716C] mb-1.5">
                                  Unmapped / Undocumented XML Fields ({f.unmappedFields.length})
                                </div>
                                {f.unmappedFields.length === 0 ? (
                                  <div className="text-xs text-[#78716C]">
                                    All discovered XML tags mapped cleanly.
                                  </div>
                                ) : (
                                  <div className="max-h-48 overflow-y-auto rounded border border-[#FDE68A] bg-[#FFFBEB] dark:bg-[#261E10] divide-y divide-[#FDE68A]/50">
                                    {f.unmappedFields.map((uf) => (
                                      <div key={uf.xmlTag} className="px-3 py-1.5 flex items-center justify-between gap-2 text-xs">
                                        <span className="font-mono font-medium text-[#92400E] dark:text-[#FCD34D]">{uf.xmlTag}</span>
                                        <span className="font-mono text-[#57534E] dark:text-[#A8A29E] truncate max-w-[200px]">
                                          {uf.sampleValue || '—'}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Step 3: Autosave Records <-> Cloud Video Archive Timestamp Matching */}
      <section className="rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] overflow-hidden">
        <div className="border-b border-[#E5E2DC] dark:border-[#2C2C2A] bg-[#FCFBF9] dark:bg-[#161614] px-5 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Film className="h-4 w-4 text-[#C83A1B]" />
              <h3 className="font-display text-sm font-semibold text-[#141413] dark:text-[#F4F2ED]">
                Autosave Timestamp Matching to Cloud Video Archive
              </h3>
            </div>
            <p className="mt-0.5 text-xs text-[#57534E] dark:text-[#A8A29E]">
              Matches imported program, advertisement, and promo timestamps against verified cloud recordings. Entries without a verified recording honestly display <strong className="text-[#141413] dark:text-[#F4F2ED]">Video Not Available</strong>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={matchChannel}
              onChange={(e) => setMatchChannel(e.target.value)}
              className="rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-2.5 py-1.5 text-xs text-[#141413] dark:text-[#F4F2ED]"
            >
              <option value="ALL">All Channels</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.channel_name}
                </option>
              ))}
            </select>

            <input
              type="date"
              value={matchDate}
              onChange={(e) => setMatchDate(e.target.value)}
              className="rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-2.5 py-1.5 font-mono text-xs text-[#141413] dark:text-[#F4F2ED]"
            />

            <button
              onClick={handleRematchArchive}
              disabled={matchingBusy}
              className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-3 py-1.5 text-xs font-medium text-[#141413] dark:text-[#F4F2ED] hover:bg-[#F4F2ED] dark:hover:bg-[#242422] disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${matchingBusy ? 'animate-spin' : ''}`} />
              Re-Match Video Archive
            </button>
          </div>
        </div>

        <div className="px-5 py-2.5 border-b border-[#EFECE6] dark:border-[#262624] flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums text-[#57534E] dark:text-[#A8A29E]">
          <span>Showing {matchRows.length} entries</span>
          <span>·</span>
          <span className="text-[#15803D] font-semibold">{matchedCount} Matched to Cloud Video</span>
          <span>·</span>
          <span>{unavailableCount} Video Not Available</span>
        </div>

        <div className="max-h-[420px] overflow-y-auto overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 border-b border-[#E5E2DC] dark:border-[#2C2C2A] bg-[#FCFBF9] dark:bg-[#161614] text-[11px] font-medium text-[#78716C] dark:text-[#A8A29E]">
              <tr>
                <th className="px-4 py-2.5">Channel / Date</th>
                <th className="px-4 py-2.5">Category</th>
                <th className="px-4 py-2.5">PROGRAM / SPOT/TVC / MEDIA / SPONSORSHIP</th>
                <th className="px-4 py-2.5 text-right">Timecode</th>
                <th className="px-4 py-2.5 text-right">Cloud Video</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EFECE6] dark:divide-[#262624]">
              {!loadingMatches &&
                matchRows.map((row) => {
                  const hasVideo = row.match_status === 'MATCHED' && Boolean(row.archive_id);
                  return (
                    <tr
                      key={row.entry_id}
                      className="hover:bg-[#F8F7F4] dark:hover:bg-[#222220] transition-colors"
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <div className="font-medium text-[#141413] dark:text-[#F4F2ED]">
                          {row.channel_name}
                        </div>
                        <div className="font-mono text-[11px] text-[#78716C] dark:text-[#A8A29E]">
                          {row.trans_date || '—'}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-[#57534E] dark:text-[#A8A29E] whitespace-nowrap">
                        {row.entry_type}
                      </td>
                      <td className="px-4 py-2.5 max-w-md">
                        <div className="font-medium text-[#141413] dark:text-[#F4F2ED] truncate">
                          {row.caption_name || row.brand_name || 'Untitled Entry'}
                        </div>
                        {row.brand_name && row.caption_name && (
                          <div className="text-[11px] text-[#78716C] dark:text-[#A8A29E] truncate">
                            {row.brand_name}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#57534E] dark:text-[#A8A29E] whitespace-nowrap">
                        {row.start_time ||
                          (row.start_seconds !== null ? formatSecondsClock(row.start_seconds) : '—')}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        {hasVideo && row.archive_id ? (
                          <button
                            onClick={() =>
                              onPlayArchiveSegment?.(row.archive_id!, row.offset_seconds ?? 0)
                            }
                            className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#C83A1B] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#A82E13] transition-colors"
                          >
                            <Play className="h-3 w-3 fill-current" />
                            Jump to {formatSecondsClock(row.offset_seconds ?? 0)}
                          </button>
                        ) : (
                          <span className="font-mono text-[11px] text-[#78716C] dark:text-[#A8A29E]">
                            Video Not Available
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              {!loadingMatches && matchRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-xs text-[#78716C] dark:text-[#A8A29E]">
                    No imported autosave entries match the current filter. Import an autosave XML folder above to match records against cloud video recordings.
                  </td>
                </tr>
              )}
              {loadingMatches && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-xs text-[#78716C]">
                    Loading autosave timestamp matches…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
