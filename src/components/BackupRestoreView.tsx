import { useEffect, useRef, useState } from 'react';
import { Database, Download, HardDriveUpload, History, RotateCcw } from 'lucide-react';
import type { AuditLogItem, BackupItem } from '../types.ts';
import { formatBytes, formatDateTime } from '../lib/formatters.ts';
import { getAuthHeaders } from '../lib/apiAuth.ts';

interface BackupRestoreViewProps {
  refreshKey: number;
  onDatabaseRestored: () => void;
}

export function BackupRestoreView({ refreshKey, onDatabaseRestored }: BackupRestoreViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [storage, setStorage] = useState<{
    dbPath: string;
    dbSizeBytes: number;
    xmlArchiveBytes: number;
    archiveFileCount: number;
    totalEntries: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  function loadData() {
    Promise.all([
      fetch('/api/backups', { headers: getAuthHeaders() }).then((r) => r.json()),
      fetch('/api/audit-logs?limit=150', { headers: getAuthHeaders() }).then((r) => r.json()),
    ]).then(([bData, aData]) => {
      setBackups(bData.backups ?? []);
      setStorage(bData.storage ?? null);
      setAuditLogs(Array.isArray(aData) ? aData : []);
    });
  }

  useEffect(() => {
    loadData();
  }, [refreshKey]);

  async function handleCreateBackup() {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/backups', { method: 'POST', headers: getAuthHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Backup failed');
      setStatusMsg({ type: 'ok', text: `SQLite snapshot created: ${data.fileName}` });
      loadData();
    } catch (err) {
      setStatusMsg({ type: 'err', text: err instanceof Error ? err.message : 'Backup failed' });
    } finally {
      setBusy(false);
    }
  }

  async function handleDownloadBackup(b: BackupItem) {
    try {
      const res = await fetch(`/api/backups/${encodeURIComponent(b.id)}/download`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = b.file_name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setStatusMsg({ type: 'err', text: err instanceof Error ? err.message : 'Download failed' });
    }
  }

  async function handleRestoreBackup(id: string) {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await fetch(`/api/backups/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Restore failed');
      setConfirmRestoreId(null);
      setStatusMsg({
        type: 'ok',
        text: `Database restored from ${data.restoredFrom} (a pre-restore snapshot was automatically saved).`,
      });
      loadData();
      onDatabaseRestored();
    } catch (err) {
      setStatusMsg({ type: 'err', text: err instanceof Error ? err.message : 'Restore failed' });
    } finally {
      setBusy(false);
    }
  }

  async function handleUploadRestore(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const fd = new FormData();
      fd.append('backupFile', fileList[0]);
      const res = await fetch('/api/backups/upload-restore', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload restore failed');
      setStatusMsg({ type: 'ok', text: `Database restored from ${data.restoredFrom}.` });
      loadData();
      onDatabaseRestored();
    } catch (err) {
      setStatusMsg({ type: 'err', text: err instanceof Error ? err.message : 'Restore failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Storage Summary & Actions */}
      <div className="rounded border border-[#E5E2DC] bg-white p-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-[#141413]">
              SQLite Database Backups & XML Archive Storage
            </h2>
            <p className="mt-1 text-xs text-[#57534E]">
              Creates consistent hot snapshots of the local SQLite database while preserving all original imported XML files separately.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".db,.sqlite,.sqlite3"
              className="hidden"
              onChange={(e) => handleUploadRestore(e.target.files)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded border border-[#D4CFC5] bg-white px-3.5 py-2 text-xs font-medium text-[#57534E] hover:bg-[#F4F2ED]"
            >
              <HardDriveUpload className="h-3.5 w-3.5" />
              Restore from .db File
            </button>
            <button
              onClick={handleCreateBackup}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded bg-[#141413] px-4 py-2 text-xs font-medium text-white hover:bg-[#2A2927]"
            >
              <Database className="h-3.5 w-3.5" />
              Create Backup Now
            </button>
          </div>
        </div>

        {storage && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
            <div className="rounded border border-[#E5E2DC] bg-[#FCFBF9] p-3">
              <div className="text-[11px] text-[#78716C]">SQLite Database Size</div>
              <div className="mt-1 text-base font-semibold font-mono tabular-nums text-[#141413]">
                {formatBytes(storage.dbSizeBytes)}
              </div>
            </div>
            <div className="rounded border border-[#E5E2DC] bg-[#FCFBF9] p-3">
              <div className="text-[11px] text-[#78716C]">Archived XML Files</div>
              <div className="mt-1 text-base font-semibold font-mono tabular-nums text-[#141413]">
                {storage.archiveFileCount} ({formatBytes(storage.xmlArchiveBytes)})
              </div>
            </div>
            <div className="rounded border border-[#E5E2DC] bg-[#FCFBF9] p-3">
              <div className="text-[11px] text-[#78716C]">Stored Records</div>
              <div className="mt-1 text-base font-semibold font-mono tabular-nums text-[#141413]">
                {storage.totalEntries.toLocaleString()}
              </div>
            </div>
            <div className="rounded border border-[#E5E2DC] bg-[#FCFBF9] p-3">
              <div className="text-[11px] text-[#78716C]">Saved Snapshots</div>
              <div className="mt-1 text-base font-semibold font-mono tabular-nums text-[#141413]">
                {backups.length}
              </div>
            </div>
          </div>
        )}

        {statusMsg && (
          <div
            className={`rounded border px-4 py-2.5 text-xs font-medium ${
              statusMsg.type === 'ok'
                ? 'border-[#BBF7D0] bg-[#F0FDF4] text-[#15803D]'
                : 'border-[#FECACA] bg-[#FEF2F2] text-[#B91C1C]'
            }`}
          >
            {statusMsg.text}
          </div>
        )}
      </div>

      {/* Saved Backups Table */}
      <div className="rounded border border-[#E5E2DC] bg-white overflow-hidden">
        <div className="border-b border-[#E5E2DC] px-5 py-3.5">
          <h3 className="text-sm font-semibold text-[#141413]">Local Backup Snapshots</h3>
        </div>
        {backups.length === 0 ? (
          <div className="p-8 text-center text-xs text-[#78716C]">
            No backups created yet. Backups are also created automatically prior to autosave imports.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#E5E2DC] bg-[#FCFBF9] text-[11px] font-semibold text-[#57534E]">
                <tr>
                  <th className="px-4 py-2.5">Snapshot File</th>
                  <th className="px-4 py-2.5">Trigger</th>
                  <th className="px-4 py-2.5 text-right">Channels / Entries</th>
                  <th className="px-4 py-2.5 text-right">Size</th>
                  <th className="px-4 py-2.5">Created At</th>
                  <th className="px-4 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E2DC]">
                {backups.map((b) => (
                  <tr key={b.id} className="hover:bg-[#FCFBF9]">
                    <td className="px-4 py-2.5 font-mono text-[#141413]">{b.file_name}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-[#57534E]">{b.trigger_type}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {b.channel_count} ch / {b.entry_count.toLocaleString()} ent
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#57534E]">
                      {formatBytes(b.size_bytes)}
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums text-[#78716C]">
                      {formatDateTime(b.created_at)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap space-x-2">
                      <button
                        type="button"
                        onClick={() => handleDownloadBackup(b)}
                        className="inline-flex items-center gap-1 rounded border border-[#D4CFC5] bg-white px-2.5 py-1 text-[11px] font-medium text-[#57534E] hover:bg-[#F4F2ED]"
                      >
                        <Download className="h-3 w-3" /> Download
                      </button>

                      {confirmRestoreId === b.id ? (
                        <span className="inline-flex items-center gap-1.5">
                          <button
                            onClick={() => handleRestoreBackup(b.id)}
                            disabled={busy}
                            className="rounded bg-[#B91C1C] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#991B1B]"
                          >
                            Confirm Restore
                          </button>
                          <button
                            onClick={() => setConfirmRestoreId(null)}
                            className="rounded border border-[#D4CFC5] bg-white px-2 py-1 text-[11px] text-[#57534E]"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmRestoreId(b.id)}
                          className="inline-flex items-center gap-1 rounded border border-[#D4CFC5] bg-white px-2.5 py-1 text-[11px] font-medium text-[#57534E] hover:bg-[#F4F2ED]"
                        >
                          <RotateCcw className="h-3 w-3" /> Restore
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Audit History Log */}
      <div className="rounded border border-[#E5E2DC] bg-white overflow-hidden">
        <div className="border-b border-[#E5E2DC] px-5 py-3.5 flex items-center gap-2">
          <History className="h-4 w-4 text-[#141413]" />
          <h3 className="text-sm font-semibold text-[#141413]">Audit Trail (Imports, Corrections, QA & Backups)</h3>
        </div>
        {auditLogs.length === 0 ? (
          <div className="p-8 text-center text-xs text-[#78716C]">No audit events recorded yet.</div>
        ) : (
          <div className="max-h-96 overflow-y-auto overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#E5E2DC] bg-[#FCFBF9] text-[11px] font-semibold text-[#57534E]">
                <tr>
                  <th className="px-4 py-2">Timestamp</th>
                  <th className="px-4 py-2">Entity</th>
                  <th className="px-4 py-2">Action</th>
                  <th className="px-4 py-2">Field / Change</th>
                  <th className="px-4 py-2">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E2DC]">
                {auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-[#FCFBF9]">
                    <td className="px-4 py-2 font-mono tabular-nums text-[#78716C] whitespace-nowrap">
                      {formatDateTime(log.timestamp)}
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-[#57534E] whitespace-nowrap">
                      {log.entity_type} · {log.entity_id.slice(0, 14)}
                    </td>
                    <td className="px-4 py-2 font-medium text-[#141413] whitespace-nowrap">
                      {log.action}
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-[#57534E] max-w-[260px] truncate">
                      {log.field_name ? `${log.field_name}: ${log.old_value ?? '—'} -> ${log.new_value ?? '—'}` : log.new_value ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-[#57534E] max-w-[260px] truncate">{log.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
