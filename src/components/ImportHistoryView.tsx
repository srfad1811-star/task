import { useEffect, useState } from 'react';
import { Eye, FileCode2, X } from 'lucide-react';
import type { ImportBatch, XmlArchiveFile } from '../types.ts';
import { formatBytes, formatDateTime } from '../lib/formatters.ts';
import { getAuthHeaders } from '../lib/apiAuth.ts';

interface ImportHistoryViewProps {
  refreshKey: number;
}

export function ImportHistoryView({ refreshKey }: ImportHistoryViewProps) {
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [files, setFiles] = useState<XmlArchiveFile[]>([]);
  const [rawModal, setRawModal] = useState<{ name: string; content: string } | null>(null);

  useEffect(() => {
    fetch('/api/import/batches', { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((data: ImportBatch[]) => {
        setBatches(data ?? []);
        if (data?.length > 0 && !selectedBatchId) {
          setSelectedBatchId(data[0].id);
        }
      });
  }, [refreshKey]);

  useEffect(() => {
    if (!selectedBatchId) {
      setFiles([]);
      return;
    }
    fetch(`/api/import/batches/${encodeURIComponent(selectedBatchId)}/files`, {
      headers: getAuthHeaders(),
    })
      .then((r) => r.json())
      .then((data) => setFiles(Array.isArray(data) ? data : []));
  }, [selectedBatchId, refreshKey]);

  async function handleViewRawXml(file: XmlArchiveFile) {
    const res = await fetch(`/api/import/files/${encodeURIComponent(file.id)}/raw`, {
      headers: getAuthHeaders(),
    });
    const text = await res.text();
    setRawModal({ name: file.file_name, content: text });
  }

  return (
    <div className="space-y-6">
      <div className="rounded border border-[#E5E2DC] bg-white overflow-hidden">
        <div className="border-b border-[#E5E2DC] px-5 py-3.5">
          <h2 className="text-sm font-semibold text-[#141413]">Autosave Import Batches</h2>
        </div>
        {batches.length === 0 ? (
          <div className="p-8 text-center text-xs text-[#78716C]">
            No autosave folders have been imported yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#E5E2DC] bg-[#FCFBF9] text-[11px] font-semibold text-[#57534E]">
                <tr>
                  <th className="px-4 py-2.5">Batch ID</th>
                  <th className="px-4 py-2.5">Folder Name</th>
                  <th className="px-4 py-2.5">Imported At</th>
                  <th className="px-4 py-2.5 text-right">Files (Schema/Data)</th>
                  <th className="px-4 py-2.5 text-right">Inserted</th>
                  <th className="px-4 py-2.5 text-right">Updated</th>
                  <th className="px-4 py-2.5 text-right">Skipped Dup</th>
                  <th className="px-4 py-2.5 text-right">Errors</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E2DC]">
                {batches.map((b) => {
                  const active = b.id === selectedBatchId;
                  return (
                    <tr
                      key={b.id}
                      onClick={() => setSelectedBatchId(b.id)}
                      className={`cursor-pointer ${active ? 'bg-[#EFF6FF]' : 'hover:bg-[#FCFBF9]'}`}
                    >
                      <td className="px-4 py-2.5 font-mono text-[11px] text-[#57534E]">{b.id}</td>
                      <td className="px-4 py-2.5 font-medium text-[#141413]">{b.folder_name}</td>
                      <td className="px-4 py-2.5 font-mono tabular-nums text-[#57534E]">
                        {formatDateTime(b.imported_at)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                        {b.file_count} ({b.schema_file_count}/{b.data_file_count})
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-[#15803D]">
                        {b.records_inserted}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#57534E]">
                        {b.records_updated}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#78716C]">
                        {b.records_skipped_duplicate}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#B91C1C]">
                        {b.error_count}
                      </td>
                      <td className="px-4 py-2.5 uppercase font-mono text-[11px]">{b.status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedBatchId && (
        <div className="rounded border border-[#E5E2DC] bg-white overflow-hidden">
          <div className="border-b border-[#E5E2DC] bg-[#FCFBF9] px-5 py-3.5">
            <h3 className="text-sm font-semibold text-[#141413]">
              Archived Original XML Files — Batch <span className="font-mono">{selectedBatchId}</span>
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#E5E2DC] bg-[#FCFBF9] text-[11px] font-semibold text-[#57534E]">
                <tr>
                  <th className="px-4 py-2.5">Relative Path</th>
                  <th className="px-4 py-2.5">Role</th>
                  <th className="px-4 py-2.5">Root / Record Tag</th>
                  <th className="px-4 py-2.5 text-right">Records</th>
                  <th className="px-4 py-2.5 text-right">Size</th>
                  <th className="px-4 py-2.5">Unmapped / Errors</th>
                  <th className="px-4 py-2.5">Archive</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E2DC]">
                {files.map((f) => {
                  const unmapped = f.unmapped_fields_json
                    ? (JSON.parse(f.unmapped_fields_json) as Array<{ xmlTag: string }>)
                    : [];
                  const errs = f.parse_errors_json ? (JSON.parse(f.parse_errors_json) as string[]) : [];
                  return (
                    <tr key={f.id} className="hover:bg-[#FCFBF9]">
                      <td className="px-4 py-2.5 font-mono font-medium text-[#141413]">
                        <div className="flex items-center gap-1.5">
                          <FileCode2 className="h-3.5 w-3.5 text-[#8A847C]" />
                          <span>{f.relative_path}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[#57534E]">{f.detected_role}</td>
                      <td className="px-4 py-2.5 font-mono text-[#57534E]">
                        {f.root_element ?? '—'} / {f.record_element ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                        {f.record_count}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#78716C]">
                        {formatBytes(f.file_size)}
                      </td>
                      <td className="px-4 py-2.5 text-[11px]">
                        {errs.length > 0 ? (
                          <span className="text-[#B91C1C]">{errs[0]}</span>
                        ) : unmapped.length > 0 ? (
                          <span className="text-[#B45309] font-mono">
                            Unmapped: {unmapped.map((u) => u.xmlTag).join(', ')}
                          </span>
                        ) : (
                          <span className="text-[#78716C]">Clean</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          onClick={() => handleViewRawXml(f)}
                          className="inline-flex items-center gap-1 rounded border border-[#D4CFC5] bg-white px-2.5 py-1 text-[11px] font-medium text-[#57534E] hover:bg-[#F4F2ED]"
                        >
                          <Eye className="h-3 w-3" /> View XML
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rawModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#141413]/50 p-4">
          <div className="w-full max-w-4xl rounded border border-[#D4CFC5] bg-white shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#E5E2DC] bg-[#141413] px-5 py-3 text-white">
              <div className="text-sm font-semibold font-mono">{rawModal.name}</div>
              <button onClick={() => setRawModal(null)} className="rounded p-1 hover:bg-[#2A2927]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4">
              <pre className="max-h-[70vh] overflow-auto rounded border border-[#D4CFC5] bg-[#141413] p-4 text-xs font-mono text-slate-100">
                {rawModal.content}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
