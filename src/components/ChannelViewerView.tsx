import { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import { CheckCircle2, Cloud, CloudUpload, Plus, Search, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { ChannelEntry, ChannelSummary, QaIssue } from '../types.ts';
import { formatDuration, formatSecondsClock, getEntryTypeStyle, getQaStatusStyle } from '../lib/formatters.ts';
import { getAuthHeaders } from '../lib/apiAuth.ts';
import {
  CHANNEL_SCHEMA_LIMITS,
  deleteCloudChannel,
  saveCloudChannel,
  saveCloudChannelsBulk,
  type CloudChannelRecord,
} from '../lib/firebase.ts';

interface ChannelViewerViewProps {
  refreshKey: number;
  initialChannelKey?: string | null;
  initialDate?: string | null;
  highlightEntryId?: string | null;
  openAddChannelSignal?: number;
  cloudUser: User | null;
  cloudChannels: CloudChannelRecord[];
  cloudAuthBusy?: boolean;
  onSignInGoogle: () => Promise<User | null>;
  onSelectEntry: (entryId: string) => void;
  onNavigate: (tab: string) => void;
  onChannelsUpdated?: () => void;
}

const CHANNEL_CATEGORIES = [
  'News',
  'Entertainment',
  'Sports',
  'Movies',
  'Documentary',
  'Music',
  'Kids',
  'Regional',
  'General',
];

export function ChannelViewerView({
  refreshKey,
  initialChannelKey,
  initialDate,
  highlightEntryId,
  openAddChannelSignal = 0,
  cloudUser,
  cloudChannels,
  cloudAuthBusy = false,
  onSignInGoogle,
  onSelectEntry,
  onNavigate,
  onChannelsUpdated,
}: ChannelViewerViewProps) {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [channelSearch, setChannelSearch] = useState('');
  const [selectedChannelKey, setSelectedChannelKey] = useState<string | null>(initialChannelKey ?? null);
  const [selectedDate, setSelectedDate] = useState<string>(initialDate ?? '');
  const [entryTypeFilter, setEntryTypeFilter] = useState<string>('ALL');
  const [entrySearch, setEntrySearch] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<number>(2);

  const [entries, setEntries] = useState<ChannelEntry[]>([]);
  const [issues, setIssues] = useState<QaIssue[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletingChannel, setDeletingChannel] = useState(false);

  // Add Channel Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [addMode, setAddMode] = useState<'single' | 'bulk'>('single');
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelId, setNewChannelId] = useState('');
  const [newCategory, setNewCategory] = useState('News');
  const [newNotes, setNewNotes] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [savingChannel, setSavingChannel] = useState(false);
  const [syncingLocal, setSyncingLocal] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [bannerMsg, setBannerMsg] = useState<string | null>(null);

  useEffect(() => {
    if (initialChannelKey) setSelectedChannelKey(initialChannelKey);
  }, [initialChannelKey]);

  useEffect(() => {
    if (initialDate !== undefined && initialDate !== null) setSelectedDate(initialDate);
  }, [initialDate]);

  useEffect(() => {
    if (openAddChannelSignal > 0) {
      openAddModal('single');
    }
  }, [openAddChannelSignal]);

  const fetchChannels = (selectId?: string) => {
    setLoadingChannels(true);
    fetch('/api/channels', { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((data: ChannelSummary[]) => {
        setChannels(data);
        if (selectId && data.some((c) => c.id === selectId)) {
          setSelectedChannelKey(selectId);
        } else if (data.length > 0 && (!selectedChannelKey || !data.some((c) => c.id === selectedChannelKey))) {
          setSelectedChannelKey(data[0].id);
          if (data[0].dates.length > 0 && !selectedDate) {
            setSelectedDate(data[0].dates[0]);
          }
        } else if (data.length === 0) {
          setSelectedChannelKey(null);
        }
      })
      .finally(() => {
        setLoadingChannels(false);
      });
  };

  useEffect(() => {
    fetchChannels();
  }, [refreshKey]);

  const cloudById = useMemo(() => {
    const m = new Map<string, CloudChannelRecord>();
    for (const c of cloudChannels) m.set(c.id, c);
    return m;
  }, [cloudChannels]);

  // Merge cloud channels immediately so UI reflects cloud updates without waiting for round-trip
  const mergedChannels = useMemo(() => {
    const byId = new Map<string, ChannelSummary>();
    for (const ch of channels) {
      byId.set(ch.id, ch);
    }
    for (const cc of cloudChannels) {
      if (!byId.has(cc.id)) {
        byId.set(cc.id, {
          id: cc.id,
          channel_id: cc.channelId,
          channel_name: cc.channelName,
          is_selected: 1,
          source_file: 'cloud_sync',
          first_seen_at: new Date().toISOString(),
          last_updated_at: new Date().toISOString(),
          entry_count: 0,
          program_count: 0,
          spot_tvc_count: 0,
          media_count: 0,
          sponsorship_count: 0,
          program_duration_sec: 0,
          spot_tvc_duration_sec: 0,
          media_duration_sec: 0,
          sponsorship_duration_sec: 0,
          red_count: 0,
          yellow_count: 0,
          green_count: 0,
          pending_count: 0,
          dates: [],
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.channel_name.localeCompare(b.channel_name));
  }, [channels, cloudChannels]);

  const cloudChannelIdSet = useMemo(() => new Set(cloudChannels.map((c) => c.id)), [cloudChannels]);

  const unsyncedLocalChannels = useMemo(
    () => mergedChannels.filter((c) => !cloudChannelIdSet.has(c.id)),
    [mergedChannels, cloudChannelIdSet]
  );

  useEffect(() => {
    if (mergedChannels.length > 0 && (!selectedChannelKey || !mergedChannels.some((c) => c.id === selectedChannelKey))) {
      setSelectedChannelKey(mergedChannels[0].id);
    }
  }, [mergedChannels, selectedChannelKey]);

  const activeChannel = useMemo(
    () => mergedChannels.find((c) => c.id === selectedChannelKey) ?? null,
    [mergedChannels, selectedChannelKey]
  );

  const activeCloudMeta = activeChannel ? cloudById.get(activeChannel.id) ?? null : null;

  useEffect(() => {
    setConfirmDelete(false);
    if (!activeChannel) return;
    if (activeChannel.dates.length > 0 && (!selectedDate || !activeChannel.dates.includes(selectedDate))) {
      setSelectedDate(activeChannel.dates[0]);
    } else if (activeChannel.dates.length === 0) {
      setSelectedDate('');
    }
  }, [activeChannel?.id]);

  useEffect(() => {
    if (!selectedChannelKey) {
      setEntries([]);
      setIssues([]);
      return;
    }
    let cancelled = false;
    setLoadingEntries(true);
    const params = new URLSearchParams();
    if (selectedDate) params.set('date', selectedDate);
    if (entryTypeFilter !== 'ALL') params.set('entryType', entryTypeFilter);
    if (includeDeleted) params.set('includeDeleted', 'true');
    if (entrySearch.trim()) params.set('search', entrySearch.trim());

    fetch(`/api/channels/${encodeURIComponent(selectedChannelKey)}/entries?${params.toString()}`, {
      headers: getAuthHeaders(),
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setEntries(data.entries ?? []);
        setIssues(data.issues ?? []);
      })
      .finally(() => {
        if (!cancelled) setLoadingEntries(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedChannelKey, selectedDate, entryTypeFilter, includeDeleted, entrySearch, refreshKey]);

  const filteredChannels = useMemo(() => {
    const q = channelSearch.trim().toLowerCase();
    if (!q) return mergedChannels;
    return mergedChannels.filter(
      (c) =>
        c.channel_name.toLowerCase().includes(q) ||
        (c.channel_id ?? '').toLowerCase().includes(q) ||
        (cloudById.get(c.id)?.category ?? '').toLowerCase().includes(q)
    );
  }, [mergedChannels, channelSearch, cloudById]);

  // Compute timeline blocks and inter-entry gaps/overlaps on active records
  const timelineSegments = useMemo(() => {
    const timed = entries.filter(
      (e) =>
        e.is_deleted_record === 0 &&
        e.start_seconds !== null &&
        (e.end_seconds !== null || (e.duration_seconds !== null && e.duration_seconds > 0))
    );
    const gaps: Array<{ startSec: number; endSec: number; durationSec: number; kind: 'GAP' | 'OVERLAP' }> = [];

    for (let i = 1; i < timed.length; i++) {
      const prev = timed[i - 1];
      const curr = timed[i];
      if (prev.start_seconds === null || curr.start_seconds === null) continue;
      let prevEnd = prev.end_seconds ?? prev.start_seconds + (prev.duration_seconds ?? 0);
      if (prevEnd < prev.start_seconds && prev.start_seconds >= 20 * 3600) {
        prevEnd += 86400;
      }
      const delta = curr.start_seconds - prevEnd;
      if (delta > 5) {
        gaps.push({ startSec: prevEnd, endSec: curr.start_seconds, durationSec: delta, kind: 'GAP' });
      } else if (delta < -1.5) {
        gaps.push({ startSec: curr.start_seconds, endSec: prevEnd, durationSec: Math.abs(delta), kind: 'OVERLAP' });
      }
    }

    return { timed, gaps };
  }, [entries]);

  const issuesByEntry = useMemo(() => {
    const map = new Map<string, QaIssue[]>();
    for (const iss of issues) {
      const arr = map.get(iss.entry_id) ?? [];
      arr.push(iss);
      map.set(iss.entry_id, arr);
    }
    return map;
  }, [issues]);

  function openAddModal(mode: 'single' | 'bulk' = 'single') {
    setAddMode(mode);
    setModalError(null);
    setNewChannelName('');
    setNewChannelId('');
    setNewCategory('News');
    setNewNotes('');
    setBulkText('');
    setShowAddModal(true);
  }

  function formatFriendlyError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.error) return parsed.error;
    } catch {
      // not JSON
    }
    return raw;
  }

  async function ensureGoogleUser(): Promise<User | null> {
    if (cloudUser) return cloudUser;
    return await onSignInGoogle();
  }

  async function handleAddSingleChannel(e: React.FormEvent) {
    e.preventDefault();
    const cleanName = newChannelName.trim();
    if (!cleanName) {
      setModalError('Channel name is required.');
      return;
    }
    if (cleanName.length > CHANNEL_SCHEMA_LIMITS.channelNameMaxLength) {
      setModalError(`Channel name must be ${CHANNEL_SCHEMA_LIMITS.channelNameMaxLength} characters or fewer.`);
      return;
    }
    const cleanId = newChannelId.trim();
    if (cleanId && !CHANNEL_SCHEMA_LIMITS.channelIdPattern.test(cleanId)) {
      setModalError('Channel ID may only contain letters, numbers, spaces, hyphens, or underscores.');
      return;
    }

    setSavingChannel(true);
    setModalError(null);
    try {
      const signedIn = await ensureGoogleUser();
      if (!signedIn) {
        setModalError('Google sign-in is required to save channels permanently across all laptops and mobiles.');
        return;
      }

      const saved = await saveCloudChannel({
        channelName: cleanName,
        channelId: cleanId || undefined,
        category: newCategory,
        notes: newNotes.trim() || undefined,
      });

      await fetch('/api/channels/sync', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          channels: [
            ...cloudChannels.map((c) => ({
              id: c.id,
              channelId: c.channelId,
              channelName: c.channelName,
              category: c.category,
              notes: c.notes,
            })),
            {
              id: saved.id,
              channelId: saved.channelId,
              channelName: saved.channelName,
              category: newCategory,
              notes: newNotes.trim() || null,
            },
          ],
        }),
      });

      setShowAddModal(false);
      setBannerMsg(`Channel "${saved.channelName}" saved permanently to Cloud — visible on all laptops & mobiles.`);
      fetchChannels(saved.id);
      onChannelsUpdated?.();
    } catch (err) {
      setModalError(formatFriendlyError(err));
    } finally {
      setSavingChannel(false);
    }
  }

  async function handleAddBulkChannels(e: React.FormEvent) {
    e.preventDefault();
    const lines = bulkText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      setModalError('Enter at least one channel name.');
      return;
    }

    const items = lines.map((line) => {
      const parts = line.split(',').map((p) => p.trim());
      return {
        channelName: parts[0] || '',
        channelId: parts[1] || undefined,
        category: parts[2] || 'General',
      };
    });

    setSavingChannel(true);
    setModalError(null);
    try {
      const signedIn = await ensureGoogleUser();
      if (!signedIn) {
        setModalError('Google sign-in is required to save channels permanently across all laptops and mobiles.');
        return;
      }

      const result = await saveCloudChannelsBulk(items);
      setShowAddModal(false);
      setBannerMsg(
        `Saved ${result.added} channel${result.added === 1 ? '' : 's'} permanently to Cloud — visible on all laptops & mobiles.`
      );
      fetchChannels();
      onChannelsUpdated?.();
    } catch (err) {
      setModalError(formatFriendlyError(err));
    } finally {
      setSavingChannel(false);
    }
  }

  async function handleSyncLocalChannelsToCloud() {
    if (unsyncedLocalChannels.length === 0) return;
    setSyncingLocal(true);
    try {
      const signedIn = await ensureGoogleUser();
      if (!signedIn) return;
      const result = await saveCloudChannelsBulk(
        unsyncedLocalChannels.map((c) => ({
          channelName: c.channel_name,
          channelId: c.channel_id ?? undefined,
          category: 'General',
        }))
      );
      setBannerMsg(
        `Published ${result.added} existing channel${result.added === 1 ? '' : 's'} permanently to Cloud for all devices.`
      );
      onChannelsUpdated?.();
    } catch (err) {
      setBannerMsg(`Cloud sync error: ${formatFriendlyError(err)}`);
    } finally {
      setSyncingLocal(false);
    }
  }

  async function handleDeleteChannel() {
    if (!activeChannel) return;
    setDeletingChannel(true);
    try {
      const isInCloud = cloudChannelIdSet.has(activeChannel.id);
      if (isInCloud) {
        const signedIn = await ensureGoogleUser();
        if (!signedIn) {
          setBannerMsg('Sign in with Google to delete a permanent cloud channel.');
          setConfirmDelete(false);
          return;
        }
        await deleteCloudChannel(activeChannel.id);
      }

      await fetch(`/api/channels/${encodeURIComponent(activeChannel.id)}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });

      const deletedName = activeChannel.channel_name;
      setConfirmDelete(false);
      const remaining = mergedChannels.filter((c) => c.id !== activeChannel.id);
      setChannels((prev) => prev.filter((c) => c.id !== activeChannel.id));
      setSelectedChannelKey(remaining.length > 0 ? remaining[0].id : null);
      setBannerMsg(`Channel "${deletedName}" permanently deleted.`);
      onChannelsUpdated?.();
    } catch (err) {
      setBannerMsg(`Delete failed: ${formatFriendlyError(err)}`);
    } finally {
      setDeletingChannel(false);
    }
  }

  const addChannelModal = showAddModal && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#141413]/45 p-4">
      <div className="w-full max-w-md rounded-[3px] border border-[#D4CFC5] bg-white overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#E5E2DC] bg-[#FCFBF9] px-5 py-4">
          <div>
            <h3 className="font-display text-sm font-semibold text-[#141413]">
              Add Permanent TV Channel
            </h3>
            <p className="text-[11px] text-[#78716C] mt-0.5">
              Synced to Cloud Firestore across every laptop and mobile
            </p>
          </div>
          <button
            onClick={() => setShowAddModal(false)}
            className="rounded-[3px] p-1 text-[#78716C] hover:bg-[#EAE7E0] hover:text-[#141413]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="flex border-b border-[#E5E2DC] text-xs font-medium bg-[#F8F7F4]">
          <button
            type="button"
            onClick={() => {
              setAddMode('single');
              setModalError(null);
            }}
            className={`flex-1 py-2.5 text-center border-b-2 transition-colors ${
              addMode === 'single'
                ? 'border-[#C83A1B] text-[#141413] bg-white font-semibold'
                : 'border-transparent text-[#78716C] hover:text-[#141413]'
            }`}
          >
            Single Channel
          </button>
          <button
            type="button"
            onClick={() => {
              setAddMode('bulk');
              setModalError(null);
            }}
            className={`flex-1 py-2.5 text-center border-b-2 transition-colors ${
              addMode === 'bulk'
                ? 'border-[#C83A1B] text-[#141413] bg-white font-semibold'
                : 'border-transparent text-[#78716C] hover:text-[#141413]'
            }`}
          >
            Bulk Add Multiple
          </button>
        </div>

        <div className="p-5">
          {!cloudUser && (
            <div className="mb-4 rounded-[3px] border border-[#E5E2DC] bg-[#F8F7F4] px-3.5 py-2.5 text-xs text-[#141413] flex items-center justify-between gap-3">
              <span className="text-[#57534E]">Sign in with Google once to save channels permanently.</span>
              <button
                type="button"
                disabled={cloudAuthBusy}
                onClick={() => onSignInGoogle()}
                className="rounded-[3px] bg-[#141413] px-3 py-1.5 text-[11px] font-medium text-white hover:bg-[#2A2927] disabled:opacity-50 shrink-0"
              >
                {cloudAuthBusy ? 'Connecting…' : 'Sign In'}
              </button>
            </div>
          )}

          {modalError && (
            <div className="mb-4 rounded-[3px] border border-[#FCA5A5] bg-[#FEF2F2] px-3 py-2 text-xs text-[#B91C1C]">
              {modalError}
            </div>
          )}

          {addMode === 'single' ? (
            <form onSubmit={handleAddSingleChannel} className="space-y-4 text-xs">
              <div>
                <label className="block font-medium text-[#57534E] mb-1">
                  Channel Name <span className="text-[#C83A1B]">*</span>
                </label>
                <input
                  type="text"
                  maxLength={CHANNEL_SCHEMA_LIMITS.channelNameMaxLength}
                  value={newChannelName}
                  onChange={(e) => setNewChannelName(e.target.value)}
                  placeholder="e.g. ARY News, Geo TV, Hum TV"
                  className="w-full rounded-[3px] border border-[#D4CFC5] bg-white px-3 py-2 text-xs text-[#141413] focus:border-[#141413] focus:outline-none"
                  autoFocus
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-[#57534E] mb-1">
                    Channel ID <span className="text-[#8A847C] font-normal">(Optional)</span>
                  </label>
                  <input
                    type="text"
                    maxLength={CHANNEL_SCHEMA_LIMITS.channelIdMaxLength}
                    value={newChannelId}
                    onChange={(e) => setNewChannelId(e.target.value)}
                    placeholder="e.g. 101"
                    className="w-full rounded-[3px] border border-[#D4CFC5] bg-white px-3 py-2 text-xs font-mono text-[#141413] focus:border-[#141413] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-medium text-[#57534E] mb-1">Category</label>
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    className="w-full rounded-[3px] border border-[#D4CFC5] bg-white px-3 py-2 text-xs text-[#141413] focus:border-[#141413] focus:outline-none"
                  >
                    {CHANNEL_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-medium text-[#57534E] mb-1">
                  Notes <span className="text-[#8A847C] font-normal">(Optional)</span>
                </label>
                <input
                  type="text"
                  maxLength={CHANNEL_SCHEMA_LIMITS.notesMaxLength}
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  placeholder="Optional monitoring notes…"
                  className="w-full rounded-[3px] border border-[#D4CFC5] bg-white px-3 py-2 text-xs text-[#141413] focus:border-[#141413] focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-[#EFECE6]">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="rounded-[3px] border border-[#D4CFC5] bg-white px-3.5 py-1.5 text-xs font-medium text-[#57534E] hover:bg-[#F4F2ED]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingChannel}
                  className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#C83A1B] px-4 py-1.5 text-xs font-medium text-white hover:bg-[#A82E13] disabled:opacity-50"
                >
                  <Cloud className="h-3.5 w-3.5" />
                  {savingChannel ? 'Saving…' : 'Save Permanently'}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleAddBulkChannels} className="space-y-4 text-xs">
              <div>
                <label className="block font-medium text-[#57534E] mb-1">
                  Channel List (one per line)
                </label>
                <textarea
                  rows={6}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={'ARY News, 101, News\nGeo Entertainment, 102, Entertainment\nPTV Sports, 103, Sports\nHum TV'}
                  className="w-full rounded-[3px] border border-[#D4CFC5] bg-white px-3 py-2 text-xs font-mono text-[#141413] focus:border-[#141413] focus:outline-none"
                  autoFocus
                  required
                />
                <p className="mt-1.5 text-[11px] text-[#78716C]">
                  Format: <span className="font-mono text-[#141413]">Channel Name</span> or{' '}
                  <span className="font-mono text-[#141413]">Channel Name, ID, Category</span>
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-[#EFECE6]">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="rounded-[3px] border border-[#D4CFC5] bg-white px-3.5 py-1.5 text-xs font-medium text-[#57534E] hover:bg-[#F4F2ED]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingChannel}
                  className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#C83A1B] px-4 py-1.5 text-xs font-medium text-white hover:bg-[#A82E13] disabled:opacity-50"
                >
                  <Cloud className="h-3.5 w-3.5" />
                  {savingChannel ? 'Saving…' : 'Save All Permanently'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );

  if (!loadingChannels && mergedChannels.length === 0) {
    return (
      <div className="space-y-4">
        {bannerMsg && (
          <div className="rounded-[3px] border border-[#C7DEC9] bg-[#F0F5F2] px-4 py-2.5 text-xs text-[#14532D] flex items-center justify-between">
            <span className="inline-flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-[#15803D]" />
              {bannerMsg}
            </span>
            <button onClick={() => setBannerMsg(null)} className="font-semibold">
              ×
            </button>
          </div>
        )}

        <div className="rounded-[3px] border border-[#E5E2DC] bg-white p-12 text-center space-y-4">
          <h3 className="font-display text-lg font-semibold text-[#141413]">No Channels Registered Yet</h3>
          <p className="text-xs text-[#57534E] max-w-md mx-auto leading-relaxed">
            Add TV channels permanently to your Cloud Master List so they automatically appear on every laptop and mobile device, or import an office autosave folder.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <button
              onClick={() => openAddModal('single')}
              className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#C83A1B] px-4 py-2 text-xs font-medium text-white hover:bg-[#A82E13]"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Permanent Channel
            </button>
            <button
              onClick={() => onNavigate('import')}
              className="rounded-[3px] border border-[#D4CFC5] bg-white px-4 py-2 text-xs font-medium text-[#141413] hover:bg-[#F4F2ED]"
            >
              Import Autosave Folder
            </button>
          </div>
        </div>

        {addChannelModal}
      </div>
    );
  }

  const timelineWidthPx = 1200 * zoomLevel;

  return (
    <div className="space-y-5">
      {bannerMsg && (
        <div className="rounded-[3px] border border-[#C7DEC9] bg-[#F0F5F2] px-4 py-2.5 text-xs text-[#14532D] flex items-center justify-between">
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-[#15803D]" />
            {bannerMsg}
          </span>
          <button onClick={() => setBannerMsg(null)} className="font-semibold px-1">
            ×
          </button>
        </div>
      )}

      {unsyncedLocalChannels.length > 0 && (
        <div className="rounded-[3px] border border-[#E8DAB0] bg-[#FBF6E8] px-4 py-3 text-xs text-[#854D0E] flex flex-wrap items-center justify-between gap-3">
          <span>
            <strong className="font-mono tabular-nums">{unsyncedLocalChannels.length}</strong> local channel
            {unsyncedLocalChannels.length === 1 ? '' : 's'} not yet published to Cloud Firestore. Publish them so they show permanently on every device.
          </span>
          <button
            onClick={handleSyncLocalChannelsToCloud}
            disabled={syncingLocal}
            className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#854D0E] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#713F12] disabled:opacity-50"
          >
            <CloudUpload className="h-3.5 w-3.5" />
            {syncingLocal ? 'Publishing…' : 'Save Permanently to Cloud'}
          </button>
        </div>
      )}

      {/* Master Control 2-Column Split: Channel Roster (Left) + Timeline & Records (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-[272px_1fr] gap-6 items-start">
        {/* Left Channel Roster */}
        <aside className="rounded-[3px] border border-[#E5E2DC] bg-white overflow-hidden lg:sticky lg:top-20">
          <div className="border-b border-[#E5E2DC] px-4 py-3 flex items-center justify-between gap-2 bg-[#FCFBF9]">
            <div className="text-xs font-semibold text-[#141413]">
              Channels{' '}
              <span className="font-mono tabular-nums font-normal text-[#78716C]">
                ({filteredChannels.length})
              </span>
            </div>
            <button
              onClick={() => openAddModal('single')}
              className="inline-flex items-center gap-1 text-xs font-medium text-[#C83A1B] hover:underline underline-offset-2 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>

          <div className="p-2.5 border-b border-[#EFECE6]">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-[#8A847C]" />
              <input
                type="text"
                value={channelSearch}
                onChange={(e) => setChannelSearch(e.target.value)}
                placeholder="Filter by name, ID, category…"
                className="w-full rounded-[3px] border border-[#E5E2DC] bg-[#F8F7F4] pl-8 pr-2.5 py-1.5 text-xs text-[#141413] placeholder:text-[#8A847C] focus:bg-white focus:border-[#141413] focus:outline-none"
              />
            </div>
          </div>

          <div className="max-h-[340px] lg:max-h-[calc(100vh-230px)] overflow-y-auto divide-y divide-[#F2EFE9]">
            {filteredChannels.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-[#8A847C]">
                No channels match &ldquo;{channelSearch}&rdquo;.
              </div>
            ) : (
              filteredChannels.map((ch) => {
                const selected = ch.id === activeChannel?.id;
                const meta = cloudById.get(ch.id);
                return (
                  <button
                    key={ch.id}
                    onClick={() => setSelectedChannelKey(ch.id)}
                    className={`w-full text-left px-3.5 py-2.5 flex items-center justify-between gap-2 transition-colors ${
                      selected
                        ? 'bg-[#141413] text-white'
                        : 'bg-white text-[#141413] hover:bg-[#F8F7F4]'
                    }`}
                  >
                    <div className="min-w-0 flex items-center gap-2.5">
                      <span
                        className={`font-mono text-[11px] tabular-nums w-7 shrink-0 ${
                          selected ? 'text-[#C83A1B] font-semibold' : 'text-[#8A847C]'
                        }`}
                      >
                        {ch.channel_id ? ch.channel_id.slice(0, 4) : '—'}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-medium truncate">{ch.channel_name}</div>
                        <div
                          className={`text-[10px] truncate ${
                            selected ? 'text-[#A8A29E]' : 'text-[#8A847C]'
                          }`}
                        >
                          {meta?.category || 'General'}
                          {ch.entry_count > 0 ? ` · ${ch.entry_count} logs` : ''}
                        </div>
                      </div>
                    </div>
                    {ch.red_count > 0 && (
                      <span
                        className={`font-mono text-[10px] tabular-nums font-semibold shrink-0 ${
                          selected ? 'text-[#FCA5A5]' : 'text-[#B91C1C]'
                        }`}
                      >
                        {ch.red_count}!
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Right Selected Channel Workspace */}
        <div className="min-w-0 space-y-5">
          {/* Selected Channel Header Bar */}
          <section className="rounded-[3px] border border-[#E5E2DC] bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <h2 className="font-display text-xl font-semibold tracking-[-0.02em] text-[#141413]">
                    {activeChannel ? activeChannel.channel_name : 'Select a Channel'}
                  </h2>
                  {activeChannel?.channel_id && (
                    <span className="font-mono text-xs text-[#78716C] tabular-nums">
                      CH {activeChannel.channel_id}
                    </span>
                  )}
                </div>

                {/* Unboxed clean typographic metadata */}
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#78716C]">
                  <span>{activeCloudMeta?.category || 'General'}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{entries.length} records</span>
                  {activeChannel && cloudChannelIdSet.has(activeChannel.id) && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-[#15803D] font-medium">Synced across all devices</span>
                    </>
                  )}
                </div>
              </div>

              {/* Channel Actions */}
              <div className="flex flex-wrap items-center gap-2">
                {activeChannel && activeChannel.dates.length > 0 && (
                  <select
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="rounded-[3px] border border-[#D4CFC5] bg-white px-3 py-1.5 text-xs font-mono text-[#141413]"
                  >
                    {activeChannel.dates.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                )}

                <div className="flex items-center border border-[#D4CFC5] rounded-[3px] bg-white">
                  <button
                    onClick={() => setZoomLevel((z) => Math.max(1, z - 1))}
                    disabled={zoomLevel <= 1}
                    className="p-1.5 text-[#57534E] hover:text-[#141413] disabled:opacity-40"
                    title="Zoom Out Timeline"
                    aria-label="Zoom Out Timeline"
                  >
                    <ZoomOut className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-[11px] font-mono tabular-nums px-2 text-[#141413] border-x border-[#EFECE6]">
                    {zoomLevel}x
                  </span>
                  <button
                    onClick={() => setZoomLevel((z) => Math.min(6, z + 1))}
                    disabled={zoomLevel >= 6}
                    className="p-1.5 text-[#57534E] hover:text-[#141413] disabled:opacity-40"
                    title="Zoom In Timeline"
                    aria-label="Zoom In Timeline"
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </button>
                </div>

                <button
                  onClick={() => openAddModal('bulk')}
                  className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#D4CFC5] bg-white px-3 py-1.5 text-xs font-medium text-[#141413] hover:bg-[#F4F2ED] whitespace-nowrap"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Bulk Add
                </button>

                {activeChannel && !confirmDelete && (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="inline-flex items-center gap-1 rounded-[3px] border border-[#E5E2DC] bg-white px-2.5 py-1.5 text-xs font-medium text-[#B91C1C] hover:bg-[#FEF2F2] hover:border-[#FCA5A5] whitespace-nowrap"
                    title="Delete Selected Channel"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                )}

                {activeChannel && confirmDelete && (
                  <div className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#FCA5A5] bg-[#FEF2F2] px-2.5 py-1 text-xs">
                    <span className="text-[#B91C1C] font-medium">Remove?</span>
                    <button
                      onClick={handleDeleteChannel}
                      disabled={deletingChannel}
                      className="rounded-[2px] bg-[#B91C1C] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#991B1B] disabled:opacity-50"
                    >
                      {deletingChannel ? 'Deleting…' : 'Confirm'}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="rounded-[2px] border border-[#D4CFC5] bg-white px-2 py-0.5 text-[11px] text-[#57534E] hover:bg-[#F4F2ED]"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Integrated Filter Controls */}
            <div className="mt-4 pt-4 border-t border-[#EFECE6] flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex flex-wrap items-center gap-1 rounded-[3px] bg-[#F4F2ED] p-1">
                {(['ALL', 'PROGRAM', 'SPOT/TVC', 'MEDIA', 'SPONSORSHIP'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setEntryTypeFilter(t)}
                    className={`rounded-[2px] px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      entryTypeFilter === t
                        ? 'bg-white text-[#141413] border border-[#DDD8CE]'
                        : 'text-[#57534E] border border-transparent hover:text-[#141413]'
                    }`}
                  >
                    {t === 'ALL' ? 'All' : t}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-1.5 text-[#57534E] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeDeleted}
                    onChange={(e) => setIncludeDeleted(e.target.checked)}
                    className="rounded-[2px] border-[#D4CFC5] accent-[#C83A1B]"
                  />
                  Include deleted
                </label>

                <input
                  type="text"
                  value={entrySearch}
                  onChange={(e) => setEntrySearch(e.target.value)}
                  placeholder="Search caption, brand, ID…"
                  className="rounded-[3px] border border-[#D4CFC5] bg-white px-3 py-1.5 text-xs text-[#141413] w-48 focus:border-[#141413] focus:outline-none"
                />
              </div>
            </div>
          </section>

          {/* 24-Hour Studio Timecode Timeline */}
          <section className="rounded-[3px] border border-[#E5E2DC] bg-white overflow-hidden">
            <div className="border-b border-[#E5E2DC] px-5 py-3 flex items-center justify-between bg-[#FCFBF9]">
              <h3 className="font-display text-xs font-semibold text-[#141413]">
                24-Hour Broadcast Timeline · {selectedDate || 'All Dates'}
              </h3>
              <span className="text-[11px] font-mono tabular-nums text-[#78716C]">
                Scale {zoomLevel}x · {timelineWidthPx}px
              </span>
            </div>

            {entries.length === 0 ? (
              <div className="px-6 py-10 text-center space-y-2">
                <p className="text-xs text-[#57534E]">
                  No autosave records loaded for{' '}
                  <span className="font-medium text-[#141413]">{activeChannel?.channel_name}</span> yet.
                </p>
                <button
                  onClick={() => onNavigate('import')}
                  className="text-xs font-medium text-[#C83A1B] hover:underline underline-offset-2"
                >
                  Import an autosave XML folder to populate this timeline
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto p-4">
                <div className="relative" style={{ width: `${timelineWidthPx}px` }}>
                  {/* Hour ticks */}
                  <div className="relative h-6 border-b border-[#D4CFC5] text-[10px] font-mono tabular-nums text-[#78716C]">
                    {Array.from({ length: 25 }).map((_, h) => (
                      <div
                        key={h}
                        className="absolute top-0 bottom-0 border-l border-[#E5E2DC] pl-1"
                        style={{ left: `${(h / 24) * 100}%` }}
                      >
                        {String(h).padStart(2, '0')}:00
                      </div>
                    ))}
                  </div>

                  {/* Timeline track */}
                  <div className="relative mt-2 h-16 rounded-[2px] border border-[#E5E2DC] bg-[#F8F7F4] overflow-hidden">
                    {/* Gaps & Overlaps */}
                    {timelineSegments.gaps.map((g, idx) => {
                      const leftPct = Math.max(0, Math.min(100, (g.startSec / 86400) * 100));
                      const widthPct = Math.max(0.15, ((g.endSec - g.startSec) / 86400) * 100);
                      return (
                        <div
                          key={`gap_${idx}`}
                          title={`${g.kind}: ${formatSecondsClock(g.startSec)} -> ${formatSecondsClock(g.endSec)} (${g.durationSec.toFixed(1)}s)`}
                          className={`absolute top-1 bottom-1 ${
                            g.kind === 'GAP'
                              ? 'border border-dashed border-[#B45309] bg-[#FEF3C7]/80'
                              : 'border border-[#B91C1C] bg-[#FEE2E2]/80'
                          }`}
                          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                        />
                      );
                    })}

                    {/* Entry blocks */}
                    {timelineSegments.timed.map((e) => {
                      const start = Math.max(0, e.start_seconds ?? 0);
                      let end = e.end_seconds ?? start + (e.duration_seconds ?? 30);
                      if (end < start && start >= 20 * 3600) end = 86400;
                      const dur = Math.max(end - start, 5);
                      const leftPct = Math.min(99.8, (start / 86400) * 100);
                      const widthPct = Math.max(0.25, Math.min(100 - leftPct, (dur / 86400) * 100));
                      const st = getEntryTypeStyle(e.entry_type);
                      const isHighlighted = highlightEntryId === e.id;

                      return (
                        <button
                          key={e.id}
                          onClick={() => onSelectEntry(e.id)}
                          title={`${e.entry_type}: ${e.caption_name || e.brand_name || e.id}\n${e.start_time} → ${e.end_time} (${formatDuration(e.duration_seconds)})\nQA: ${e.qa_status}`}
                          className={`absolute top-2 bottom-2 rounded-[2px] text-left px-1 text-[10px] text-white overflow-hidden transition-opacity hover:opacity-90 ${
                            isHighlighted ? 'ring-2 ring-[#C83A1B] ring-offset-1 z-20' : 'z-10'
                          }`}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            backgroundColor: st.barBg,
                            borderBottom:
                              e.qa_status === 'RED'
                                ? '3px solid #EF4444'
                                : e.qa_status === 'YELLOW'
                                  ? '3px solid #F59E0B'
                                  : `1px solid ${st.barBorder}`,
                          }}
                        >
                          <span className="truncate block font-medium leading-tight pt-0.5">
                            {e.caption_name || e.brand_name || e.entry_type}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Chronological Saved Entries Table */}
          <section className="rounded-[3px] border border-[#E5E2DC] bg-white overflow-hidden">
            <div className="border-b border-[#E5E2DC] px-5 py-3 flex items-center justify-between bg-[#FCFBF9]">
              <h3 className="font-display text-xs font-semibold text-[#141413]">
                Chronological Channel Records
              </h3>
              {loadingEntries && <span className="text-xs text-[#78716C]">Loading records…</span>}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-[#E5E2DC] bg-[#FCFBF9] text-[11px] font-medium text-[#78716C]">
                  <tr>
                    <th className="px-4 py-2.5">Start</th>
                    <th className="px-4 py-2.5">End</th>
                    <th className="px-4 py-2.5 text-right">Duration</th>
                    <th className="px-4 py-2.5">Type</th>
                    <th className="px-4 py-2.5">Caption / Brand</th>
                    <th className="px-4 py-2.5">Category</th>
                    <th className="px-4 py-2.5">ID</th>
                    <th className="px-4 py-2.5 text-right">QA</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EFECE6]">
                  {entries.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-[#78716C]">
                        No records match the selected channel, date, or filters.
                      </td>
                    </tr>
                  ) : (
                    entries.map((e) => {
                      const typeSt = getEntryTypeStyle(e.entry_type);
                      const qaSt = getQaStatusStyle(e.qa_status);
                      const entryIssues = issuesByEntry.get(e.id) ?? [];
                      const isHighlighted = highlightEntryId === e.id;

                      return (
                        <tr
                          key={e.id}
                          onClick={() => onSelectEntry(e.id)}
                          className={`cursor-pointer transition-colors ${
                            isHighlighted ? 'bg-[#FDF4F1]' : 'hover:bg-[#F8F7F4]'
                          }`}
                        >
                          <td className="px-4 py-2.5 font-mono tabular-nums text-[#141413] whitespace-nowrap">
                            {e.start_time ?? '—'}
                          </td>
                          <td className="px-4 py-2.5 font-mono tabular-nums text-[#141413] whitespace-nowrap">
                            {e.end_time ?? '—'}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#57534E] whitespace-nowrap">
                            {formatDuration(e.duration_seconds)}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className={`font-medium ${typeSt.text}`}>
                              {typeSt.label}
                            </span>
                            {e.is_deleted_record === 1 && (
                              <span className="ml-1.5 text-[10px] font-mono text-[#B91C1C]">DEL</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 max-w-[230px]">
                            <div className="font-medium text-[#141413] truncate">
                              {e.caption_name || e.brand_name || '—'}
                            </div>
                            {e.brand_name && e.caption_name && (
                              <div className="text-[11px] text-[#78716C] truncate">{e.brand_name}</div>
                            )}
                          </td>
                          <td className="px-4 py-2.5 max-w-[160px]">
                            <div className="text-[#57534E] truncate">{e.category_name ?? '—'}</div>
                            {e.subcategory_name && (
                              <div className="text-[11px] text-[#8A847C] truncate">{e.subcategory_name}</div>
                            )}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-[11px] text-[#78716C] whitespace-nowrap">
                            {e.master_entry_id ? `M:${e.master_entry_id}` : ''}
                            {e.commercial_id ? ` C:${e.commercial_id}` : ''}
                            {!e.master_entry_id && !e.commercial_id ? e.id.slice(0, 10) : ''}
                          </td>
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            <span className={qaSt.classes}>{qaSt.label}</span>
                            {entryIssues.length > 0 && (
                              <span className="ml-1 font-mono tabular-nums text-[11px] text-[#78716C]">
                                ({entryIssues.length})
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      {addChannelModal}
    </div>
  );
}
