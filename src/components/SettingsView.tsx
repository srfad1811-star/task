import { useEffect, useState } from 'react';
import { Plus, Save, Trash2, Users, Shield } from 'lucide-react';
import type { CustomFieldMapping, QaThresholds } from '../types.ts';
import { getAuthHeaders } from '../lib/apiAuth.ts';

const CANONICAL_FIELDS = [
  'MasterEntryID',
  'segmentDetailID',
  'startIndex',
  'endIndex',
  'DiffInIndex',
  'startTime',
  'endTime',
  'Duration',
  'channelID',
  'channelName',
  'transDate',
  'captionID',
  'captionName',
  'brandName',
  'FilePath',
  'EntryType',
  'videoClipID',
  'startFrame',
  'endFrame',
  'txt',
  'startTime_tts',
  'endTime_tts',
  'categoryName',
  'subcategoryName',
  'categoryID',
  'subcategoryID',
  'brandID',
  'commercialTypeID',
  'Action',
  'commercialID',
  'videoFileName',
  'leftAdjust',
  'rightAdjust',
  'qualityID',
  'matchValue',
  'fdb',
  'isBenchMarked',
  'companyName',
  'customDuration',
  'commercialTypeName',
  'MatchCoverage',
  'SourceDuration',
];

interface UserItem {
  id: string;
  username: string;
  full_name: string;
  role: string;
  is_active: number;
  created_at: string;
}

export function SettingsView() {
  const [thresholds, setThresholds] = useState<QaThresholds | null>(null);
  const [mappings, setMappings] = useState<CustomFieldMapping[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [newSourceTag, setNewSourceTag] = useState('');
  const [newCanonical, setNewCanonical] = useState('channelName');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // New user form
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newRole, setNewRole] = useState('OPERATOR');
  const [userMsg, setUserMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings', { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((data) => {
        setThresholds(data.qaThresholds);
        setMappings(data.customFieldMappings ?? []);
      });
    loadUsers();
  }, []);

  function loadUsers() {
    fetch('/api/users', { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setUsers(Array.isArray(data) ? data : []));
  }

  async function handleSave() {
    if (!thresholds) return;
    setSaving(true);
    setSavedMsg(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          qaThresholds: thresholds,
          customFieldMappings: mappings,
        }),
      });
      const data = await res.json();
      setThresholds(data.qaThresholds);
      setMappings(data.customFieldMappings ?? []);
      setSavedMsg('Settings and custom XML field mappings saved to central database.');
    } finally {
      setSaving(false);
    }
  }

  function handleAddMapping() {
    const tag = newSourceTag.trim();
    if (!tag) return;
    if (mappings.some((m) => m.sourceTag.toLowerCase() === tag.toLowerCase())) return;
    setMappings([...mappings, { sourceTag: tag, canonicalField: newCanonical }]);
    setNewSourceTag('');
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setUserMsg(null);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          fullName: newFullName,
          role: newRole,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create user');
      setUserMsg('User account created successfully.');
      setNewUsername('');
      setNewPassword('');
      setNewFullName('');
      loadUsers();
    } catch (err) {
      setUserMsg(err instanceof Error ? err.message : 'User creation failed');
    }
  }

  async function handleToggleActive(user: UserItem) {
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ isActive: user.is_active === 1 ? false : true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUserMsg(data.error || 'Failed to update user status.');
      }
      loadUsers();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleDeleteUser(id: string) {
    if (!confirm('Are you sure you want to delete this user?')) return;
    try {
      const res = await fetch(`/api/users/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUserMsg(data.error || 'Failed to delete user.');
      }
      loadUsers();
    } catch (err) {
      console.error(err);
    }
  }

  if (!thresholds) {
    return <div className="p-6 text-xs text-[#78716C]">Loading settings…</div>;
  }

  const numField = (key: keyof QaThresholds, label: string, step = '1') => (
    <div key={key}>
      <label className="block text-xs font-medium text-[#57534E] mb-1">{label}</label>
      <input
        type="number"
        step={step}
        value={Number(thresholds[key])}
        onChange={(e) => setThresholds({ ...thresholds, [key]: Number(e.target.value) })}
        className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-1.5 text-xs font-mono text-[#141413]"
      />
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Centralized User & Permission Management */}
      <div className="rounded border border-[#E5E2DC] bg-white p-6 space-y-5">
        <div className="flex items-center justify-between border-b border-[#E5E2DC] pb-4">
          <div>
            <h2 className="text-base font-semibold text-[#141413] flex items-center gap-2">
              <Users className="h-5 w-5 text-[#C83A1B]" /> Centralized User & Permission Management
            </h2>
            <p className="mt-1 text-xs text-[#57534E]">
              Manage Super Admin, Admin, Operator, and Viewer accounts across desktop and web Chrome clients.
            </p>
          </div>
        </div>

        {userMsg && (
          <div className="rounded border border-[#BBF7D0] bg-[#F0FDF4] px-4 py-2 text-xs font-medium text-[#15803D]">
            {userMsg}
          </div>
        )}

        {/* Create User Form */}
        <form onSubmit={handleCreateUser} className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end bg-[#FCFBF9] p-4 rounded border border-[#E5E2DC]">
          <div>
            <label className="block text-[11px] font-medium text-[#57534E] mb-1">Username</label>
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="operator1"
              className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-1.5 text-xs text-[#141413]"
              required
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-[#57534E] mb-1">Full Name</label>
            <input
              type="text"
              value={newFullName}
              onChange={(e) => setNewFullName(e.target.value)}
              placeholder="John Doe"
              className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-1.5 text-xs text-[#141413]"
              required
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-[#57534E] mb-1">Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-1.5 text-xs text-[#141413]"
              required
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-[#57534E] mb-1">Role & Permissions</label>
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              className="w-full rounded border border-[#D4CFC5] bg-white px-3 py-1.5 text-xs text-[#141413]"
            >
              <option value="SUPER_ADMIN">Super Admin (Full Access)</option>
              <option value="ADMIN">Admin (Management)</option>
              <option value="OPERATOR">Operator (Import & QA)</option>
              <option value="VIEWER">Viewer (Channels, QA Results & Reports)</option>
            </select>
          </div>
          <div>
            <button
              type="submit"
              className="w-full inline-flex items-center justify-center gap-1.5 rounded bg-[#141413] px-4 py-2 text-xs font-medium text-white hover:bg-[#2A2927]"
            >
              <Plus className="h-3.5 w-3.5" /> Add User
            </button>
          </div>
        </form>

        {/* Users Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#E5E2DC] bg-[#FCFBF9] text-[11px] font-semibold text-[#57534E]">
              <tr>
                <th className="px-4 py-2.5">Username</th>
                <th className="px-4 py-2.5">Full Name</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E2DC]">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-[#FCFBF9]">
                  <td className="px-4 py-2.5 font-mono font-medium text-[#141413]">{u.username}</td>
                  <td className="px-4 py-2.5 text-[#141413]">{u.full_name}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1 rounded bg-[#F4F2ED] px-2 py-0.5 text-[10px] font-semibold text-[#141413] border border-[#E5E2DC]">
                      <Shield className="h-3 w-3 text-[#C83A1B]" /> {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold ${
                        u.is_active === 1
                          ? 'bg-[#F0FDF4] text-[#15803D] border border-[#BBF7D0]'
                          : 'bg-red-50 text-red-700 border border-red-200'
                      }`}
                    >
                      {u.is_active === 1 ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right space-x-2">
                    <button
                      onClick={() => handleToggleActive(u)}
                      className="text-[#57534E] hover:text-[#141413] font-medium"
                    >
                      {u.is_active === 1 ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => handleDeleteUser(u.id)}
                      className="text-red-600 hover:text-red-800 font-medium"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* QA Thresholds */}
      <div className="rounded border border-[#E5E2DC] bg-white p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E2DC] pb-4">
          <div>
            <h2 className="text-base font-semibold text-[#141413]">QA Engine Rules & Thresholds</h2>
            <p className="mt-1 text-xs text-[#57534E]">
              Configure tolerance windows for timeline gaps, overlaps, duration mismatches, and entry type bounds.
            </p>
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded bg-[#141413] px-4 py-2 text-xs font-medium text-white hover:bg-[#2A2927] disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>

        {savedMsg && (
          <div className="rounded border border-[#BBF7D0] bg-[#F0FDF4] px-4 py-2.5 text-xs font-medium text-[#15803D]">
            {savedMsg}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {numField('gapThresholdSeconds', 'Gap Detection Threshold (sec)', '0.5')}
          {numField('overlapToleranceSeconds', 'Strict Overlap Threshold (sec)', '0.5')}
          {numField('durationToleranceStrictSeconds', 'Duration Mismatch RED (sec)', '0.5')}
          {numField('durationToleranceWarnSeconds', 'Duration Variance YELLOW (sec)', '0.5')}
          {numField('duplicateWindowSeconds', 'Consecutive Duplicate Window (sec)')}
          {numField('minAdDurationSeconds', 'Min SPOT/TVC Duration (sec)')}
          {numField('maxAdDurationSeconds', 'Max SPOT/TVC Duration (sec)')}
          {numField('minProgramDurationSeconds', 'Min PROGRAM Duration (sec)')}
          {numField('maxProgramDurationSeconds', 'Max PROGRAM Duration (sec)')}
          {numField('minPromoDurationSeconds', 'Min MEDIA Duration (sec)')}
          {numField('maxPromoDurationSeconds', 'Max MEDIA Duration (sec)')}
          {numField('minSpnDurationSeconds', 'Min SPONSORSHIP Duration (sec)')}
          {numField('maxSpnDurationSeconds', 'Max SPONSORSHIP Duration (sec)')}
          {numField('minMatchCoverage', 'Min MatchCoverage (%)')}
          {numField('defaultFps', 'Default Frame Rate (FPS)')}
          <div className="flex items-end pb-1.5">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-[#141413] cursor-pointer">
              <input
                type="checkbox"
                checked={thresholds.autoBackupBeforeImport}
                onChange={(e) =>
                  setThresholds({ ...thresholds, autoBackupBeforeImport: e.target.checked })
                }
                className="rounded border-[#D4CFC5]"
              />
              Auto-backup SQLite before every import
            </label>
          </div>
        </div>
      </div>

      {/* Custom XML Field Mapping Overrides */}
      <div className="rounded border border-[#E5E2DC] bg-white p-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-[#141413]">Custom XML Field Mapping Overrides</h3>
          <p className="mt-1 text-xs text-[#57534E]">
            If the Pre-Import XML Inspector reports unmapped XML tags in your office autosave files, map those exact XML tag names to canonical broadcast fields here before importing.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newSourceTag}
            onChange={(e) => setNewSourceTag(e.target.value)}
            placeholder="Source XML tag (e.g. Ch_Title)"
            className="rounded border border-[#D4CFC5] bg-white px-3 py-1.5 text-xs font-mono text-[#141413] w-56"
          />
          <span className="text-xs text-[#8A847C]">→</span>
          <select
            value={newCanonical}
            onChange={(e) => setNewCanonical(e.target.value)}
            className="rounded border border-[#D4CFC5] bg-white px-3 py-1.5 text-xs font-mono text-[#141413]"
          >
            {CANONICAL_FIELDS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <button
            onClick={handleAddMapping}
            className="inline-flex items-center gap-1 rounded border border-[#D4CFC5] bg-[#FCFBF9] px-3 py-1.5 text-xs font-medium text-[#141413] hover:bg-[#F4F2ED]"
          >
            <Plus className="h-3.5 w-3.5" /> Add Mapping
          </button>
        </div>

        {mappings.length > 0 && (
          <div className="rounded border border-[#E5E2DC] divide-y divide-[#E5E2DC]">
            {mappings.map((m, idx) => (
              <div key={`${m.sourceTag}_${idx}`} className="flex items-center justify-between px-4 py-2 text-xs">
                <span className="font-mono text-[#141413]">
                  {m.sourceTag} → <strong>{m.canonicalField}</strong>
                </span>
                <button
                  onClick={() => setMappings(mappings.filter((_, i) => i !== idx))}
                  className="text-[#8A847C] hover:text-[#B91C1C]"
                  title="Remove mapping"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cloud & Windows Desktop Deployment Instructions */}
      <div className="rounded border border-[#E5E2DC] bg-white p-6 space-y-3">
        <h3 className="text-sm font-semibold text-[#141413]">
          Cloud Deployment & Centralized Multi-User Synchronization Guide
        </h3>
        <p className="text-xs text-[#57534E] leading-relaxed">
          To host this platform on a secure cloud server (AWS, GCP Cloud Run, or Azure) accessible worldwide via Chrome:
        </p>
        <ol className="list-decimal list-inside text-xs text-[#57534E] space-y-1">
          <li>Deploy the Node.js backend container or process with SQLite persistent disk mount (`/app/applet/data`).</li>
          <li>Configure domain name and SSL/TLS certificate via Nginx reverse proxy.</li>
          <li>Log in as Super Admin to provision user accounts and assign granular permissions.</li>
        </ol>
      </div>
    </div>
  );
}
