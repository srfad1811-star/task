import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  HardDrive,
  Lock,
  PlugZap,
  RefreshCw,
  RotateCw,
  Save,
} from 'lucide-react';
import { getAuthHeaders } from '../lib/apiAuth.ts';
import { formatBytes, formatDateTime } from '../lib/formatters.ts';

interface StorageManagementViewProps {
  refreshKey: number;
}

type ProviderType = 'cloudflare_r2' | 'aws_s3' | 'backblaze_b2' | 'minio' | 'custom_s3';

interface PublicStorageConfig {
  provider: ProviderType;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyIdMasked: string;
  hasSecretKey: boolean;
  isConfigured: boolean;
  configuredViaEnv: boolean;
  publicBaseUrl: string;
  retentionDays: number;
  storageBudgetGb: number;
  warningThresholdPct: number;
  costPerGbMonthUsd: number;
  defaultSegmentSeconds: number;
  deleteLocalAfterVerifiedUpload: boolean;
  signedUrlExpirySeconds: number;
}

interface StorageAnalyticsPayload {
  config: PublicStorageConfig;
  totalBytes: number;
  totalGb: number;
  cloudUploadedBytes: number;
  localStagedBytes: number;
  totalSegments: number;
  totalHours: number;
  dailyUploadBytes: number;
  dailySegments: number;
  monthlyUploadBytes: number;
  monthlySegments: number;
  estimatedMonthlyCostUsd: number;
  budgetGb: number;
  availableBudgetGb: number;
  usagePct: number;
  retentionDays: number;
  uploadQueue: {
    queued: number;
    uploading: number;
    verified: number;
    failed: number;
  };
  warnings: Array<{ level: 'WARN' | 'CRITICAL'; message: string }>;
  perChannel: Array<{
    channelKey: string;
    channelName: string;
    totalBytes: number;
    totalGb: number;
    segmentCount: number;
    totalHours: number;
    estimatedMonthlyCostUsd: number;
    lastArchivedAt: string | null;
  }>;
}

export function StorageManagementView({ refreshKey }: StorageManagementViewProps) {
  const [analytics, setAnalytics] = useState<StorageAnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  // Form state (credentials are write-only; secret keys never returned from server)
  const [provider, setProvider] = useState<ProviderType>('cloudflare_r2');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('auto');
  const [bucket, setBucket] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [retentionDays, setRetentionDays] = useState(30);
  const [storageBudgetGb, setStorageBudgetGb] = useState(500);
  const [warningThresholdPct, setWarningThresholdPct] = useState(80);
  const [costPerGbMonthUsd, setCostPerGbMonthUsd] = useState(0.015);
  const [defaultSegmentSeconds, setDefaultSegmentSeconds] = useState(3600);
  const [signedUrlExpirySeconds, setSignedUrlExpirySeconds] = useState(3600);
  const [deleteLocalAfterVerifiedUpload, setDeleteLocalAfterVerifiedUpload] = useState(false);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/storage/analytics');
      const data = (await res.json()) as StorageAnalyticsPayload;
      setAnalytics(data);

      const c = data.config;
      setProvider(c.provider);
      setEndpoint(c.endpoint);
      setRegion(c.region);
      setBucket(c.bucket);
      setPublicBaseUrl(c.publicBaseUrl);
      setRetentionDays(c.retentionDays);
      setStorageBudgetGb(c.storageBudgetGb);
      setWarningThresholdPct(c.warningThresholdPct);
      setCostPerGbMonthUsd(c.costPerGbMonthUsd);
      setDefaultSegmentSeconds(c.defaultSegmentSeconds);
      setSignedUrlExpirySeconds(c.signedUrlExpirySeconds);
      setDeleteLocalAfterVerifiedUpload(c.deleteLocalAfterVerifiedUpload);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAnalytics();
  }, [refreshKey, loadAnalytics]);

  async function handleSaveConfig(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/storage/config', {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          provider,
          endpoint,
          region,
          bucket,
          accessKeyId: accessKeyId.trim() || undefined,
          secretAccessKey: secretAccessKey.trim() || undefined,
          publicBaseUrl,
          retentionDays,
          storageBudgetGb,
          warningThresholdPct,
          costPerGbMonthUsd,
          defaultSegmentSeconds,
          signedUrlExpirySeconds,
          deleteLocalAfterVerifiedUpload,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save cloud storage configuration.');
      setAccessKeyId('');
      setSecretAccessKey('');
      setFeedback({
        ok: true,
        text: 'Cloud storage configuration encrypted (AES-256-GCM) and saved on server.',
      });
      await loadAnalytics();
    } catch (err) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Save failed.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/storage/test', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Connection test failed.');
      setFeedback({
        ok: Boolean(data.ok),
        text: `${data.message} (${data.latencyMs} ms)`,
      });
    } catch (err) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Connection test error.',
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleRetryUploads() {
    setRetrying(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/storage/retry-uploads', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Retry failed.');
      setFeedback({
        ok: data.failed === 0,
        text: `Retried ${data.attempted ?? 0} segment(s): ${data.succeeded ?? 0} verified in cloud storage, ${data.failed ?? 0} failed.`,
      });
      await loadAnalytics();
    } catch (err) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Retry failed.',
      });
    } finally {
      setRetrying(false);
    }
  }

  if (loading && !analytics) {
    return (
      <div className="space-y-4">
        <div className="h-28 rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] animate-pulse" />
        <div className="h-64 rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] animate-pulse" />
      </div>
    );
  }

  const a = analytics;
  const usagePct = Math.min(100, a?.usagePct ?? 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] text-[#141413] dark:text-[#F4F2ED]">
            Cloud Storage & Cost Management
          </h2>
          <p className="mt-1 text-[13px] text-[#57534E] dark:text-[#A8A29E]">
            S3-compatible object storage (Cloudflare R2, Amazon S3, Backblaze B2, MinIO), upload verification queue, retention policy, and monthly cost controls.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRetryUploads}
            disabled={retrying}
            className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#1B1B1A] px-3.5 py-2 text-xs font-medium text-[#141413] dark:text-[#F4F2ED] hover:bg-[#F4F2ED] dark:hover:bg-[#242422] disabled:opacity-50 transition-colors"
          >
            <RotateCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />
            Retry Failed Uploads ({a?.uploadQueue.failed ?? 0})
          </button>
          <button
            onClick={loadAnalytics}
            className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#1B1B1A] px-3 py-2 text-xs font-medium text-[#57534E] dark:text-[#A8A29E] hover:text-[#141413] dark:hover:text-[#F4F2ED] transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Warnings & Policy Banner */}
      {a && a.warnings.length > 0 && (
        <div className="space-y-2">
          {a.warnings.map((w, idx) => (
            <div
              key={idx}
              className={`rounded-[3px] border px-4 py-3 flex items-start gap-2.5 text-xs ${
                w.level === 'CRITICAL'
                  ? 'border-[#FECACA] dark:border-[#7F1D1D] bg-[#FEF2F2] dark:bg-[#2A1515] text-[#B91C1C] dark:text-[#FCA5A5]'
                  : 'border-[#FDE68A] dark:border-[#78350F] bg-[#FFFBEB] dark:bg-[#261E10] text-[#92400E] dark:text-[#FCD34D]'
              }`}
            >
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      {feedback && (
        <div
          className={`rounded-[3px] border px-4 py-3 flex items-center gap-2 text-xs ${
            feedback.ok
              ? 'border-[#BBF7D0] dark:border-[#14532D] bg-[#F0FDF4] dark:bg-[#112318] text-[#15803D] dark:text-[#86EFAC]'
              : 'border-[#FECACA] dark:border-[#7F1D1D] bg-[#FEF2F2] dark:bg-[#2A1515] text-[#B91C1C] dark:text-[#FCA5A5]'
          }`}
        >
          {feedback.ok ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Primary Storage Ledger Strip */}
      {a && (
        <section className="rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A]">
          <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-[#E5E2DC] dark:divide-[#2C2C2A]">
            <div className="p-5">
              <div className="text-xs text-[#78716C] dark:text-[#A8A29E]">Total Archive Storage</div>
              <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-[#141413] dark:text-[#F4F2ED]">
                {a.totalGb.toFixed(2)} GB
              </div>
              <div className="mt-1.5 text-xs text-[#78716C] dark:text-[#A8A29E] font-mono tabular-nums">
                {a.availableBudgetGb.toFixed(1)} GB free of {a.budgetGb} GB cap
              </div>
            </div>

            <div className="p-5">
              <div className="text-xs text-[#78716C] dark:text-[#A8A29E]">Estimated Monthly Cost</div>
              <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-[#141413] dark:text-[#F4F2ED]">
                ${a.estimatedMonthlyCostUsd.toFixed(2)}
              </div>
              <div className="mt-1.5 text-xs text-[#78716C] dark:text-[#A8A29E] font-mono tabular-nums">
                @ ${a.config.costPerGbMonthUsd.toFixed(4)}/GB · {a.retentionDays}d retention
              </div>
            </div>

            <div className="p-5">
              <div className="text-xs text-[#78716C] dark:text-[#A8A29E]">Uploaded Video Hours</div>
              <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-[#141413] dark:text-[#F4F2ED]">
                {a.totalHours.toFixed(1)} h
              </div>
              <div className="mt-1.5 text-xs text-[#78716C] dark:text-[#A8A29E] font-mono tabular-nums">
                {a.totalSegments.toLocaleString()} verified segments
              </div>
            </div>

            <div className="p-5">
              <div className="text-xs text-[#78716C] dark:text-[#A8A29E]">Upload Volume (Day / Month)</div>
              <div className="mt-2 font-mono text-xl font-semibold tabular-nums text-[#141413] dark:text-[#F4F2ED]">
                {formatBytes(a.dailyUploadBytes)}
                <span className="text-[#8A847C] text-sm"> / </span>
                {formatBytes(a.monthlyUploadBytes)}
              </div>
              <div className="mt-1.5 text-xs text-[#78716C] dark:text-[#A8A29E] font-mono tabular-nums">
                Queue: {a.uploadQueue.verified} verified · {a.uploadQueue.uploading} uploading ·{' '}
                <span className={a.uploadQueue.failed > 0 ? 'text-[#B91C1C] font-semibold' : ''}>
                  {a.uploadQueue.failed} failed
                </span>
              </div>
            </div>
          </div>

          {/* Budget Progress Rule */}
          <div className="border-t border-[#E5E2DC] dark:border-[#2C2C2A] bg-[#FCFBF9] dark:bg-[#161614] px-5 py-3.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium text-[#141413] dark:text-[#F4F2ED] inline-flex items-center gap-1.5">
                <HardDrive className="h-3.5 w-3.5 text-[#C83A1B]" />
                Storage Budget Utilization ({a.usagePct.toFixed(1)}%)
              </span>
              <span className="font-mono text-[11px] text-[#78716C] dark:text-[#A8A29E]">
                Cloud Verified: {formatBytes(a.cloudUploadedBytes)} · Local Staging: {formatBytes(a.localStagedBytes)} · Zero silent deletions
              </span>
            </div>
            <div className="h-2 w-full rounded-[2px] bg-[#EAE7E0] dark:bg-[#2A2A27] overflow-hidden">
              <div
                className={`h-full transition-all ${
                  a.usagePct >= 100
                    ? 'bg-[#B91C1C]'
                    : a.usagePct >= a.config.warningThresholdPct
                      ? 'bg-[#D97706]'
                      : 'bg-[#15803D]'
                }`}
                style={{ width: `${usagePct}%` }}
              />
            </div>
          </div>
        </section>
      )}

      {/* Two-Column: S3/R2 Config Form & Per-Channel Consumption Table */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* S3 / Cloudflare R2 Provider Configuration */}
        <form
          onSubmit={handleSaveConfig}
          className="xl:col-span-6 rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] overflow-hidden"
        >
          <div className="border-b border-[#E5E2DC] dark:border-[#2C2C2A] px-5 py-3.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Cloud className="h-4 w-4 text-[#C83A1B]" />
              <h3 className="font-display text-sm font-semibold text-[#141413] dark:text-[#F4F2ED]">
                S3-Compatible Object Storage Provider
              </h3>
            </div>
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[#15803D] dark:text-[#86EFAC]">
              <Lock className="h-3 w-3" />
              AES-256-GCM Server-Side
            </span>
          </div>

          <div className="p-5 space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block font-medium text-[#57534E] dark:text-[#A8A29E] mb-1">
                  Storage Provider
                </label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as ProviderType)}
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-3 py-2 text-xs text-[#141413] dark:text-[#F4F2ED]"
                >
                  <option value="cloudflare_r2">Cloudflare R2 (Zero Egress)</option>
                  <option value="aws_s3">Amazon S3</option>
                  <option value="backblaze_b2">Backblaze B2 (S3 API)</option>
                  <option value="minio">MinIO Self-Hosted</option>
                  <option value="custom_s3">Custom S3-Compatible</option>
                </select>
              </div>

              <div>
                <label className="block font-medium text-[#57534E] dark:text-[#A8A29E] mb-1">
                  Region
                </label>
                <input
                  type="text"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="auto (R2) or us-east-1 (S3)"
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-3 py-2 font-mono text-xs text-[#141413] dark:text-[#F4F2ED]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block font-medium text-[#57534E] dark:text-[#A8A29E] mb-1">
                  S3 API Endpoint URL
                </label>
                <input
                  type="text"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://<account-id>.r2.cloudflarestorage.com"
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-3 py-2 font-mono text-xs text-[#141413] dark:text-[#F4F2ED]"
                />
              </div>

              <div>
                <label className="block font-medium text-[#57534E] dark:text-[#A8A29E] mb-1">
                  Bucket Name
                </label>
                <input
                  type="text"
                  value={bucket}
                  onChange={(e) => setBucket(e.target.value)}
                  placeholder="tv-channel-recordings"
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-3 py-2 font-mono text-xs text-[#141413] dark:text-[#F4F2ED]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block font-medium text-[#57534E] dark:text-[#A8A29E] mb-1">
                  Access Key ID{' '}
                  {a?.config.accessKeyIdMasked && (
                    <span className="font-mono text-[10px] text-[#15803D]">
                      (saved: {a.config.accessKeyIdMasked})
                    </span>
                  )}
                </label>
                <input
                  type="text"
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                  placeholder="Leave blank to keep existing key"
                  autoComplete="off"
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-3 py-2 font-mono text-xs text-[#141413] dark:text-[#F4F2ED]"
                />
              </div>

              <div>
                <label className="block font-medium text-[#57534E] dark:text-[#A8A29E] mb-1">
                  Secret Access Key{' '}
                  {a?.config.hasSecretKey && (
                    <span className="font-mono text-[10px] text-[#15803D]">(encrypted on server)</span>
                  )}
                </label>
                <input
                  type="password"
                  value={secretAccessKey}
                  onChange={(e) => setSecretAccessKey(e.target.value)}
                  placeholder="Write-only — never sent to browser"
                  autoComplete="new-password"
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-3 py-2 font-mono text-xs text-[#141413] dark:text-[#F4F2ED]"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-[#EFECE6] dark:border-[#262624]">
              <div>
                <label className="block font-medium text-[#57534E] dark:text-[#A8A29E] mb-1">
                  Budget (GB)
                </label>
                <input
                  type="number"
                  min={1}
                  value={storageBudgetGb}
                  onChange={(e) => setStorageBudgetGb(Number(e.target.value))}
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-2.5 py-1.5 font-mono text-xs text-[#141413] dark:text-[#F4F2ED]"
                />
              </div>
              <div>
                <label className="block font-medium text-[#57534E] dark:text-[#A8A29E] mb-1">
                  Warn At (%)
                </label>
                <input
                  type="number"
                  min={10}
                  max={99}
                  value={warningThresholdPct}
                  onChange={(e) => setWarningThresholdPct(Number(e.target.value))}
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-2.5 py-1.5 font-mono text-xs text-[#141413] dark:text-[#F4F2ED]"
                />
              </div>
              <div>
                <label className="block font-medium text-[#57534E] dark:text-[#A8A29E] mb-1">
                  Retention (Days)
                </label>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(Number(e.target.value))}
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-2.5 py-1.5 font-mono text-xs text-[#141413] dark:text-[#F4F2ED]"
                />
              </div>
              <div>
                <label className="block font-medium text-[#57534E] dark:text-[#A8A29E] mb-1">
                  Cost ($/GB/mo)
                </label>
                <input
                  type="number"
                  step={0.001}
                  min={0}
                  value={costPerGbMonthUsd}
                  onChange={(e) => setCostPerGbMonthUsd(Number(e.target.value))}
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-2.5 py-1.5 font-mono text-xs text-[#141413] dark:text-[#F4F2ED]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-[#57534E] dark:text-[#A8A29E] mb-1">
                  Default Segment Duration (sec)
                </label>
                <input
                  type="number"
                  min={60}
                  max={7200}
                  value={defaultSegmentSeconds}
                  onChange={(e) => setDefaultSegmentSeconds(Number(e.target.value))}
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-2.5 py-1.5 font-mono text-xs text-[#141413] dark:text-[#F4F2ED]"
                />
              </div>
              <div>
                <label className="block font-medium text-[#57534E] dark:text-[#A8A29E] mb-1">
                  Signed Playback URL Expiry (sec)
                </label>
                <input
                  type="number"
                  min={60}
                  max={86400}
                  value={signedUrlExpirySeconds}
                  onChange={(e) => setSignedUrlExpirySeconds(Number(e.target.value))}
                  className="w-full rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-2.5 py-1.5 font-mono text-xs text-[#141413] dark:text-[#F4F2ED]"
                />
              </div>
            </div>

            <label className="flex items-start gap-2 pt-1 cursor-pointer text-[#57534E] dark:text-[#A8A29E]">
              <input
                type="checkbox"
                checked={deleteLocalAfterVerifiedUpload}
                onChange={(e) => setDeleteLocalAfterVerifiedUpload(e.target.checked)}
                className="mt-0.5 rounded border-[#D4CFC5]"
              />
              <span>
                Remove temporary worker staging file only <strong>after</strong> S3/R2 HeadObject size verification passes. (Cloud archive recordings are never silently deleted.)
              </span>
            </label>

            <div className="pt-3 border-t border-[#EFECE6] dark:border-[#262624] flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testing}
                className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-3.5 py-2 text-xs font-medium text-[#141413] dark:text-[#F4F2ED] hover:bg-[#F4F2ED] dark:hover:bg-[#242422] disabled:opacity-50 transition-colors"
              >
                <PlugZap className="h-3.5 w-3.5 text-[#C83A1B]" />
                {testing ? 'Testing Bucket…' : 'Test S3/R2 Connection'}
              </button>

              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#C83A1B] px-4 py-2 text-xs font-medium text-white hover:bg-[#A82E13] disabled:opacity-50 transition-colors"
              >
                <Save className="h-3.5 w-3.5" />
                {saving ? 'Encrypting & Saving…' : 'Save Storage Configuration'}
              </button>
            </div>
          </div>
        </form>

        {/* Per-Channel Storage & Cost Breakdown */}
        <section className="xl:col-span-6 rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] overflow-hidden">
          <div className="border-b border-[#E5E2DC] dark:border-[#2C2C2A] px-5 py-3.5 flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold text-[#141413] dark:text-[#F4F2ED]">
              Storage Consumption by Channel
            </h3>
            <span className="font-mono text-xs text-[#78716C] dark:text-[#A8A29E]">
              {a?.perChannel.length ?? 0} channels
            </span>
          </div>

          <div className="max-h-[540px] overflow-y-auto overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 border-b border-[#E5E2DC] dark:border-[#2C2C2A] bg-[#FCFBF9] dark:bg-[#161614] text-[11px] font-medium text-[#78716C] dark:text-[#A8A29E]">
                <tr>
                  <th className="px-4 py-2.5">Channel</th>
                  <th className="px-4 py-2.5 text-right">Segments</th>
                  <th className="px-4 py-2.5 text-right">Hours</th>
                  <th className="px-4 py-2.5 text-right">Storage</th>
                  <th className="px-4 py-2.5 text-right">Est. $/Mo</th>
                  <th className="px-4 py-2.5 text-right">Last Archived</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFECE6] dark:divide-[#262624]">
                {(a?.perChannel ?? []).map((row) => (
                  <tr
                    key={row.channelKey}
                    className="hover:bg-[#F8F7F4] dark:hover:bg-[#222220] transition-colors"
                  >
                    <td className="px-4 py-2.5 font-medium text-[#141413] dark:text-[#F4F2ED] whitespace-nowrap">
                      {row.channelName}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#57534E] dark:text-[#A8A29E]">
                      {row.segmentCount}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#57534E] dark:text-[#A8A29E]">
                      {row.totalHours.toFixed(1)}h
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-medium text-[#141413] dark:text-[#F4F2ED]">
                      {formatBytes(row.totalBytes)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#57534E] dark:text-[#A8A29E]">
                      ${row.estimatedMonthlyCostUsd.toFixed(3)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[11px] text-[#78716C] dark:text-[#A8A29E] whitespace-nowrap">
                      {row.lastArchivedAt ? formatDateTime(row.lastArchivedAt) : '—'}
                    </td>
                  </tr>
                ))}
                {(a?.perChannel.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-xs text-[#78716C]">
                      No channels registered yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
