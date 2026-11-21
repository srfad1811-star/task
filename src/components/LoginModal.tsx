import { useState } from 'react';
import { Eye, EyeOff, KeyRound, LockOpen } from 'lucide-react';
import type { OperatorSession } from '../lib/apiAuth.ts';

interface LoginModalProps {
  onLoginSuccess: (user: OperatorSession) => void;
}

async function parseJsonSafely(res: Response): Promise<Record<string, any>> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 140);
    throw new Error(
      res.ok
        ? 'Received unexpected non-JSON response from API server.'
        : `API error (${res.status}): ${snippet || res.statusText || 'Request failed'}`
    );
  }
}

export function LoginModal({ onLoginSuccess }: LoginModalProps) {
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleUnlockSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Please enter your access code.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });
      const data = await parseJsonSafely(res);
      if (!res.ok) {
        throw new Error(String(data.error || 'Invalid access code.'));
      }
      onLoginSuccess({
        ...(data.user as OperatorSession),
        sessionToken: String(data.sessionToken),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to unlock workspace');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F8F9FA] p-4">
      <div className="w-full max-w-sm rounded-[4px] border border-[#E5E7EB] bg-white p-7 text-[#111827] shadow-sm space-y-5">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-white bg-[#DC2626] px-2 py-0.5 rounded font-bold tracking-wider uppercase">
              LIVE QA
            </span>
            <span className="font-display text-sm font-bold tracking-tight text-[#DC2626]">
              TV-TASKVERIFY
            </span>
          </div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-[#111827]">
            Enter Access Code
          </h1>
          <p className="text-xs text-[#6B7280]">
            Enter the station access code to unlock the QA workspace.
          </p>
        </div>

        {error && (
          <div className="rounded-[4px] border border-[#FCA5A5] bg-[#FEF2F2] px-3.5 py-2.5 text-xs text-[#B91C1C]">
            {error}
          </div>
        )}

        <form onSubmit={handleUnlockSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[#374151] mb-1.5">
              Access Code
            </label>
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
              <input
                type={showCode ? 'text' : 'password'}
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Enter access code"
                autoComplete="one-time-code"
                autoFocus
                className="w-full rounded-[4px] border border-[#D1D5DB] bg-white pl-9 pr-9 py-2.5 text-sm font-mono tracking-widest text-[#111827] focus:border-[#DC2626] focus:outline-none"
                required
              />
              <button
                type="button"
                onClick={() => setShowCode((s) => !s)}
                aria-label={showCode ? 'Hide access code' : 'Show access code'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6B7280] hover:text-[#111827]"
              >
                {showCode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full inline-flex items-center justify-center gap-2 rounded-[4px] bg-[#DC2626] py-2.5 text-xs font-semibold text-white hover:bg-[#B91C1C] transition-colors disabled:opacity-50"
          >
            <LockOpen className="h-3.5 w-3.5" />
            {loading ? 'Verifying…' : 'Unlock Workspace'}
          </button>
        </form>
      </div>
    </div>
  );
}
