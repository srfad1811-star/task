import { useEffect, useState } from 'react';
import { CheckCircle2, PlayCircle, ShieldCheck } from 'lucide-react';
import type { ChannelSummary, QaRun, QaThresholds } from '../types.ts';
import { formatDateTime } from '../lib/formatters.ts';
import { getAuthHeaders } from '../lib/apiAuth.ts';

interface AutomaticQaViewProps {
  refreshKey: number;
  onQaCompleted: () => void;
  onNavigate: (tab: string) => void;
}

export function AutomaticQaView({ refreshKey, onQaCompleted, onNavigate }: AutomaticQaViewProps) {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [runs, setRuns] = useState<QaRun[]>([]);
  const [thresholds, setThresholds] = useState<QaThresholds | null>(null);
  const [selectedChannel, setSelectedChannel] = useState('ALL');
  const [selectedDate, setSelectedDate] = useState('');
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<{
    qaRunId: string;
    totalAnalyzed: number;
    redCount: number;
    yellowCount: number;
    greenCount: number;
    issuesCreated: number;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/channels', { headers: getAuthHeaders() }).then((r) => r.json()),
      fetch('/api/qa/runs', { headers: getAuthHeaders() }).then((r) => r.json()),
      fetch('/api/settings', { headers: getAuthHeaders() }).then((r) => r.json()),
    ]).then(([chData, runData, settingsData]) => {
      setChannels(chData ?? []);
      setRuns(runData ?? []);
      setThresholds(settingsData.qaThresholds ?? null);
    });
  }, [refreshKey]);

  const activeChannelObj = channels.find((c) => c.id === selectedChannel);

  async function handleRunQa() {
    setRunning(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/qa/run', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          channelKey: selectedChannel,
          transDate: selectedDate || undefined,
          thresholdsOverride: thresholds ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'QA execution failed');
      setLastResult(data);
      onQaCompleted();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'QA execution failed');
    } finally {
      setRunning(false);
    }
  }

  const ruleGroups = [
    {
      title: 'A. SPOT/TVC (Commercial Ad) Checking',
      rules: [
        'Missing sequence identifiers & ad-break continuity gaps',
        'Exact duplicate & consecutive back-to-back SPOT/TVC repeats',
        'Duration bounds & comparison against SourceDuration / customDuration / ds_tcommercial catalog',
        'Invalid SPOT/TVC category conflicts (Promo/SPN/Program/Song mismatch) & missing brand/category metadata',
        'CommercialID consistency across ds_tcommercial and aired entries',
        'Isolated placement inside continuous programs & low MatchCoverage checks',
      ],
    },
    {
      title: 'B. PROGRAM Checking',
      rules: [
        'Incorrect PROGRAM category (Commercial / TVC / Promo / SPN mismatch)',
        'Duplicate PROGRAM entries at overlapping or identical timestamps',
        'Invalid or suspiciously short PROGRAM durations (exempting songs & music segments)',
        'Overlapping PROGRAM time ranges on the same channel & date',
        'Suspicious PROGRAM fragmentation / sequence interruptions',
      ],
    },
    {
      title: 'C. MEDIA (Promo / Teaser / Trailer) Checking',
      rules: [
        'Wrong MEDIA category conflicts',
        'Exact and consecutive duplicate MEDIA promo records',
        'Unexpected mid-program MEDIA placement',
        'Invalid MEDIA duration bounds',
        'Missing sequence identifiers when sibling records include them',
      ],
    },
    {
      title: 'D. SPONSORSHIP (SPN) Checking',
      rules: [
        'Wrong SPONSORSHIP category conflicts',
        'Duplicate SPONSORSHIP records',
        'Incorrect SPONSORSHIP duration bounds',
        'Missing brand/commercial identity & suspicious placement',
      ],
    },
    {
      title: 'E. Timeline, Frame & Evidence Rules',
      rules: [
        'Start time vs End time order & midnight rollover handling',
        'Duration field consistency vs (EndTime - StartTime)',
        'Overlapping time ranges & unexplained timeline gaps',
        'Corroboration of timeline gaps against ds_trschedule_deleted records',
        'startFrame / endFrame & startIndex / endIndex / DiffInIndex integrity',
      ],
    },
  ];

  return (
    <div className="space-y-6">
      {/* Execution Control Card */}
      <div className="rounded border border-[#E5E2DC] bg-white p-6 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-[#141413]">
              Automatic Rule-Based QA Detection Engine
            </h2>
            <p className="mt-1 text-xs text-[#57534E] max-w-2xl leading-relaxed">
              Analyzes imported channel records chronologically. Confirmed structural conflicts (overlaps, negative/impossible durations, ID conflicts, deleted-record gap matches) are classified{' '}
              <strong className="text-[#B91C1C]">RED</strong>. Timeline gaps or anomalies lacking a reference schedule/video are conservatively classified{' '}
              <strong className="text-[#B45309]">YELLOW</strong> for manual review. Entries passing all checks are marked{' '}
              <strong className="text-[#15803D]">GREEN</strong>.
            </p>
          </div>
          <button
            onClick={handleRunQa}
            disabled={running || channels.length === 0}
            className="inline-flex items-center gap-2 rounded bg-[#141413] px-5 py-2.5 text-xs font-medium text-white hover:bg-[#2A2927] disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <PlayCircle className="h-4 w-4" />
            {running ? 'Analyzing Channels…' : 'Execute QA Scan'}
          </button>
        </div>

        {/* Scope & Quick Thresholds */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 border-t border-[#E5E2DC] pt-4">
          <div>
            <label className="block text-[11px] font-medium text-[#57534E] mb-1">Target Channel Scope</label>
            <select
              value={selectedChannel}
              onChange={(e) => {
                setSelectedChannel(e.target.value);
                setSelectedDate('');
              }}
              className="w-full rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs text-[#141413]"
            >
              <option value="ALL">All Imported Channels</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.channel_name} ({c.entry_count})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-[#57534E] mb-1">Target Date</label>
            <select
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              disabled={selectedChannel === 'ALL'}
              className="w-full rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs font-mono text-[#141413] disabled:bg-[#F4F2ED]"
            >
              <option value="">All Dates</option>
              {(activeChannelObj?.dates ?? []).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          {thresholds && (
            <>
              <div>
                <label className="block text-[11px] font-medium text-[#57534E] mb-1">
                  Gap Threshold (sec)
                </label>
                <input
                  type="number"
                  min={1}
                  value={thresholds.gapThresholdSeconds}
                  onChange={(e) =>
                    setThresholds({ ...thresholds, gapThresholdSeconds: Number(e.target.value) || 5 })
                  }
                  className="w-full rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs font-mono text-[#141413]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#57534E] mb-1">
                  Duration Tolerance (sec)
                </label>
                <input
                  type="number"
                  step="0.5"
                  min={0.5}
                  value={thresholds.durationToleranceStrictSeconds}
                  onChange={(e) =>
                    setThresholds({
                      ...thresholds,
                      durationToleranceStrictSeconds: Number(e.target.value) || 5,
                    })
                  }
                  className="w-full rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs font-mono text-[#141413]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#57534E] mb-1">
                  Overlap Tolerance (sec)
                </label>
                <input
                  type="number"
                  step="0.5"
                  min={0}
                  value={thresholds.overlapToleranceSeconds}
                  onChange={(e) =>
                    setThresholds({
                      ...thresholds,
                      overlapToleranceSeconds: Number(e.target.value) || 1.5,
                    })
                  }
                  className="w-full rounded border border-[#D4CFC5] bg-white px-2.5 py-1.5 text-xs font-mono text-[#141413]"
                />
              </div>
            </>
          )}
        </div>

        {errorMsg && (
          <div className="rounded border border-[#FECACA] bg-[#FEF2F2] px-4 py-2.5 text-xs text-[#B91C1C]">
            {errorMsg}
          </div>
        )}

        {lastResult && (
          <div className="rounded border border-[#BBF7D0] bg-[#F0FDF4] p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-[#14532D] font-mono tabular-nums">
              <CheckCircle2 className="h-4 w-4 text-[#15803D]" />
              <span>
                Scan complete: <strong>{lastResult.totalAnalyzed}</strong> entries ·{' '}
                <strong className="text-[#B91C1C]">{lastResult.redCount} RED</strong> ·{' '}
                <strong className="text-[#B45309]">{lastResult.yellowCount} YELLOW</strong> ·{' '}
                <strong className="text-[#15803D]">{lastResult.greenCount} GREEN</strong> ({lastResult.issuesCreated}{' '}
                findings logged)
              </span>
            </div>
            <button
              onClick={() => onNavigate('qa-results')}
              className="rounded bg-[#141413] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#2A2927]"
            >
              Inspect QA Results
            </button>
          </div>
        )}
      </div>

      {/* Rule Engine Specification Matrix */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {ruleGroups.map((grp) => (
          <div key={grp.title} className="rounded border border-[#E5E2DC] bg-white p-5 space-y-2.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#141413]">
              <ShieldCheck className="h-4 w-4 text-[#141413]" />
              <span>{grp.title}</span>
            </div>
            <ul className="space-y-1.5 text-xs text-[#57534E] list-disc pl-4">
              {grp.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Previous QA Run History */}
      <div className="rounded border border-[#E5E2DC] bg-white overflow-hidden">
        <div className="border-b border-[#E5E2DC] px-5 py-3.5">
          <h3 className="text-sm font-semibold text-[#141413]">QA Execution History</h3>
        </div>
        {runs.length === 0 ? (
          <div className="p-8 text-center text-xs text-[#78716C]">No QA runs executed yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#E5E2DC] bg-[#FCFBF9] text-[11px] font-semibold text-[#57534E]">
                <tr>
                  <th className="px-4 py-2.5">Completed At</th>
                  <th className="px-4 py-2.5">Scope</th>
                  <th className="px-4 py-2.5 text-right">Analyzed</th>
                  <th className="px-4 py-2.5 text-right">RED Errors</th>
                  <th className="px-4 py-2.5 text-right">YELLOW Suspicious</th>
                  <th className="px-4 py-2.5 text-right">GREEN Clean</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E2DC]">
                {runs.map((r) => (
                  <tr key={r.id} className="hover:bg-[#FCFBF9]">
                    <td className="px-4 py-2.5 font-mono tabular-nums text-[#141413]">
                      {formatDateTime(r.completed_at)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[#57534E]">{r.scope}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-medium">
                      {r.total_analyzed}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-[#B91C1C]">
                      {r.red_count}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-[#B45309]">
                      {r.yellow_count}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-[#15803D]">
                      {r.green_count}
                    </td>
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
