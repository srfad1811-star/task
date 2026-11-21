import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  Cloud,
  CloudOff,
  DatabaseBackup,
  FileSpreadsheet,
  FolderInput,
  History,
  LayoutDashboard,
  ListFilter,
  LogOut,
  Play,
  Plus,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Tv2,
} from 'lucide-react';
import { AllEntriesView } from './components/AllEntriesView.tsx';
import { AutomaticQaView } from './components/AutomaticQaView.tsx';
import { BackupRestoreView } from './components/BackupRestoreView.tsx';
import { ChannelViewerView } from './components/ChannelViewerView.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { EntryDetailDrawer } from './components/EntryDetailDrawer.tsx';
import { ImportAutosaveView } from './components/ImportAutosaveView.tsx';
import { ImportHistoryView } from './components/ImportHistoryView.tsx';
import { LoginModal } from './components/LoginModal.tsx';
import { QaResultsView } from './components/QaResultsView.tsx';
import { ReportsView } from './components/ReportsView.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import {
  getAuthHeaders,
  setCurrentOperatorSession,
  type OperatorSession,
} from './lib/apiAuth.ts';
import {
  auth,
  signInWithGoogle,
  signOutGoogle,
  subscribePublicCloudChannels,
  type CloudChannelRecord,
} from './lib/firebase.ts';

type NavId =
  | 'dashboard'
  | 'channels'
  | 'entries'
  | 'import'
  | 'auto-qa'
  | 'qa-results'
  | 'reports'
  | 'history'
  | 'backup'
  | 'settings';

const NAV_ITEMS: Array<{
  id: NavId;
  label: string;
  icon: typeof LayoutDashboard;
  minRole: 'VIEWER' | 'OPERATOR' | 'ADMIN';
}> = [
  { id: 'dashboard', label: 'Overview', icon: LayoutDashboard, minRole: 'VIEWER' },
  { id: 'channels', label: 'Channel Master', icon: Tv2, minRole: 'VIEWER' },
  { id: 'entries', label: 'All Entries', icon: ListFilter, minRole: 'VIEWER' },
  { id: 'import', label: 'Import Autosave', icon: FolderInput, minRole: 'OPERATOR' },
  { id: 'auto-qa', label: 'Automatic QA', icon: ShieldCheck, minRole: 'OPERATOR' },
  { id: 'qa-results', label: 'QA Findings', icon: ShieldAlert, minRole: 'VIEWER' },
  { id: 'reports', label: 'Reports', icon: FileSpreadsheet, minRole: 'VIEWER' },
  { id: 'history', label: 'Import History', icon: History, minRole: 'OPERATOR' },
  { id: 'backup', label: 'Backup & Restore', icon: DatabaseBackup, minRole: 'ADMIN' },
  { id: 'settings', label: 'Settings', icon: Settings, minRole: 'ADMIN' },
];

export default function App() {
  const [user, setUser] = useState<OperatorSession | null>(null);

  const [theme] = useState<'light' | 'dark'>('light');

  const [cloudUser, setCloudUser] = useState<User | null>(null);
  const [cloudChannels, setCloudChannels] = useState<CloudChannelRecord[]>([]);
  const [cloudAuthBusy, setCloudAuthBusy] = useState(false);
  const [cloudAuthNotice, setCloudAuthNotice] = useState<string | null>(null);

  const [activeNav, setActiveNav] = useState<NavId>('dashboard');
  const [refreshKey, setRefreshKey] = useState(0);
  const [qaRunning, setQaRunning] = useState(false);

  const [viewerChannelKey, setViewerChannelKey] = useState<string | null>(null);
  const [viewerDate, setViewerDate] = useState<string | null>(null);
  const [viewerHighlightId, setViewerHighlightId] = useState<string | null>(null);
  const [drawerEntryId, setDrawerEntryId] = useState<string | null>(null);
  const [openAddChannelSignal, setOpenAddChannelSignal] = useState(0);

  const triggerRefresh = () => setRefreshKey((k) => k + 1);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    setCurrentOperatorSession(user);
  }, [user]);

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, (firebaseUser) => {
      setCloudUser(firebaseUser);
    });
    return () => unsubAuth();
  }, []);

  useEffect(() => {
    if (!user?.sessionToken) return;
    let cancelled = false;
    const unsub = subscribePublicCloudChannels(
      (list) => {
        if (cancelled) return;
        setCloudChannels(list);
        if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN' || user.role === 'OPERATOR') {
          fetch('/api/channels/sync', {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              channels: list.map((c) => ({
                id: c.id,
                channelId: c.channelId,
                channelName: c.channelName,
                category: c.category,
                notes: c.notes,
              })),
            }),
          })
            .then(() => {
              if (!cancelled) triggerRefresh();
            })
            .catch((err) => {
              console.error('Failed to sync cloud channels:', err);
            });
        }
      },
      (err) => {
        console.error('Cloud channel sync error:', err.message);
      }
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, [user?.sessionToken, user?.role]);

  async function handleGoogleSignIn(): Promise<User | null> {
    if (cloudUser) return cloudUser;
    setCloudAuthNotice(null);
    setCloudAuthBusy(true);
    try {
      const result = await signInWithGoogle();
      if (result.user) {
        setCloudUser(result.user);
        setCloudAuthNotice(null);
        return result.user;
      }
      if (result.errorMessage) {
        setCloudAuthNotice(result.errorMessage);
      }
      return null;
    } finally {
      setCloudAuthBusy(false);
    }
  }

  async function handleGoogleSignOut() {
    setCloudAuthBusy(true);
    try {
      await signOutGoogle();
      setCloudUser(null);
    } finally {
      setCloudAuthBusy(false);
    }
  }

  function handleNavigate(tab: string) {
    setActiveNav(tab as NavId);
  }

  function handleOpenEntryInChannelViewer(
    channelKey: string,
    transDate: string | null,
    entryId: string
  ) {
    setViewerChannelKey(channelKey);
    setViewerDate(transDate ?? '');
    setViewerHighlightId(entryId);
    setDrawerEntryId(entryId);
    setActiveNav('channels');
  }

  async function handleRunQaNow() {
    setQaRunning(true);
    try {
      await fetch('/api/qa/run', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: '{}',
      });
      triggerRefresh();
    } finally {
      setQaRunning(false);
    }
  }

  async function handleOperatorLogout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
    } catch {
      // ignore network error on logout
    }
    setCurrentOperatorSession(null);
    setUser(null);
    setActiveNav('dashboard');
  }

  const visibleNavItems = NAV_ITEMS.filter((item) => {
    const role = user?.role || 'VIEWER';
    if (role === 'SUPER_ADMIN' || role === 'ADMIN') return true;
    if (role === 'OPERATOR') return item.minRole !== 'ADMIN';
    return item.minRole === 'VIEWER';
  });

  if (!user) {
    return (
      <LoginModal
        onLoginSuccess={(u) => {
          setCurrentOperatorSession(u);
          setUser(u);
        }}
      />
    );
  }

  const canOperate = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN' || user.role === 'OPERATOR';

  return (
    <div className="min-h-screen flex flex-col bg-[#F8F9FA] text-[#111827]">

      {/* Red & White Broadcast Command Header */}
      <header className="sticky top-0 z-30 border-b border-[#E5E7EB] bg-white/95 backdrop-blur-md px-6 py-2.5 flex flex-col gap-2.5 shadow-xs">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] text-white bg-[#DC2626] px-2 py-0.5 rounded font-bold tracking-wider uppercase shadow-xs">
              LIVE QA
            </span>
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#DC2626]"></span>
              </span>
              <h1 className="font-display text-base font-bold tracking-tight text-[#111827] flex items-center gap-1.5">
                <span className="text-[#DC2626]">TV-TASKVERIFY</span>
              </h1>
            </div>
            <span className="hidden lg:inline-block text-[11px] font-mono text-[#6B7280] border-l border-gray-200 pl-3">
              Autosave Compliance & Master Control
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            {cloudUser ? (
              <div className="hidden sm:flex items-center gap-2 text-xs font-mono bg-[#F9FAFB] border border-[#E5E7EB] px-3 py-1.5 rounded-[4px]">
                <Cloud className="h-3.5 w-3.5 text-emerald-600" />
                <span className="text-emerald-700 font-medium">Cloud Active</span>
                <span className="text-[#9CA3AF]">·</span>
                <span className="text-[#4B5563] truncate max-w-[160px]">{cloudUser.email}</span>
                <button
                  onClick={handleGoogleSignOut}
                  disabled={cloudAuthBusy}
                  className="text-[10px] text-red-600 hover:text-red-700 hover:underline ml-2"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={handleGoogleSignIn}
                disabled={cloudAuthBusy}
                className="inline-flex items-center gap-1.5 bg-white border border-red-200 hover:border-red-500 px-3 py-1.5 rounded-[4px] text-xs font-mono text-[#DC2626] hover:bg-red-50 transition-all shadow-xs"
              >
                <CloudOff className="h-3.5 w-3.5 text-[#DC2626]" />
                {cloudAuthBusy ? 'Connecting…' : 'Connect Cloud Firestore'}
              </button>
            )}

            {canOperate && (
              <>
                <button
                  onClick={() => {
                    setActiveNav('channels');
                    setOpenAddChannelSignal((n) => n + 1);
                  }}
                  className="inline-flex items-center gap-1.5 bg-white border border-gray-300 hover:border-red-400 px-3 py-1.5 rounded-[4px] text-xs font-medium text-gray-700 hover:text-red-600 transition-colors shadow-xs"
                >
                  <Plus className="h-3.5 w-3.5 text-red-600" />
                  Add Channel
                </button>

                <button
                  onClick={handleRunQaNow}
                  disabled={qaRunning}
                  className="inline-flex items-center gap-1.5 bg-[#DC2626] hover:bg-[#B91C1C] px-3.5 py-1.5 rounded-[4px] text-xs font-medium text-white shadow-xs hover:shadow-sm transition-all font-mono"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  {qaRunning ? 'Running QA…' : 'Run QA Scan'}
                </button>
              </>
            )}

            <div className="flex items-center gap-2 border-l border-gray-200 pl-2.5">
              <div className="hidden md:flex flex-col items-end leading-tight">
                <span className="text-xs font-medium text-[#111827]">{user.fullName}</span>
                <span className="font-mono text-[10px] text-[#6B7280]">
                  @{user.username} · {user.role}
                </span>
              </div>
              <button
                onClick={handleOperatorLogout}
                title="Sign Out"
                className="inline-flex items-center gap-1.5 bg-white border border-gray-300 hover:border-red-400 px-2.5 py-1.5 rounded-[4px] text-xs font-medium text-gray-700 hover:text-red-600 transition-colors shadow-xs"
              >
                <LogOut className="h-3.5 w-3.5 text-red-600" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </div>
          </div>
        </div>

        {/* Horizontal Red & White Navigation Strip */}
        <nav className="flex items-center gap-1 overflow-x-auto pb-1 no-scrollbar border-t border-gray-100 pt-2">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNavigate(item.id)}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-[4px] text-xs font-medium whitespace-nowrap transition-all ${
                  active
                    ? 'bg-[#DC2626] text-white shadow-xs font-semibold'
                    : 'bg-white border border-gray-200 text-gray-600 hover:text-[#DC2626] hover:border-red-200 hover:bg-red-50/40'
                }`}
              >
                <Icon className={`h-3.5 w-3.5 ${active ? 'text-white' : 'text-red-600'}`} />
                <span>{item.label}</span>
                {item.id === 'channels' && cloudChannels.length > 0 && (
                  <span className={`font-mono text-[10px] px-1.5 py-0.2 rounded ${active ? 'bg-black/20 text-white' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                    {cloudChannels.length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </header>

      {/* Active Module Viewport */}
      <main className="flex-1 p-6 lg:p-8 max-w-[1500px] w-full mx-auto">
        {cloudAuthNotice && (
          <div className="mb-4 rounded-[4px] border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 flex items-center justify-between gap-3">
            <span>{cloudAuthNotice}</span>
            <button
              type="button"
              onClick={() => setCloudAuthNotice(null)}
              className="text-[11px] font-medium underline"
            >
              Dismiss
            </button>
          </div>
        )}
        {activeNav === 'dashboard' && (
          <DashboardView
            refreshKey={refreshKey}
            onNavigate={handleNavigate}
            onOpenEntryInChannelViewer={handleOpenEntryInChannelViewer}
            onRunQaNow={handleRunQaNow}
            qaRunning={qaRunning}
          />
        )}
        {activeNav === 'channels' && (
          <ChannelViewerView
            refreshKey={refreshKey}
            initialChannelKey={viewerChannelKey}
            initialDate={viewerDate}
            highlightEntryId={viewerHighlightId}
            openAddChannelSignal={openAddChannelSignal}
            cloudUser={cloudUser}
            cloudChannels={cloudChannels}
            cloudAuthBusy={cloudAuthBusy}
            onSignInGoogle={handleGoogleSignIn}
            onSelectEntry={(id) => setDrawerEntryId(id)}
            onNavigate={handleNavigate}
            onChannelsUpdated={triggerRefresh}
          />
        )}
        {activeNav === 'import' && (
          <ImportAutosaveView onImportCompleted={triggerRefresh} onNavigate={handleNavigate} />
        )}
        {activeNav === 'entries' && (
          <AllEntriesView
            refreshKey={refreshKey}
            onSelectEntry={(id) => setDrawerEntryId(id)}
            onEntriesUpdated={triggerRefresh}
          />
        )}
        {activeNav === 'auto-qa' && (
          <AutomaticQaView
            refreshKey={refreshKey}
            onQaCompleted={triggerRefresh}
            onNavigate={handleNavigate}
          />
        )}
        {activeNav === 'qa-results' && (
          <QaResultsView
            refreshKey={refreshKey}
            onOpenEntryInChannelViewer={handleOpenEntryInChannelViewer}
            onResolutionUpdated={triggerRefresh}
          />
        )}
        {activeNav === 'reports' && <ReportsView refreshKey={refreshKey} />}
        {activeNav === 'history' && <ImportHistoryView refreshKey={refreshKey} />}
        {activeNav === 'backup' && (
          <BackupRestoreView refreshKey={refreshKey} onDatabaseRestored={triggerRefresh} />
        )}
        {activeNav === 'settings' && <SettingsView />}
      </main>

      {/* Entry Inspector & Editor Drawer */}
      <EntryDetailDrawer
        entryId={drawerEntryId}
        onClose={() => setDrawerEntryId(null)}
        onEntryUpdated={triggerRefresh}
      />
    </div>
  );
}
