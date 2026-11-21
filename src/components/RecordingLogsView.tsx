import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  CheckCircle2,
  CloudUpload,
  RefreshCw,
} from 'lucide-react';
import { getAuthHeaders } from '../lib/apiAuth.ts';
import { formatBytes, formatDateTime } from '../lib/formatters.ts';

interface RecordingLogsViewProps {
  refreshKey: number;
}

interface RecordingErrorRow {
  id: string;
  channel_key: string | null;
  channel_name: string | null;
  session_id: string | null;
  severity: string;
  error_code: string;
  message: string;
  details: string | null;
  resolved: number;
  created_at: string;
}

interface RecordingSessionRow {
  id: string;
  channel_key: string;
  channel_name: string;
  worker_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  reconnect_count: number;
  segments_created: number;
  bytes_recorded: number;
  last_error: string | null;
}

interface CloudUploadRow {
  id: string;
  segment_id: string;
  channel_key: string;
  channel_name: string | null;
  file_name: string | null;
  record_date: string | null;
  storage_provider: string;
  bucket: string;
  object_key: string;
  file_size_bytes: number;
  status: string;
  attempts: number;
  max_attempts: number;
  etag: string | null;
  verified_at: string | null;
  last_error: string | null;
  created_at: string;
}

type LogTab = 'errors' | 'sessions' | 'uploads';

export function RecordingLogsView({ refreshKey }: RecordingLogsViewProps) {
  const [tab, setTab] = useState<LogTab>('errors');
  const [channelFilter, setChannelFilter] = useState('ALL');
  const [channels, setChannels] = useState<Array<{ id: string; channel_name: string }>>([]);
  const [errors, setErrors] = useState<RecordingErrorRow[]>([]);
  const [sessions, setSessions] = useState<RecordingSessionRow[]>([]);
  const [uploads, setUploads] = useState<CloudUploadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/channels')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setChannels(data);
      })
      .catch(() => {});
  }, [refreshKey]);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (channelFilter !== 'ALL') qs.set('channelKey', channelFilter);
      qs.set('limit', '200');
      const res = await fetch(`/api/recording/logs?${qs.toString()}`);
      const data = await res.json();
      setErrors(data.errors ?? []);
      setSessions(data.sessions ?? []);
      setUploads(data.uploads ?? []);
    } finally {
      setLoading(false);
    }
  }, [channelFilter]);

  useEffect(() => {
    loadLogs();
  }, [refreshKey, loadLogs]);

  async function handleResolveError(id: string) {
    setResolvingId(id);
    try {
      await fetch(`/api/recording/errors/${encodeURIComponent(id)}/resolve`, {
        method: 'PATCH',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      });
      await loadLogs();
    } finally {
      setResolvingId(null);
    }
  }

  const unresolvedErrors = errors.filter((e) => !e.resolved).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] text-[#141413] dark:text-[#F4F2ED]">
            Recording & Upload Logs
          </h2>
          <p className="mt-1 text-[13px] text-[#57534E] dark:text-[#A8A29E]">
            Live operational audit of backend FFmpeg worker sessions, stream reconnects, failure alerts, and S3/R2 cloud upload verification.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            className="rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#1B1B1A] px-3 py-2 text-xs text-[#141413] dark:text-[#F4F2ED]"
          >
            <option value="ALL">All Channels</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.channel_name}
              </option>
            ))}
          </select>

          <button
            onClick={loadLogs}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#1B1B1A] px-3 py-2 text-xs font-medium text-[#57534E] dark:text-[#A8A29E] hover:text-[#141413] dark:hover:text-[#F4F2ED] transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#E5E2DC] dark:border-[#2C2C2A]">
        <button
          onClick={() => setTab('errors')}
          className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-medium transition-colors ${
            tab === 'errors'
              ? 'border-[#C83A1B] text-[#141413] dark:text-[#F4F2ED]'
              : 'border-transparent text-[#57534E] dark:text-[#A8A29E] hover:text-[#141413] dark:hover:text-[#F4F2ED]'
          }`}
        >
          <AlertOctagon className="h-3.5 w-3.5" />
          Errors & Alerts
          <span className="font-mono tabular-nums text-[11px] text-[#B91C1C]">
            ({unresolvedErrors} open / {errors.length})
          </span>
        </button>

        <button
          onClick={() => setTab('sessions')}
          className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-medium transition-colors ${
            tab === 'sessions'
              ? 'border-[#C83A1B] text-[#141413] dark:text-[#F4F2ED]'
              : 'border-transparent text-[#57534E] dark:text-[#A8A29E] hover:text-[#141413] dark:hover:text-[#F4F2ED]'
          }`}
        >
          <Activity className="h-3.5 w-3.5" />
          Worker Sessions
          <span className="font-mono tabular-nums text-[11px]">({sessions.length})</span>
        </button>

        <button
          onClick={() => setTab('uploads')}
          className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-medium transition-colors ${
            tab === 'uploads'
              ? 'border-[#C83A1B] text-[#141413] dark:text-[#F4F2ED]'
              : 'border-transparent text-[#57534E] dark:text-[#A8A29E] hover:text-[#141413] dark:hover:text-[#F4F2ED]'
          }`}
        >
          <CloudUpload className="h-3.5 w-3.5" />
          Cloud Uploads
          <span className="font-mono tabular-nums text-[11px]">({uploads.length})</span>
        </button>
      </div>

      {/* Tab Content */}
      <section className="rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] overflow-hidden">
        {tab === 'errors' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#E5E2DC] dark:border-[#2C2C2A] bg-[#FCFBF9] dark:bg-[#161614] text-[11px] font-medium text-[#78716C] dark:text-[#A8A29E]">
                <tr>
                  <th className="px-4 py-2.5">Severity / Code</th>
                  <th className="px-4 py-2.5">Channel</th>
                  <th className="px-4 py-2.5">Message & Details</th>
                  <th className="px-4 py-2.5 text-right">Timestamp</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFECE6] dark:divide-[#262624]">
                {errors.map((err) => (
                  <tr key={err.id} className="hover:bg-[#F8F7F4] dark:hover:bg-[#222220]">
                    <td className="px-4 py-3 whitespace-nowrap align-top">
                      <div
                        className={`font-mono text-[11px] font-semibold ${
                          err.resolved
                            ? 'text-[#78716C]'
                            : err.severity === 'ERROR'
                              ? 'text-[#B91C1C]'
                              : 'text-[#B45309]'
                        }`}
                      >
                        {err.severity} · {err.error_code}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-medium text-[#141413] dark:text-[#F4F2ED] whitespace-nowrap align-top">
                      {err.channel_name || 'System'}
                    </td>
                    <td className="px-4 py-3 text-[#57534E] dark:text-[#A8A29E] max-w-xl align-top">
                      <div className="font-medium text-[#141413] dark:text-[#F4F2ED]">{err.message}</div>
                      {err.details && (
                        <div className="mt-1 font-mono text-[11px] text-[#78716C] dark:text-[#A8A29E] break-all">
                          {err.details}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-[11px] text-[#78716C] dark:text-[#A8A29E] whitespace-nowrap align-top">
                      {formatDateTime(err.created_at)}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap align-top">
                      {err.resolved ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-[#15803D]">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Resolved
                        </span>
                      ) : (
                        <button
                          onClick={() => handleResolveError(err.id)}
                          disabled={resolvingId === err.id}
                          className="rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-2.5 py-1 text-[11px] font-medium text-[#141413] dark:text-[#F4F2ED] hover:bg-[#F4F2ED] dark:hover:bg-[#242422] disabled:opacity-50"
                        >
                          Mark Resolved
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {errors.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-xs text-[#78716C] dark:text-[#A8A29E]">
                      No recording or upload errors logged.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'sessions' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#E5E2DC] dark:border-[#2C2C2A] bg-[#FCFBF9] dark:bg-[#161614] text-[11px] font-medium text-[#78716C] dark:text-[#A8A29E]">
                <tr>
                  <th className="px-4 py-2.5">Channel</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Worker ID</th>
                  <th className="px-4 py-2.5">Started</th>
                  <th className="px-4 py-2.5">Ended</th>
                  <th className="px-4 py-2.5 text-right">Reconnects</th>
                  <th className="px-4 py-2.5 text-right">Segments</th>
                  <th className="px-4 py-2.5 text-right">Recorded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFECE6] dark:divide-[#262624]">
                {sessions.map((s) => (
                  <tr key={s.id} className="hover:bg-[#F8F7F4] dark:hover:bg-[#222220]">
                    <td className="px-4 py-3 font-medium text-[#141413] dark:text-[#F4F2ED] whitespace-nowrap">
                      {s.channel_name}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] whitespace-nowrap">
                      <span
                        className={
                          s.status === 'RECORDING'
                            ? 'text-[#15803D] font-semibold'
                            : s.status === 'RECONNECTING'
                              ? 'text-[#B45309] font-semibold'
                              : s.status === 'ERROR'
                                ? 'text-[#B91C1C] font-semibold'
                                : 'text-[#57534E] dark:text-[#A8A29E]'
                        }
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-[#78716C] dark:text-[#A8A29E]">
                      {s.worker_id}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-[11px] text-[#57534E] dark:text-[#A8A29E] whitespace-nowrap">
                      {formatDateTime(s.started_at)}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-[11px] text-[#78716C] dark:text-[#A8A29E] whitespace-nowrap">
                      {s.ended_at ? formatDateTime(s.ended_at) : 'Active'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-[#57534E] dark:text-[#A8A29E]">
                      {s.reconnect_count}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-[#57534E] dark:text-[#A8A29E]">
                      {s.segments_created}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-[#141413] dark:text-[#F4F2ED]">
                      {formatBytes(s.bytes_recorded)}
                    </td>
                  </tr>
                ))}
                {sessions.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-xs text-[#78716C] dark:text-[#A8A29E]">
                      No backend recording sessions have started yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'uploads' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#E5E2DC] dark:border-[#2C2C2A] bg-[#FCFBF9] dark:bg-[#161614] text-[11px] font-medium text-[#78716C] dark:text-[#A8A29E]">
                <tr>
                  <th className="px-4 py-2.5">Channel / Segment</th>
                  <th className="px-4 py-2.5">Provider / Object Key</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Attempts</th>
                  <th className="px-4 py-2.5 text-right">Size</th>
                  <th className="px-4 py-2.5 text-right">Verified / Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFECE6] dark:divide-[#262624]">
                {uploads.map((u) => (
                  <tr key={u.id} className="hover:bg-[#F8F7F4] dark:hover:bg-[#222220]">
                    <td className="px-4 py-3 align-top">
                      <div className="font-medium text-[#141413] dark:text-[#F4F2ED]">
                        {u.channel_name || u.channel_key}
                      </div>
                      <div className="font-mono text-[11px] text-[#78716C] dark:text-[#A8A29E]">
                        {u.file_name || u.segment_id}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top max-w-md">
                      <div className="font-mono text-[11px] text-[#141413] dark:text-[#F4F2ED]">
                        {u.storage_provider} {u.bucket ? `(${u.bucket})` : ''}
                      </div>
                      <div className="font-mono text-[11px] text-[#78716C] dark:text-[#A8A29E] truncate" title={u.object_key}>
                        {u.object_key}
                      </div>
                      {u.last_error && (
                        <div className="mt-1 text-[11px] text-[#B91C1C] dark:text-[#FCA5A5]">
                          {u.last_error}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] whitespace-nowrap align-top">
                      <span
                        className={
                          u.status === 'VERIFIED'
                            ? 'text-[#15803D] font-semibold'
                            : u.status === 'FAILED'
                              ? 'text-[#B91C1C] font-semibold'
                              : 'text-[#B45309] font-semibold'
                        }
                      >
                        {u.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-[#57534E] dark:text-[#A8A29E] align-top">
                      {u.attempts}/{u.max_attempts}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-[#141413] dark:text-[#F4F2ED] align-top">
                      {formatBytes(u.file_size_bytes)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-[11px] text-[#78716C] dark:text-[#A8A29E] whitespace-nowrap align-top">
                      {formatDateTime(u.verified_at || u.created_at)}
                    </td>
                  </tr>
                ))}
                {uploads.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-xs text-[#78716C] dark:text-[#A8A29E]">
                      No cloud upload jobs recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
