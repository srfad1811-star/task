import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Clock,
  FastForward,
  Film,
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  Rewind,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { formatBytes, formatDateTime, formatSecondsClock } from '../lib/formatters.ts';

interface VideoPlayerViewProps {
  refreshKey: number;
  archiveId: string | null;
  initialSeekSeconds?: number | null;
  onSelectArchive: (archiveId: string, seekSeconds?: number | null) => void;
  onNavigate: (tab: string) => void;
}

interface ArchiveSegmentMeta {
  id: string;
  channel_key: string;
  channel_name: string;
  record_date: string;
  start_time_iso: string;
  end_time_iso: string;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  file_size_bytes: number;
  storage_provider: string;
  source_origin: string;
}

interface AdjacentSegment {
  id: string;
  start_time_iso: string;
  end_time_iso: string;
  start_seconds: number;
  end_seconds: number;
  record_date: string;
}

interface MatchedEntry {
  entry_id: string;
  offset_seconds: number;
  entry_type: string;
  caption_name: string | null;
  brand_name: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_seconds: number | null;
  qa_status: string;
}

interface PlaybackPayload {
  segment: ArchiveSegmentMeta;
  playbackUrl: string;
  expiresAt: string;
  storageProvider: string;
  prevSegment: AdjacentSegment | null;
  nextSegment: AdjacentSegment | null;
  matchedEntries: MatchedEntry[];
}

const SPEED_OPTIONS = [0.5, 1, 1.5, 2];

function formatDurationClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00:00';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function VideoPlayerView({
  refreshKey,
  archiveId,
  initialSeekSeconds,
  onSelectArchive,
  onNavigate,
}: VideoPlayerViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingSeekRef = useRef<number | null>(null);

  const [availableSegments, setAvailableSegments] = useState<ArchiveSegmentMeta[]>([]);
  const [segmentsLoading, setSegmentsLoading] = useState(true);
  const [payload, setPayload] = useState<PlaybackPayload | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Player controls state
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [autoContinue, setAutoContinue] = useState(true);

  // Load recent verified segments so the user can always pick one even if arriving directly
  useEffect(() => {
    let cancelled = false;
    setSegmentsLoading(true);
    fetch('/api/archive/tree')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const list = (data.segments ?? []) as ArchiveSegmentMeta[];
        setAvailableSegments(list);
        if (!archiveId && list.length > 0) {
          onSelectArchive(list[0].id, 0);
        }
      })
      .catch(() => {
        if (!cancelled) setAvailableSegments([]);
      })
      .finally(() => {
        if (!cancelled) setSegmentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const loadPlaybackUrl = useCallback(async (id: string, seekTarget?: number | null) => {
    setLoadingUrl(true);
    setErrorMsg(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    pendingSeekRef.current = seekTarget ?? null;

    try {
      const res = await fetch(`/api/archive/${encodeURIComponent(id)}/playback-url`);
      const data = await res.json();
      if (!res.ok) {
        setPayload(null);
        setErrorMsg(data.error || 'Video Not Available');
        return;
      }
      setPayload(data as PlaybackPayload);
    } catch (err) {
      setPayload(null);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to request signed playback URL.');
    } finally {
      setLoadingUrl(false);
    }
  }, []);

  useEffect(() => {
    if (!archiveId) {
      setPayload(null);
      return;
    }
    loadPlaybackUrl(archiveId, initialSeekSeconds ?? null);
  }, [archiveId, initialSeekSeconds, loadPlaybackUrl]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }

  function seekTo(seconds: number) {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(duration || payload?.segment.duration_seconds || 0, seconds));
    v.currentTime = clamped;
    setCurrentTime(clamped);
  }

  function jumpBy(deltaSeconds: number) {
    const v = videoRef.current;
    if (!v) return;
    seekTo(v.currentTime + deltaSeconds);
  }

  function changeSpeed(rate: number) {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
  }

  function toggleMute() {
    if (!videoRef.current) return;
    const next = !muted;
    videoRef.current.muted = next;
    setMuted(next);
  }

  function changeVolume(val: number) {
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      if (val > 0 && muted) {
        videoRef.current.muted = false;
        setMuted(false);
      }
    }
  }

  async function toggleFullscreen() {
    if (!containerRef.current) return;
    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Ignore fullscreen denial in restricted iframes
    }
  }

  function handleVideoLoadedMetadata() {
    const v = videoRef.current;
    if (!v) return;
    setDuration(Number.isFinite(v.duration) ? v.duration : payload?.segment.duration_seconds ?? 0);
    v.playbackRate = playbackRate;
    v.volume = volume;
    v.muted = muted;
    if (pendingSeekRef.current !== null && pendingSeekRef.current > 0) {
      v.currentTime = Math.min(pendingSeekRef.current, v.duration || pendingSeekRef.current);
      setCurrentTime(v.currentTime);
      pendingSeekRef.current = null;
    }
  }

  function handleVideoEnded() {
    setIsPlaying(false);
    if (autoContinue && payload?.nextSegment) {
      onSelectArchive(payload.nextSegment.id, 0);
    }
  }

  const broadcastWallClockSeconds = payload
    ? payload.segment.start_seconds + Math.floor(currentTime)
    : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] text-[#141413] dark:text-[#F4F2ED]">
            Cloud Broadcast Video Player
          </h2>
          <p className="mt-1 text-[13px] text-[#57534E] dark:text-[#A8A29E]">
            Plays verified cloud-archived recordings via time-limited signed URLs with automatic next-segment continuation and autosave timestamp jump markers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onNavigate('archive')}
            className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#1B1B1A] px-3 py-2 text-xs font-medium text-[#141413] dark:text-[#F4F2ED] hover:bg-[#F4F2ED] dark:hover:bg-[#242422] transition-colors"
          >
            <Film className="h-3.5 w-3.5" />
            Browse Archive Tree
          </button>
          {archiveId && (
            <button
              onClick={() => loadPlaybackUrl(archiveId, currentTime)}
              disabled={loadingUrl}
              className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#1B1B1A] px-3 py-2 text-xs font-medium text-[#57534E] dark:text-[#A8A29E] hover:text-[#141413] dark:hover:text-[#F4F2ED] transition-colors"
              title="Refresh time-limited signed URL"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingUrl ? 'animate-spin' : ''}`} />
              Refresh URL
            </button>
          )}
        </div>
      </div>

      {/* Segment Quick Selector */}
      {availableSegments.length > 0 && (
        <div className="rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-[#57534E] dark:text-[#A8A29E]">
            <Clock className="h-3.5 w-3.5 text-[#C83A1B]" />
            <span>Loaded Archive Segment:</span>
          </div>
          <select
            value={archiveId ?? ''}
            onChange={(e) => {
              if (e.target.value) onSelectArchive(e.target.value, 0);
            }}
            className="flex-1 max-w-2xl rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-[#FCFBF9] dark:bg-[#141413] px-3 py-1.5 text-xs font-mono text-[#141413] dark:text-[#F4F2ED]"
          >
            {availableSegments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.channel_name} · {s.record_date} · {formatSecondsClock(s.start_seconds)} – {formatSecondsClock(s.end_seconds)} ({formatBytes(s.file_size_bytes)})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Honest Empty State when no recordings exist */}
      {!segmentsLoading && availableSegments.length === 0 && !payload && (
        <div className="rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] px-6 py-14 text-center space-y-3">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-[3px] border border-[#E5E2DC] dark:border-[#343432] bg-[#F8F7F4] dark:bg-[#141413] text-[#8A847C]">
            <Film className="h-5 w-5" />
          </div>
          <h3 className="font-display text-base font-semibold text-[#141413] dark:text-[#F4F2ED]">
            Video Not Available
          </h3>
          <p className="mx-auto max-w-md text-xs text-[#57534E] dark:text-[#A8A29E] leading-relaxed">
            No verified cloud recording segments exist in the archive yet. Configure an authorized stream in the 24/7 Recording Monitor or import an authorized historical video to play recordings here.
          </p>
          <div className="pt-2 flex items-center justify-center gap-3">
            <button
              onClick={() => onNavigate('recording-monitor')}
              className="rounded-[3px] bg-[#C83A1B] px-4 py-2 text-xs font-medium text-white hover:bg-[#A82E13] transition-colors"
            >
              Open 24/7 Recording Monitor
            </button>
            <button
              onClick={() => onNavigate('historical-search')}
              className="rounded-[3px] border border-[#D4CFC5] dark:border-[#343432] bg-white dark:bg-[#141413] px-4 py-2 text-xs font-medium text-[#141413] dark:text-[#F4F2ED] hover:bg-[#F4F2ED] dark:hover:bg-[#242422] transition-colors"
            >
              Historical Video Search
            </button>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="rounded-[3px] border border-[#FECACA] dark:border-[#7F1D1D] bg-[#FEF2F2] dark:bg-[#2A1515] px-4 py-3 flex items-center gap-2.5 text-xs text-[#B91C1C] dark:text-[#FCA5A5]">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Main Player + Matched Autosave Entries Layout */}
      {payload && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Player Deck */}
          <div className="xl:col-span-8 space-y-4">
            <div
              ref={containerRef}
              className="rounded-[3px] border border-[#2C2C2A] bg-[#0E0E0D] overflow-hidden"
            >
              {/* Broadcast Metadata Strip */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#252523] bg-[#161614] px-4 py-2.5 text-xs text-[#E7E5E4]">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="inline-block h-2 w-2 rounded-[1px] bg-[#C83A1B] shrink-0" />
                  <span className="font-display font-semibold text-white truncate">
                    {payload.segment.channel_name}
                  </span>
                  <span className="text-[#57534E]">·</span>
                  <span className="font-mono tabular-nums text-[#D6D3D1]">
                    {payload.segment.record_date}
                  </span>
                  <span className="text-[#57534E]">·</span>
                  <span className="font-mono tabular-nums text-[#A8A29E]">
                    {formatSecondsClock(payload.segment.start_seconds)} –{' '}
                    {formatSecondsClock(payload.segment.end_seconds)}
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px] text-[#A8A29E]">
                  <ShieldCheck className="h-3.5 w-3.5 text-[#15803D]" />
                  <span>{payload.storageProvider}</span>
                  <span>·</span>
                  <span>{formatBytes(payload.segment.file_size_bytes)}</span>
                </div>
              </div>

              {/* Video Surface */}
              <div className="relative aspect-video bg-black flex items-center justify-center">
                <video
                  ref={videoRef}
                  key={payload.playbackUrl}
                  src={payload.playbackUrl}
                  className="h-full w-full object-contain"
                  playsInline
                  preload="metadata"
                  onClick={togglePlay}
                  onLoadedMetadata={handleVideoLoadedMetadata}
                  onTimeUpdate={() => {
                    if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
                  }}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onWaiting={() => setIsBuffering(true)}
                  onCanPlay={() => setIsBuffering(false)}
                  onPlaying={() => setIsBuffering(false)}
                  onEnded={handleVideoEnded}
                  onError={() => {
                    setIsBuffering(false);
                    setErrorMsg('Video stream failed to load or signed URL expired. Click Refresh URL to generate a fresh playback token.');
                  }}
                />

                {(loadingUrl || isBuffering) && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50">
                    <div className="flex items-center gap-2 rounded-[3px] border border-[#343432] bg-[#141413]/90 px-4 py-2 text-xs text-white font-mono">
                      <Loader2 className="h-4 w-4 animate-spin text-[#C83A1B]" />
                      {loadingUrl ? 'Signing playback URL…' : 'Buffering segment…'}
                    </div>
                  </div>
                )}

                {/* Broadcast Wall-Clock Timecode HUD */}
                <div className="pointer-events-none absolute bottom-3 left-3 rounded-[2px] bg-black/75 px-2.5 py-1 font-mono text-[11px] tabular-nums text-white border border-white/10">
                  TC {formatSecondsClock(broadcastWallClockSeconds)}
                </div>
              </div>

              {/* Scrubber & Controls Deck */}
              <div className="border-t border-[#252523] bg-[#161614] px-4 py-3 space-y-3 text-white">
                {/* Timeline Scrubber */}
                <div className="space-y-1">
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, duration || payload.segment.duration_seconds)}
                    step={0.5}
                    value={Math.min(currentTime, Math.max(1, duration || payload.segment.duration_seconds))}
                    onChange={(e) => seekTo(Number(e.target.value))}
                    className="w-full accent-[#C83A1B] cursor-pointer h-1.5"
                    aria-label="Video timeline"
                  />
                  <div className="flex items-center justify-between font-mono text-[11px] tabular-nums text-[#A8A29E]">
                    <span>{formatDurationClock(currentTime)}</span>
                    <span>
                      Wall Clock: {formatSecondsClock(broadcastWallClockSeconds)}
                    </span>
                    <span>{formatDurationClock(duration || payload.segment.duration_seconds)}</span>
                  </div>
                </div>

                {/* Transport Buttons */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => payload.prevSegment && onSelectArchive(payload.prevSegment.id, 0)}
                      disabled={!payload.prevSegment}
                      title="Previous Segment"
                      className="rounded-[3px] border border-[#343432] bg-[#1F1F1D] p-1.5 text-[#E7E5E4] hover:bg-[#2A2A27] disabled:opacity-35 transition-colors"
                    >
                      <SkipBack className="h-3.5 w-3.5" />
                    </button>

                    <button
                      onClick={() => jumpBy(-60)}
                      title="Jump back 60s"
                      className="rounded-[3px] border border-[#343432] bg-[#1F1F1D] px-2 py-1 font-mono text-[11px] text-[#D6D3D1] hover:bg-[#2A2A27] transition-colors"
                    >
                      -60s
                    </button>

                    <button
                      onClick={() => jumpBy(-10)}
                      title="Jump back 10s"
                      className="inline-flex items-center gap-1 rounded-[3px] border border-[#343432] bg-[#1F1F1D] px-2 py-1 font-mono text-[11px] text-[#D6D3D1] hover:bg-[#2A2A27] transition-colors"
                    >
                      <Rewind className="h-3 w-3" />
                      10s
                    </button>

                    <button
                      onClick={togglePlay}
                      className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#C83A1B] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#A82E13] transition-colors"
                    >
                      {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 fill-current" />}
                      {isPlaying ? 'Pause' : 'Play'}
                    </button>

                    <button
                      onClick={() => jumpBy(10)}
                      title="Jump forward 10s"
                      className="inline-flex items-center gap-1 rounded-[3px] border border-[#343432] bg-[#1F1F1D] px-2 py-1 font-mono text-[11px] text-[#D6D3D1] hover:bg-[#2A2A27] transition-colors"
                    >
                      10s
                      <FastForward className="h-3 w-3" />
                    </button>

                    <button
                      onClick={() => jumpBy(60)}
                      title="Jump forward 60s"
                      className="rounded-[3px] border border-[#343432] bg-[#1F1F1D] px-2 py-1 font-mono text-[11px] text-[#D6D3D1] hover:bg-[#2A2A27] transition-colors"
                    >
                      +60s
                    </button>

                    <button
                      onClick={() => payload.nextSegment && onSelectArchive(payload.nextSegment.id, 0)}
                      disabled={!payload.nextSegment}
                      title="Next Segment"
                      className="rounded-[3px] border border-[#343432] bg-[#1F1F1D] p-1.5 text-[#E7E5E4] hover:bg-[#2A2A27] disabled:opacity-35 transition-colors"
                    >
                      <SkipForward className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Speed, Volume, Auto-Continue, Fullscreen */}
                  <div className="flex flex-wrap items-center gap-2.5">
                    <div className="inline-flex rounded-[3px] border border-[#343432] bg-[#1F1F1D] p-0.5">
                      {SPEED_OPTIONS.map((rate) => (
                        <button
                          key={rate}
                          onClick={() => changeSpeed(rate)}
                          className={`px-2 py-0.5 font-mono text-[11px] rounded-[2px] transition-colors ${
                            playbackRate === rate
                              ? 'bg-[#C83A1B] text-white font-semibold'
                              : 'text-[#A8A29E] hover:text-white'
                          }`}
                        >
                          {rate}x
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={toggleMute}
                        className="rounded-[3px] p-1 text-[#D6D3D1] hover:text-white"
                        aria-label={muted ? 'Unmute' : 'Mute'}
                      >
                        {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={muted ? 0 : volume}
                        onChange={(e) => changeVolume(Number(e.target.value))}
                        className="w-16 accent-[#C83A1B] cursor-pointer"
                        aria-label="Volume"
                      />
                    </div>

                    <label className="inline-flex items-center gap-1.5 text-[11px] text-[#A8A29E] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={autoContinue}
                        onChange={(e) => setAutoContinue(e.target.checked)}
                        className="rounded border-[#44403C]"
                      />
                      Auto-next
                    </label>

                    <button
                      onClick={toggleFullscreen}
                      className="rounded-[3px] border border-[#343432] bg-[#1F1F1D] p-1.5 text-[#E7E5E4] hover:bg-[#2A2A27] transition-colors"
                      aria-label={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
                    >
                      {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Segment Security & Adjacent Continuation Info */}
            <div className="rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] p-4 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
              <div>
                <div className="text-[11px] text-[#78716C] dark:text-[#A8A29E]">Time-Limited Playback Token</div>
                <div className="mt-1 font-mono text-[#141413] dark:text-[#F4F2ED]">
                  Expires {formatDateTime(payload.expiresAt)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[#78716C] dark:text-[#A8A29E]">Previous Segment</div>
                <div className="mt-1 font-mono text-[#141413] dark:text-[#F4F2ED]">
                  {payload.prevSegment
                    ? `${payload.prevSegment.record_date} ${formatSecondsClock(payload.prevSegment.start_seconds)}`
                    : 'Start of archive'}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[#78716C] dark:text-[#A8A29E]">Next Segment (Auto-Load)</div>
                <div className="mt-1 font-mono text-[#141413] dark:text-[#F4F2ED]">
                  {payload.nextSegment
                    ? `${payload.nextSegment.record_date} ${formatSecondsClock(payload.nextSegment.start_seconds)}`
                    : 'Latest verified segment'}
                </div>
              </div>
            </div>
          </div>

          {/* Right Panel: Matched Autosave Program / Ad / Promo Jump Markers */}
          <div className="xl:col-span-4 rounded-[3px] border border-[#E5E2DC] dark:border-[#2C2C2A] bg-white dark:bg-[#1B1B1A] overflow-hidden">
            <div className="border-b border-[#E5E2DC] dark:border-[#2C2C2A] px-4 py-3 flex items-center justify-between">
              <div>
                <h3 className="font-display text-sm font-semibold text-[#141413] dark:text-[#F4F2ED]">
                  Matched Autosave Timestamps
                </h3>
                <p className="text-[11px] text-[#78716C] dark:text-[#A8A29E]">
                  Click any program, ad, or promo to seek directly to its broadcast timestamp.
                </p>
              </div>
              <span className="font-mono text-xs tabular-nums text-[#78716C] dark:text-[#A8A29E]">
                {payload.matchedEntries.length}
              </span>
            </div>

            {payload.matchedEntries.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-[#78716C] dark:text-[#A8A29E] space-y-2">
                <p>No imported autosave entries matched this recording segment window.</p>
                <button
                  onClick={() => onNavigate('import')}
                  className="text-[#C83A1B] font-medium hover:underline underline-offset-2"
                >
                  Import Autosave XML for this date
                </button>
              </div>
            ) : (
              <div className="max-h-[520px] overflow-y-auto divide-y divide-[#EFECE6] dark:divide-[#262624]">
                {payload.matchedEntries.map((entry) => {
                  const isActive =
                    currentTime >= entry.offset_seconds &&
                    currentTime <= entry.offset_seconds + (entry.duration_seconds || 15);
                  return (
                    <button
                      key={entry.entry_id}
                      onClick={() => {
                        seekTo(entry.offset_seconds);
                        videoRef.current?.play().catch(() => {});
                      }}
                      className={`w-full text-left px-4 py-3 transition-colors ${
                        isActive
                          ? 'bg-[#FEF2F2] dark:bg-[#2A1715]'
                          : 'hover:bg-[#F8F7F4] dark:hover:bg-[#222220]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-mono font-medium text-[#C83A1B] tabular-nums">
                          {entry.start_time || formatDurationClock(entry.offset_seconds)}
                          <span className="ml-1.5 text-[#8A847C]">
                            (+{formatDurationClock(entry.offset_seconds)})
                          </span>
                        </span>
                        <span className="font-mono uppercase text-[10px] text-[#57534E] dark:text-[#A8A29E]">
                          {entry.entry_type}
                        </span>
                      </div>
                      <div className="mt-1 text-xs font-medium text-[#141413] dark:text-[#F4F2ED] truncate">
                        {entry.caption_name || entry.brand_name || 'Untitled Broadcast Entry'}
                      </div>
                      {entry.brand_name && entry.caption_name && (
                        <div className="text-[11px] text-[#78716C] dark:text-[#A8A29E] truncate">
                          {entry.brand_name}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
