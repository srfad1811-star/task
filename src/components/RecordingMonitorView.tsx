import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCw,
  Search,
  Settings2,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { getAuthHeaders } from '../lib/apiAuth.ts';
import { formatDateTime } from '../lib/formatters.ts';

interface MonitorChannelRow {
  channelKey: string;
  channelId: string | null;
  channelName: string;
  category: string;
  source: {
    id: string;
    sourceType: string;
    streamUrlRedacted: string;
    recordingPermission: string;
    segmentDurationSeconds: number;
    isEnabled: boolean;
    autoRecord247: boolean;
    lastProbeStatus: string;
    lastProbeAt: string | null;
    lastProbeError: string | null;
    resolution: string | null;
    videoCodec: string | null;
    historicalArchiveEndpoint: string | null;
  } | null;
  status: 'RECORDING' | 'RECONNECTING' | 'STOPPED' | 'NO_SOURCE' | 'RESTRICTED' | 'ERROR';
  sessionId: string | null;
  recordingStartedAt: string | null;
  currentDurationSeconds: number;
  todayRecordedSeconds: number;
  totalRecordedHours: number;
  totalVideoSegments: number;
  todaySegments: number;
  totalStorageBytes: number;
  totalStorageGb: number;
  uploadStatus: 'IDLE' | 'UPLOADING' | 'VERIFIED' | 'FAILED';
  lastSuccessfulUploadAt: string | null;
  failedUploads: number;
  interruptionsCount: number;
  currentError: string | null;
}

interface MonitorResponse {
  worker: {
    workerId: string;
    hostname: string;
    pid: number;
    activeRecordingCount: number;
    uptimeSeconds: number;
  };
  ffmpeg: { available: boolean; version: string | null };
  generatedAt: string;
  summary: {
    totalChannels: number;
    recordingNow: number;
    reconnecting: number;
    configuredSources: number;
    totalStorageGb: number;
    totalRecordedHours: number;
    totalSegments: number;
  };
  channels: MonitorChannelRow[];
}

interface RecordingScheduleRow {
  id: string;
  channel_key: string;
  channel_name: string;
  mode: string;
  start_time: string | null;
  end_time: string | null;
  days_of_week: string;
  is_enabled: number;
}

interface RecordingMonitorViewProps {
  refreshKey: number;
  onOpenArchiveForChannel: (channelKey: string) => void;
}

function formatHoursMinutes(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(rem).padStart(2, '0')}s`;
  return `${rem}s`;
}

export function RecordingMonitorView({
  refreshKey,
  onOpenArchiveForChannel,
}: RecordingMonitorViewProps) {
  const [data, setData] = useState<MonitorResponse | null>(null);
  const [schedules, setSchedules] = useState<RecordingScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [installingFfmpeg, setInstallingFfmpeg] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Configure Recording Source Modal
  const [editingChannel, setEditingChannel] = useState<MonitorChannelRow | null>(null);
  const [srcUrl, setSrcUrl] = useState('');
  const [srcType, setSrcType] = useState('HLS_M3U8');
  const [srcPermission, setSrcPermission] = useState('AUTHORIZED');
  const [srcSegmentSec, setSrcSegmentSec] = useState(3600);
  const [srcAuto247, setSrcAuto247] = useState(true);
  const [srcHistEndpoint, setSrcHistEndpoint] = useState('');
  const [savingSource, setSavingSource] = useState(false);

  // Schedule Form
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [schChannelKey, setSchChannelKey] = useState('');
  const [schMode, setSchMode] = useState<'CONTINUOUS_24_7' | 'SCHEDULED'>('CONTINUOUS_24_7');
  const [schStart, setSchStart] = useState('00:00');
  const [schEnd, setSchEnd] = useState('23:59');

  const fetchAll = useCallback(async () => {
    try {
      const [monRes, schRes] = await Promise.all([
        fetch('/api/recording/monitor'),
        fetch('/api/recording/schedules'),
      ]);
      if (monRes.ok) {
        const json = (await monRes.json()) as MonitorResponse;
        setData(json);
      }
      if (schRes.ok) {
        setSchedules(await schRes.json());
      }
    } finally {
      setLoading(false);
    }
  }, []);

  async function handleInstallFfmpeg() {
    setInstallingFfmpeg(true);
    setNotice(null);
    try {
      const res = await fetch('/api/recording/install-ffmpeg', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'FFmpeg runtime installation failed.');
      setNotice({
        kind: 'ok',
        text: `FFmpeg Engine ready: ${json.version || 'installed'}`,
      });
      await fetchAll();
    } catch (err) {
      setNotice({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to install FFmpeg engine.',
      });
    } finally {
      setInstallingFfmpeg(false);
    }
  }

  useEffect(() => {
    fetchAll();
    const timer = setInterval(fetchAll, 5000);
    return () => clearInterval(timer);
  }, [fetchAll, refreshKey]);

  async function handleAction(channelKey: string, action: 'start' | 'stop' | 'restart') {
    setBusyKey(`${channelKey}:${action}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/recording/${action}`, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ channelKey }),
      });
      const json = await res.json();
      if (!res.ok) {
        setNotice({ kind: 'err', text: json.error || `Failed to ${action} recording.` });
      } else {
        setNotice({
          kind: 'ok',
          text: json.message || `Recording ${action} command confirmed by cloud worker.`,
        });
      }
      await fetchAll();
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Request failed' });
    } finally {
      setBusyKey(null);
    }
  }

  async function handleStartAll() {
    setBusyKey('start_all');
    setNotice(null);
    try {
      const res = await fetch('/api/recording/start-all', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: '{}',
      });
      const json = await res.json();
      if (!res.ok) {
        setNotice({ kind: 'err', text: json.error || 'Failed to start recordings.' });
      } else {
        setNotice({
          kind: 'ok',
          text: `Started ${json.started} of ${json.total} authorized channel recording(s).`,
        });
      }
      await fetchAll();
    } finally {
      setBusyKey(null);
    }
  }

  async function handleProbeSource(sourceId: string) {
    setBusyKey(`probe:${sourceId}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/recording/sources/${encodeURIComponent(sourceId)}/probe`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const json = await res.json();
      if (!res.ok) {
        setNotice({ kind: 'err', text: json.error || 'Probe failed.' });
      } else if (json.reachable) {
        setNotice({
          kind: 'ok',
          text: `Stream reachable (${json.videoCodec || 'video'} ${json.resolution || ''}).`,
        });
      } else {
        setNotice({ kind: 'err', text: `Stream unreachable: ${json.error || 'Connection failed.'}` });
      }
      await fetchAll();
    } finally {
      setBusyKey(null);
    }
  }

  function openSourceModal(row: MonitorChannelRow) {
    setEditingChannel(row);
    setSrcUrl('');
    setSrcType(row.source?.sourceType || 'HLS_M3U8');
    setSrcPermission(row.source?.recordingPermission || 'AUTHORIZED');
    setSrcSegmentSec(row.source?.segmentDurationSeconds || 3600);
    setSrcAuto247(row.source?.autoRecord247 ?? true);
    setSrcHistEndpoint(row.source?.historicalArchiveEndpoint || '');
  }

  async function handleSaveSource(e: React.FormEvent) {
    e.preventDefault();
    if (!editingChannel || !srcUrl.trim()) return;
    setSavingSource(true);
    setNotice(null);
    try {
      const res = await fetch('/api/recording/sources', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          channelKey: editingChannel.channelKey,
          sourceType: srcType,
          streamUrl: srcUrl.trim(),
          recordingPermission: srcPermission,
          segmentDurationSeconds: srcSegmentSec,
          autoRecord247: srcAuto247,
          historicalArchiveEndpoint: srcHistEndpoint.trim() || undefined,
          isEnabled: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setNotice({ kind: 'err', text: json.error || 'Failed to save recording source.' });
      } else {
        setNotice({
          kind: 'ok',
          text: `Saved encrypted recording source for ${editingChannel.channelName}.`,
        });
        setEditingChannel(null);
        await fetchAll();
      }
    } finally {
      setSavingSource(false);
    }
  }

  async function handleCreateSchedule(e: React.FormEvent) {
    e.preventDefault();
    if (!schChannelKey) return;
    const res = await fetch('/api/recording/schedules', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        channelKey: schChannelKey,
        mode: schMode,
        startTime: schMode === 'SCHEDULED' ? schStart : undefined,
        endTime: schMode === 'SCHEDULED' ? schEnd : undefined,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setNotice({ kind: 'err', text: json.error || 'Failed to add schedule.' });
    } else {
      setNotice({ kind: 'ok', text: 'Recording schedule saved.' });
      setShowScheduleForm(false);
      await fetchAll();
    }
  }

  async function handleDeleteSchedule(id: string) {
    await fetch(`/api/recording/schedules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    await fetchAll();
  }

  const rows = (data?.channels ?? []).filter((r) => {
    const q = search.trim().toLowerCase();
    if (q && !r.channelName.toLowerCase().includes(q) && !(r.channelId ?? '').toLowerCase().includes(q)) {
      return false;
    }
    if (statusFilter === 'RECORDING') return r.status === 'RECORDING';
    if (statusFilter === 'CONFIGURED') return r.source !== null;
    if (statusFilter === 'NO_SOURCE') return r.source === null;
    if (statusFilter === 'ISSUES') return r.status === 'RECONNECTING' || r.status === 'ERROR' || r.failedUploads > 0;
    return true;
  });

  const statusMeta = (status: MonitorChannelRow['status']) => {
    switch (status) {
      case 'RECORDING':
        return { label: 'Recording', cls: 'text-[#15803D] dark:text-emerald-400 font-semibold' };
      case 'RECONNECTING':
        return { label: 'Reconnecting', cls: 'text-[#A16207] dark:text-amber-400 font-semibold' };
      case 'RESTRICTED':
        return { label: 'Restricted', cls: 'text-[#B91C1C] dark:text-red-400 font-medium' };
      case 'ERROR':
        return { label: 'Error', cls: 'text-[#B91C1C] dark:text-red-400 font-semibold' };
      case 'NO_SOURCE':
        return { label: 'No Source', cls: 'text-[#8A847C] dark:text-stone-400' };
      default:
        return { label: 'Stopped', cls: 'text-[#57534E] dark:text-stone-300' };
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="h-24 rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-white dark:bg-stone-900 animate-pulse" />
        <div className="h-72 rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-white dark:bg-stone-900 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] text-[#141413] dark:text-stone-100">
            24/7 Cloud Recording Monitor
          </h2>
          <p className="mt-1 text-[13px] text-[#57534E] dark:text-stone-400">
            Server-side FFmpeg recording workers run independently of Chrome. Only authorized, reachable streams report active recording.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => fetchAll()}
            className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-900 px-3 py-1.5 text-xs font-medium text-[#141413] dark:text-stone-200 hover:bg-[#F4F2ED] dark:hover:bg-stone-800 whitespace-nowrap"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          <button
            onClick={() => setShowScheduleForm((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-900 px-3 py-1.5 text-xs font-medium text-[#141413] dark:text-stone-200 hover:bg-[#F4F2ED] dark:hover:bg-stone-800 whitespace-nowrap"
          >
            <CalendarClock className="h-3.5 w-3.5" />
            Schedules ({schedules.length})
          </button>
          <button
            onClick={handleStartAll}
            disabled={busyKey === 'start_all'}
            className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#C83A1B] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#A82E13] disabled:opacity-50 whitespace-nowrap"
          >
            <Play className="h-3 w-3 fill-current" />
            {busyKey === 'start_all' ? 'Starting…' : 'Start All Authorized'}
          </button>
        </div>
      </div>

      {notice && (
        <div
          className={`rounded-[3px] border px-4 py-2.5 text-xs flex items-center justify-between gap-3 ${
            notice.kind === 'ok'
              ? 'border-[#C7DEC9] bg-[#F0F5F2] text-[#14532D] dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'border-[#FCA5A5] bg-[#FEF2F2] text-[#B91C1C] dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'
          }`}
        >
          <span className="inline-flex items-center gap-2">
            {notice.kind === 'ok' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0" />
            )}
            {notice.text}
          </span>
          <button onClick={() => setNotice(null)} className="font-semibold px-1">
            ×
          </button>
        </div>
      )}

      {/* Worker Health & 24h Telemetry Ledger */}
      <section className="rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-white dark:bg-stone-900">
        <div className="grid grid-cols-2 lg:grid-cols-5 divide-y lg:divide-y-0 lg:divide-x divide-[#E5E2DC] dark:divide-stone-800">
          <div className="p-4">
            <div className="text-xs text-[#78716C] dark:text-stone-400">Active Recording Workers</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#141413] dark:text-stone-100">
              {data?.summary.recordingNow ?? 0}
              <span className="text-xs font-normal text-[#78716C] dark:text-stone-400">
                {' '}
                / {data?.summary.configuredSources ?? 0} configured
              </span>
            </div>
            <div className="mt-1 text-[11px] text-[#78716C] dark:text-stone-400">
              {data?.summary.reconnecting ?? 0} reconnecting · {data?.summary.totalChannels ?? 0} total channels
            </div>
          </div>

          <div className="p-4">
            <div className="text-xs text-[#78716C] dark:text-stone-400">Total Recorded Hours</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#141413] dark:text-stone-100">
              {(data?.summary.totalRecordedHours ?? 0).toFixed(2)}h
            </div>
            <div className="mt-1 text-[11px] text-[#78716C] dark:text-stone-400 font-mono tabular-nums">
              {data?.summary.totalSegments ?? 0} verified segments
            </div>
          </div>

          <div className="p-4">
            <div className="text-xs text-[#78716C] dark:text-stone-400">Archived Storage</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#141413] dark:text-stone-100">
              {(data?.summary.totalStorageGb ?? 0).toFixed(2)} GB
            </div>
            <div className="mt-1 text-[11px] text-[#78716C] dark:text-stone-400">
              Actual verified archive size
            </div>
          </div>

          <div className="p-4">
            <div className="text-xs text-[#78716C] dark:text-stone-400">FFmpeg Engine</div>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-sm font-semibold text-[#141413] dark:text-stone-100">
              {data?.ffmpeg.available ? (
                <span className="text-[#15803D] dark:text-emerald-400">Available</span>
              ) : (
                <>
                  <span className="text-[#B91C1C] dark:text-red-400">Not Installed</span>
                  <button
                    onClick={handleInstallFfmpeg}
                    disabled={installingFfmpeg}
                    className="rounded-[3px] bg-[#C83A1B] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#A82E13] disabled:opacity-50 whitespace-nowrap"
                  >
                    {installingFfmpeg ? 'Installing…' : 'Install Engine'}
                  </button>
                </>
              )}
            </div>
            <div
              className="mt-1 text-[11px] text-[#78716C] dark:text-stone-400 truncate font-mono"
              title={data?.ffmpeg.version || data?.worker.workerId || ''}
            >
              {data?.ffmpeg.available && data?.ffmpeg.version
                ? data.ffmpeg.version.split(' Copyright')[0]
                : data?.worker.workerId}
            </div>
          </div>

          <div className="p-4">
            <div className="text-xs text-[#78716C] dark:text-stone-400">Worker Uptime</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#141413] dark:text-stone-100">
              {formatHoursMinutes(data?.worker.uptimeSeconds ?? 0)}
            </div>
            <div className="mt-1 text-[11px] text-[#78716C] dark:text-stone-400 font-mono tabular-nums">
              Synced {data ? formatDateTime(data.generatedAt).slice(11) : '—'}
            </div>
          </div>
        </div>
      </section>

      {/* Schedules Drawer Panel */}
      {showScheduleForm && (
        <section className="rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-white dark:bg-stone-900 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold text-[#141413] dark:text-stone-100">
              Cloud Recording Schedules
            </h3>
            <button onClick={() => setShowScheduleForm(false)} className="text-xs text-[#78716C] hover:text-[#141413]">
              Close
            </button>
          </div>

          <form onSubmit={handleCreateSchedule} className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end text-xs">
            <div className="sm:col-span-2">
              <label className="block text-[#57534E] dark:text-stone-400 mb-1">Channel (with configured source)</label>
              <select
                value={schChannelKey}
                onChange={(e) => setSchChannelKey(e.target.value)}
                required
                className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-1.5 text-[#141413] dark:text-stone-100"
              >
                <option value="">Select channel…</option>
                {(data?.channels ?? [])
                  .filter((c) => c.source !== null)
                  .map((c) => (
                    <option key={c.channelKey} value={c.channelKey}>
                      {c.channelName}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="block text-[#57534E] dark:text-stone-400 mb-1">Mode</label>
              <select
                value={schMode}
                onChange={(e) => setSchMode(e.target.value as 'CONTINUOUS_24_7' | 'SCHEDULED')}
                className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-1.5 text-[#141413] dark:text-stone-100"
              >
                <option value="CONTINUOUS_24_7">24/7 Continuous</option>
                <option value="SCHEDULED">Daily Window (UTC)</option>
              </select>
            </div>
            {schMode === 'SCHEDULED' ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="time"
                  value={schStart}
                  onChange={(e) => setSchStart(e.target.value)}
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-2 py-1.5 font-mono"
                />
                <input
                  type="time"
                  value={schEnd}
                  onChange={(e) => setSchEnd(e.target.value)}
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-2 py-1.5 font-mono"
                />
              </div>
            ) : (
              <div className="text-[11px] text-[#78716C] py-2">Auto-starts & recovers 24/7</div>
            )}
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-1 rounded-[3px] bg-[#141413] dark:bg-stone-100 px-3 py-1.5 font-medium text-white dark:text-stone-900 hover:bg-[#2A2927]"
            >
              <Plus className="h-3.5 w-3.5" /> Save Schedule
            </button>
          </form>

          {schedules.length > 0 && (
            <div className="divide-y divide-[#EFECE6] dark:divide-stone-800 border-t border-[#E5E2DC] dark:border-stone-800 pt-2">
              {schedules.map((s) => (
                <div key={s.id} className="py-2 flex items-center justify-between text-xs">
                  <div>
                    <span className="font-medium text-[#141413] dark:text-stone-100">{s.channel_name}</span>
                    <span className="mx-2 text-[#D4CFC5]">·</span>
                    <span className="text-[#57534E] dark:text-stone-400">
                      {s.mode === 'CONTINUOUS_24_7'
                        ? '24/7 Continuous'
                        : `Daily ${s.start_time}–${s.end_time} UTC`}
                    </span>
                  </div>
                  <button
                    onClick={() => handleDeleteSchedule(s.id)}
                    className="text-[#B91C1C] hover:underline inline-flex items-center gap-1"
                  >
                    <Trash2 className="h-3 w-3" /> Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 rounded-[3px] bg-[#F2F0EB] dark:bg-stone-800 p-1 text-xs">
          {[
            { id: 'ALL', label: `All (${data?.channels.length ?? 0})` },
            { id: 'RECORDING', label: `Recording (${data?.summary.recordingNow ?? 0})` },
            { id: 'CONFIGURED', label: `With Source (${data?.summary.configuredSources ?? 0})` },
            { id: 'NO_SOURCE', label: 'Needs Source' },
            { id: 'ISSUES', label: 'Alerts' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setStatusFilter(tab.id)}
              className={`rounded-[2px] px-3 py-1 font-medium transition-colors whitespace-nowrap ${
                statusFilter === tab.id
                  ? 'bg-white dark:bg-stone-900 text-[#141413] dark:text-stone-100 border border-[#DDD8CE] dark:border-stone-700'
                  : 'text-[#57534E] dark:text-stone-400 border border-transparent hover:text-[#141413]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="h-3.5 w-3.5 text-[#8A847C] absolute left-2.5 top-2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter channels…"
            className="rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-900 pl-8 pr-3 py-1.5 text-xs text-[#141413] dark:text-stone-100 w-56"
          />
        </div>
      </div>

      {/* Per-Channel 24-Hour Recording Table */}
      <section className="rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-white dark:bg-stone-900 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#E5E2DC] dark:border-stone-800 bg-[#FCFBF9] dark:bg-stone-950 text-[11px] font-medium text-[#78716C] dark:text-stone-400">
              <tr>
                <th className="px-4 py-3">Channel</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Today</th>
                <th className="px-4 py-3 text-right">Total Hours</th>
                <th className="px-4 py-3 text-right">Segments</th>
                <th className="px-4 py-3 text-right">Storage</th>
                <th className="px-4 py-3">Cloud Upload</th>
                <th className="px-4 py-3 text-right">Interruptions</th>
                <th className="sticky right-0 bg-[#FCFBF9] dark:bg-stone-950 border-l border-[#E5E2DC] dark:border-stone-800 px-4 py-3 text-right">
                  Controls
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EFECE6] dark:divide-stone-800">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-[#78716C] dark:text-stone-400">
                    No channels match this filter.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const st = statusMeta(row.status);
                  const todayPct = Math.min(100, (row.todayRecordedSeconds / 86400) * 100);
                  const isBusy = busyKey?.startsWith(`${row.channelKey}:`) ?? false;

                  return (
                    <tr key={row.channelKey} className="hover:bg-[#F8F7F4] dark:hover:bg-stone-800/50 transition-colors">
                      <td className="px-4 py-3 min-w-[200px]">
                        <div className="font-medium text-[#141413] dark:text-stone-100 flex items-center gap-2">
                          <span className="font-mono text-[11px] text-[#8A847C]">
                            {row.channelId || '—'}
                          </span>
                          <span>{row.channelName}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-[#78716C] dark:text-stone-400 truncate max-w-[260px]">
                          {row.source ? (
                            <span className="font-mono">{row.source.streamUrlRedacted}</span>
                          ) : (
                            'No authorized stream configured'
                          )}
                        </div>
                        {row.currentError && (
                          <div className="mt-1 text-[11px] text-[#B91C1C] dark:text-red-400 truncate max-w-[260px]" title={row.currentError}>
                            {row.currentError}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className={st.cls}>{st.label}</div>
                        {row.recordingStartedAt && row.status === 'RECORDING' && (
                          <div className="text-[10px] font-mono tabular-nums text-[#78716C]">
                            Since {formatDateTime(row.recordingStartedAt).slice(11)}
                          </div>
                        )}
                        {row.source && row.status !== 'RECORDING' && (
                          <div className="text-[10px] text-[#8A847C]">
                            {row.source.recordingPermission} · {row.source.lastProbeStatus}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3 text-right whitespace-nowrap min-w-[120px]">
                        <div className="font-mono tabular-nums font-medium text-[#141413] dark:text-stone-100">
                          {formatHoursMinutes(row.todayRecordedSeconds)}
                        </div>
                        <div className="mt-1 h-1 w-24 ml-auto rounded-[1px] bg-[#EAE7E0] dark:bg-stone-800 overflow-hidden">
                          <div
                            className="h-full bg-[#C83A1B]"
                            style={{ width: `${todayPct}%` }}
                          />
                        </div>
                      </td>

                      <td className="px-4 py-3 text-right font-mono tabular-nums text-[#141413] dark:text-stone-200 whitespace-nowrap">
                        {row.totalRecordedHours.toFixed(2)}h
                      </td>

                      <td className="px-4 py-3 text-right font-mono tabular-nums text-[#57534E] dark:text-stone-300 whitespace-nowrap">
                        <button
                          onClick={() => onOpenArchiveForChannel(row.channelKey)}
                          className="hover:text-[#C83A1B] hover:underline underline-offset-2"
                        >
                          {row.totalVideoSegments}
                        </button>
                      </td>

                      <td className="px-4 py-3 text-right font-mono tabular-nums text-[#141413] dark:text-stone-200 whitespace-nowrap">
                        {row.totalStorageGb.toFixed(2)} GB
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap">
                        <div
                          className={
                            row.uploadStatus === 'VERIFIED'
                              ? 'text-[#15803D] dark:text-emerald-400 font-medium'
                              : row.uploadStatus === 'FAILED'
                                ? 'text-[#B91C1C] dark:text-red-400 font-medium'
                                : row.uploadStatus === 'UPLOADING'
                                  ? 'text-[#A16207] dark:text-amber-400 font-medium'
                                  : 'text-[#8A847C]'
                          }
                        >
                          {row.uploadStatus === 'VERIFIED'
                            ? 'Verified'
                            : row.uploadStatus === 'FAILED'
                              ? `Failed (${row.failedUploads})`
                              : row.uploadStatus === 'UPLOADING'
                                ? 'Uploading'
                                : 'Idle'}
                        </div>
                        <div className="text-[10px] font-mono tabular-nums text-[#8A847C]">
                          {row.lastSuccessfulUploadAt
                            ? formatDateTime(row.lastSuccessfulUploadAt)
                            : 'No uploads yet'}
                        </div>
                      </td>

                      <td className="px-4 py-3 text-right font-mono tabular-nums whitespace-nowrap">
                        <span className={row.interruptionsCount > 0 ? 'text-[#B91C1C] font-semibold' : 'text-[#78716C]'}>
                          {row.interruptionsCount}
                        </span>
                      </td>

                      <td className="sticky right-0 bg-white dark:bg-stone-900 border-l border-[#EFECE6] dark:border-stone-800 px-4 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {row.status === 'RECORDING' || row.status === 'RECONNECTING' ? (
                            <>
                              <button
                                onClick={() => handleAction(row.channelKey, 'stop')}
                                disabled={isBusy}
                                className="inline-flex items-center gap-1 rounded-[3px] border border-[#FCA5A5] bg-[#FEF2F2] dark:bg-red-950/50 px-2 py-1 text-[11px] font-medium text-[#B91C1C] dark:text-red-300 hover:bg-[#FEE2E2] disabled:opacity-50"
                                title="Stop Recording"
                              >
                                <Square className="h-3 w-3 fill-current" />
                                Stop
                              </button>
                              <button
                                onClick={() => handleAction(row.channelKey, 'restart')}
                                disabled={isBusy}
                                className="inline-flex items-center gap-1 rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-800 px-2 py-1 text-[11px] text-[#57534E] dark:text-stone-200 hover:bg-[#F4F2ED] disabled:opacity-50"
                                title="Restart Recording"
                              >
                                <RotateCw className="h-3 w-3" />
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => handleAction(row.channelKey, 'start')}
                              disabled={isBusy || !row.source || row.source.recordingPermission !== 'AUTHORIZED'}
                              className="inline-flex items-center gap-1 rounded-[3px] bg-[#141413] dark:bg-stone-100 px-2.5 py-1 text-[11px] font-medium text-white dark:text-stone-900 hover:bg-[#2A2927] disabled:opacity-35"
                              title={
                                !row.source
                                  ? 'Configure an authorized stream source first'
                                  : row.source.recordingPermission !== 'AUTHORIZED'
                                    ? 'Recording not authorized for this source'
                                    : 'Start 24/7 Cloud Recording'
                              }
                            >
                              <Play className="h-3 w-3 fill-current" />
                              Record
                            </button>
                          )}

                          {row.source && (
                            <button
                              onClick={() => handleProbeSource(row.source!.id)}
                              disabled={busyKey === `probe:${row.source.id}`}
                              className="rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-800 p-1.5 text-[#57534E] dark:text-stone-300 hover:bg-[#F4F2ED]"
                              title="Test Stream Reachability (ffprobe)"
                            >
                              <Radio className="h-3.5 w-3.5" />
                            </button>
                          )}

                          <button
                            onClick={() => openSourceModal(row)}
                            className="rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-800 p-1.5 text-[#57534E] dark:text-stone-300 hover:bg-[#F4F2ED]"
                            title="Configure Authorized Recording Source"
                          >
                            <Settings2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Configure Recording Source Modal */}
      {editingChannel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#141413]/50 p-4">
          <div className="w-full max-w-lg rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-900 overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#E5E2DC] dark:border-stone-800 px-5 py-4 bg-[#FCFBF9] dark:bg-stone-950">
              <div>
                <h3 className="font-display text-sm font-semibold text-[#141413] dark:text-stone-100">
                  Recording Source · {editingChannel.channelName}
                </h3>
                <p className="text-[11px] text-[#78716C] dark:text-stone-400">
                  Stream URLs are encrypted server-side with AES-256-GCM and never returned unmasked to Chrome.
                </p>
              </div>
              <button
                onClick={() => setEditingChannel(null)}
                className="rounded-[3px] p-1 text-[#78716C] hover:bg-[#EAE7E0]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveSource} className="p-5 space-y-4 text-xs">
              {editingChannel.source && (
                <div className="rounded-[3px] border border-[#E5E2DC] dark:border-stone-800 bg-[#F8F7F4] dark:bg-stone-950 px-3 py-2 text-[11px] text-[#57534E] dark:text-stone-400">
                  Current redacted URL:{' '}
                  <span className="font-mono text-[#141413] dark:text-stone-200">
                    {editingChannel.source.streamUrlRedacted}
                  </span>
                </div>
              )}

              <div>
                <label className="block font-medium text-[#57534E] dark:text-stone-300 mb-1">
                  Authorized Stream URL (HLS .m3u8 / RTSP / HTTP-TS) <span className="text-[#C83A1B]">*</span>
                </label>
                <input
                  type="url"
                  value={srcUrl}
                  onChange={(e) => setSrcUrl(e.target.value)}
                  placeholder="https://authorized-broadcaster.example.com/live/stream.m3u8"
                  required
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2 font-mono text-xs text-[#141413] dark:text-stone-100"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-[#57534E] dark:text-stone-300 mb-1">Source Type</label>
                  <select
                    value={srcType}
                    onChange={(e) => setSrcType(e.target.value)}
                    className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2 text-[#141413] dark:text-stone-100"
                  >
                    <option value="HLS_M3U8">Authorized HLS (.m3u8)</option>
                    <option value="RTSP">Broadcast RTSP Feed</option>
                    <option value="MPEG_TS">HTTP MPEG-TS</option>
                    <option value="LICENSED_IPTV">Licensed IPTV Feed</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-[#57534E] dark:text-stone-300 mb-1">
                    Recording Permission
                  </label>
                  <select
                    value={srcPermission}
                    onChange={(e) => setSrcPermission(e.target.value)}
                    className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2 text-[#141413] dark:text-stone-100"
                  >
                    <option value="AUTHORIZED">Authorized for 24/7 Recording</option>
                    <option value="PLAYBACK_ONLY">Playback Only (No Recording)</option>
                    <option value="RESTRICTED">Restricted</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-[#57534E] dark:text-stone-300 mb-1">
                    Segment Length
                  </label>
                  <select
                    value={srcSegmentSec}
                    onChange={(e) => setSrcSegmentSec(Number(e.target.value))}
                    className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2 font-mono text-[#141413] dark:text-stone-100"
                  >
                    <option value={3600}>3600s (1 hour — recommended)</option>
                    <option value={1800}>1800s (30 minutes)</option>
                    <option value={600}>600s (10 minutes)</option>
                    <option value={60}>60s (1 minute — testing)</option>
                  </select>
                </div>

                <div className="flex items-end pb-2">
                  <label className="inline-flex items-center gap-2 text-[#141413] dark:text-stone-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={srcAuto247}
                      onChange={(e) => setSrcAuto247(e.target.checked)}
                      className="accent-[#C83A1B]"
                    />
                    Auto-recover 24/7 on server restart
                  </label>
                </div>
              </div>

              <div>
                <label className="block font-medium text-[#57534E] dark:text-stone-300 mb-1">
                  Authorized Historical Catch-up Endpoint <span className="text-[#8A847C] font-normal">(Optional)</span>
                </label>
                <input
                  type="url"
                  value={srcHistEndpoint}
                  onChange={(e) => setSrcHistEndpoint(e.target.value)}
                  placeholder="https://archive.broadcaster.example.com/catchup/{date}"
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2 font-mono text-xs text-[#141413] dark:text-stone-100"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-[#EFECE6] dark:border-stone-800">
                <button
                  type="button"
                  onClick={() => setEditingChannel(null)}
                  className="rounded-[3px] border border-[#D4CFC5] dark:border-stone-700 bg-white dark:bg-stone-800 px-3.5 py-1.5 font-medium text-[#57534E] dark:text-stone-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingSource}
                  className="rounded-[3px] bg-[#C83A1B] px-4 py-1.5 font-medium text-white hover:bg-[#A82E13] disabled:opacity-50"
                >
                  {savingSource ? 'Encrypting & Saving…' : 'Save Source'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
