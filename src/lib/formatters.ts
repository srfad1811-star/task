import type { EntryQaStatus, EntryType, QaSeverity } from '../types.ts';

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.abs(seconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const sStr = s % 1 === 0 ? String(s).padStart(2, '0') : s.toFixed(1).padStart(4, '0');
  if (h > 0) {
    return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sStr}`;
  }
  return `${sign}${String(m).padStart(2, '0')}:${sStr} (${seconds.toFixed(1)}s)`;
}

export function formatSecondsClock(seconds: number): string {
  const s = ((seconds % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function getEntryTypeStyle(type: EntryType | string): {
  label: string;
  bg: string;
  text: string;
  border: string;
  barBg: string;
  barBorder: string;
} {
  const norm = String(type || '').toUpperCase();
  switch (norm) {
    case 'PROGRAM':
      return {
        label: 'PROGRAM',
        bg: 'bg-slate-100',
        text: 'text-slate-800',
        border: 'border-slate-300',
        barBg: '#1e293b',
        barBorder: '#0f172a',
      };
    case 'SPOT/TVC':
    case 'ADVERTISEMENT':
      return {
        label: 'SPOT/TVC',
        bg: 'bg-red-50',
        text: 'text-red-700',
        border: 'border-red-200',
        barBg: '#dc2626',
        barBorder: '#b91c1c',
      };
    case 'MEDIA':
    case 'PROMO':
      return {
        label: 'MEDIA',
        bg: 'bg-rose-50',
        text: 'text-rose-700',
        border: 'border-rose-200',
        barBg: '#f43f5e',
        barBorder: '#e11d48',
      };
    case 'SPONSORSHIP':
    case 'SPN':
      return {
        label: 'SPONSORSHIP',
        bg: 'bg-amber-50',
        text: 'text-amber-800',
        border: 'border-amber-200',
        barBg: '#d97706',
        barBorder: '#b45309',
      };
    default:
      return {
        label: 'PROGRAM',
        bg: 'bg-slate-100',
        text: 'text-slate-800',
        border: 'border-slate-300',
        barBg: '#1e293b',
        barBorder: '#0f172a',
      };
  }
}

export function getQaStatusStyle(status: EntryQaStatus | QaSeverity): {
  label: string;
  classes: string;
} {
  switch (status) {
    case 'RED':
      return {
        label: 'Error',
        classes: 'text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-[4px] font-mono text-[11px] font-semibold inline-flex items-center gap-1',
      };
    case 'YELLOW':
      return {
        label: 'Review',
        classes: 'text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-[4px] font-mono text-[11px] font-semibold inline-flex items-center gap-1',
      };
    case 'GREEN':
      return {
        label: 'Verified',
        classes: 'text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-[4px] font-mono text-[11px] font-medium inline-flex items-center gap-1',
      };
    default:
      return {
        label: 'Pending',
        classes: 'text-gray-600 bg-gray-100 border border-gray-200 px-2 py-0.5 rounded-[4px] font-mono text-[11px] font-medium inline-flex items-center gap-1',
      };
  }
}
