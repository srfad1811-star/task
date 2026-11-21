import express, { type NextFunction, type Request, type Response } from 'express';
import { getDb, logAudit } from './db.ts';
import {
  hashPassword,
  safeTimingEqualText,
  signStatelessSessionToken,
  verifyPassword,
  verifySha256Digest,
  verifyStatelessSessionToken,
} from './cryptoUtils.ts';

const DEFAULT_ACCESS_CODE_SHA256 = '52b7032b03051452e554bf6ca225666c2f8ee743e613f7489301c68dcb3ec6e2';

function verifyAccessCode(submittedCode: string): boolean {
  const clean = submittedCode.trim();
  if (!clean) return false;
  const envCode = process.env.ACCESS_CODE?.trim();
  if (envCode) {
    return safeTimingEqualText(clean, envCode);
  }
  return verifySha256Digest(clean, DEFAULT_ACCESS_CODE_SHA256);
}

const router = express.Router();
const IS_VERCEL = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);

export interface SessionUser {
  id: string;
  username: string;
  fullName: string;
  role: string;
}

export interface AuthenticatedRequest extends Request {
  authUser?: SessionUser;
  authToken?: string;
}

const VALID_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'OPERATOR', 'VIEWER']);
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;

function createSessionForUser(user: SessionUser): string {
  const db = getDb();
  const now = new Date();
  const expiresMs = now.getTime() + 7 * 24 * 3600 * 1000;
  const expires = new Date(expiresMs);
  const token = signStatelessSessionToken({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    exp: expiresMs,
  });
  db.prepare(
    `INSERT INTO auth_sessions (token, user_id, username, role, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(token, user.id, user.username, user.role, now.toISOString(), expires.toISOString());
  return token;
}

export function resolveSessionUser(req: Request): { user: SessionUser; token: string } | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice(7).trim();
  if (!token) return null;

  const db = getDb();
  const sess = db
    .prepare(
      `SELECT s.user_id, u.username, u.full_name, u.role, s.expires_at
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND u.is_active = 1`
    )
    .get(token) as
    | {
        user_id: string;
        username: string;
        full_name: string;
        role: string;
        expires_at: string;
      }
    | undefined;

  if (sess) {
    if (new Date(sess.expires_at).getTime() <= Date.now()) {
      db.prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(token);
      return null;
    }

    return {
      token,
      user: {
        id: sess.user_id,
        username: sess.username,
        fullName: sess.full_name,
        role: sess.role,
      },
    };
  }

  // On Vercel serverless cold starts, /tmp SQLite may be fresh without the warm session row
  if (IS_VERCEL) {
    const claims = verifyStatelessSessionToken(token);
    if (claims) {
      return {
        token,
        user: {
          id: claims.id,
          username: claims.username,
          fullName: claims.fullName,
          role: claims.role,
        },
      };
    }
  }

  return null;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const resolved = resolveSessionUser(req);
  if (!resolved) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }
  req.authUser = resolved.user;
  req.authToken = resolved.token;
  next();
}

export function requireRole(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const resolved = resolveSessionUser(req);
    if (!resolved) {
      res.status(401).json({ error: 'Authentication required. Please sign in.' });
      return;
    }
    if (!allowedRoles.includes(resolved.user.role)) {
      res.status(403).json({ error: `Role "${resolved.user.role}" is not permitted for this action.` });
      return;
    }
    req.authUser = resolved.user;
    req.authToken = resolved.token;
    next();
  };
}

function getAdminSetupState() {
  const envAdminPassword = process.env.ADMIN_PASSWORD?.trim() || '';
  const adminRow = getDb()
    .prepare(
      `SELECT id, username, full_name, role, password_hash, is_active
       FROM users
       WHERE id = 'usr_admin' OR LOWER(username) = 'admin'
       LIMIT 1`
    )
    .get() as
    | {
        id: string;
        username: string;
        full_name: string;
        role: string;
        password_hash: string;
        is_active: number;
      }
    | undefined;

  const hasSavedHash = Boolean(adminRow?.password_hash && adminRow.password_hash.startsWith('scrypt$'));
  const needsAdminSetup = !envAdminPassword && !hasSavedHash;
  return {
    adminRow,
    envAdminPassword,
    needsAdminSetup,
  };
}

// Public auth status check
router.get('/api/auth/status', (_req, res) => {
  const { adminRow, envAdminPassword } = getAdminSetupState();
  res.json({
    accessCodeMode: true,
    adminUsername: adminRow?.username ?? 'admin',
    adminIdReady: true,
    needsAdminSetup: false,
    envAdminConfigured: Boolean(envAdminPassword),
  });
});

// Single Access Code Unlock
router.post('/api/auth/code', (req, res) => {
  const { code } = (req.body ?? {}) as { code?: string };
  if (typeof code !== 'string' || !code.trim()) {
    res.status(400).json({ error: 'Access code is required.' });
    return;
  }

  if (!verifyAccessCode(code)) {
    res.status(401).json({ error: 'Invalid access code.' });
    return;
  }

  const db = getDb();
  const now = new Date().toISOString();
  let adminRow = db
    .prepare(
      `SELECT id, username, full_name, role
       FROM users
       WHERE id = 'usr_admin' OR LOWER(username) = 'admin'
       LIMIT 1`
    )
    .get() as { id: string; username: string; full_name: string; role: string } | undefined;

  if (!adminRow) {
    db.prepare(
      `INSERT INTO users (id, username, password_hash, full_name, role, is_active, created_at)
       VALUES ('usr_admin', 'admin', '', 'System Administrator', 'ADMIN', 1, ?)`
    ).run(now);
    adminRow = {
      id: 'usr_admin',
      username: 'admin',
      full_name: 'System Administrator',
      role: 'ADMIN',
    };
  } else {
    db.prepare(`UPDATE users SET is_active = 1 WHERE id = ?`).run(adminRow.id);
  }

  const sessionUser: SessionUser = {
    id: adminRow.id,
    username: adminRow.username,
    fullName: adminRow.full_name,
    role: adminRow.role,
  };
  const token = createSessionForUser(sessionUser);

  logAudit({
    entityType: 'USER',
    entityId: sessionUser.id,
    action: 'ACCESS_CODE_UNLOCK',
    notes: 'Workspace unlocked with station access code.',
  });

  res.json({
    sessionToken: token,
    user: sessionUser,
  });
});

// One-time Admin setup/claim route (locks itself once claimed or when ADMIN_PASSWORD env var is configured)
router.post('/api/auth/admin-setup', (req, res) => {
  const { password, fullName } = (req.body ?? {}) as { password?: string; fullName?: string };
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    res.status(400).json({ error: 'Admin password must be between 6 and 128 characters.' });
    return;
  }

  const { adminRow, envAdminPassword, needsAdminSetup } = getAdminSetupState();
  if (envAdminPassword || !needsAdminSetup) {
    res.status(409).json({ error: 'Admin account is already configured. Please sign in.' });
    return;
  }

  const db = getDb();
  const now = new Date().toISOString();
  const hash = hashPassword(password);
  const cleanName = typeof fullName === 'string' && fullName.trim() ? fullName.trim().slice(0, 80) : 'System Administrator';

  let sessionUser: SessionUser;
  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT id, password_hash FROM users WHERE id = 'usr_admin' OR LOWER(username) = 'admin' LIMIT 1`)
      .get() as { id: string; password_hash: string } | undefined;

    if (fresh && fresh.password_hash && fresh.password_hash.startsWith('scrypt$')) {
      throw new Error('ALREADY_CLAIMED');
    }

    if (fresh) {
      db.prepare(
        `UPDATE users SET password_hash = ?, full_name = ?, role = 'ADMIN', is_active = 1 WHERE id = ?`
      ).run(hash, cleanName, fresh.id);
      sessionUser = {
        id: fresh.id,
        username: adminRow?.username ?? 'admin',
        fullName: cleanName,
        role: 'ADMIN',
      };
    } else {
      db.prepare(
        `INSERT INTO users (id, username, password_hash, full_name, role, is_active, created_at)
         VALUES ('usr_admin', 'admin', ?, ?, 'ADMIN', 1, ?)`
      ).run(hash, cleanName, now);
      sessionUser = {
        id: 'usr_admin',
        username: 'admin',
        fullName: cleanName,
        role: 'ADMIN',
      };
    }
  });

  try {
    tx();
  } catch (err) {
    if (err instanceof Error && err.message === 'ALREADY_CLAIMED') {
      res.status(409).json({ error: 'Admin account is already configured. Please sign in.' });
      return;
    }
    res.status(500).json({ error: 'Failed to initialize admin account.' });
    return;
  }

  const token = createSessionForUser(sessionUser!);
  logAudit({
    entityType: 'USER',
    entityId: sessionUser!.id,
    action: 'ADMIN_PASSWORD_CLAIMED',
    notes: 'Initial administrator password configured and signed in.',
  });

  res.status(201).json({
    sessionToken: token,
    user: sessionUser!,
  });
});

// Public user registration (creates standard VIEWER account; Admin can promote role in Settings)
router.post('/api/auth/register', (req, res) => {
  const { username, password, fullName } = (req.body ?? {}) as {
    username?: string;
    password?: string;
    fullName?: string;
  };

  const cleanUsername = typeof username === 'string' ? username.trim() : '';
  const cleanFullName = typeof fullName === 'string' ? fullName.trim() : '';

  if (!USERNAME_PATTERN.test(cleanUsername)) {
    res.status(400).json({
      error: 'Username must be 3-32 characters (letters, numbers, dot, underscore, hyphen).',
    });
    return;
  }
  if (cleanUsername.toLowerCase() === 'admin') {
    res.status(409).json({ error: 'The "admin" username is reserved for the system administrator.' });
    return;
  }
  if (cleanFullName.length < 2 || cleanFullName.length > 80) {
    res.status(400).json({ error: 'Full name must be between 2 and 80 characters.' });
    return;
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    res.status(400).json({ error: 'Password must be between 6 and 128 characters.' });
    return;
  }

  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`)
    .get(cleanUsername) as { id: string } | undefined;
  if (existing) {
    res.status(409).json({ error: 'This username is already taken. Please choose another.' });
    return;
  }

  const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const passwordHash = hashPassword(password);
  const role = 'VIEWER';

  db.prepare(
    `INSERT INTO users (id, username, password_hash, full_name, role, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(id, cleanUsername, passwordHash, cleanFullName, role, now);

  const sessionUser: SessionUser = {
    id,
    username: cleanUsername,
    fullName: cleanFullName,
    role,
  };
  const token = createSessionForUser(sessionUser);

  logAudit({
    entityType: 'USER',
    entityId: id,
    action: 'USER_REGISTERED',
    notes: `New user ${cleanUsername} registered (${role})`,
  });

  res.status(201).json({
    sessionToken: token,
    user: sessionUser,
  });
});

// Auth / User Login (all roles)
router.post('/api/auth/login', (req, res) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    res.status(400).json({ error: 'Username and password required.' });
    return;
  }

  const cleanUsername = username.trim();
  const db = getDb();
  const user = db
    .prepare(`SELECT * FROM users WHERE LOWER(username) = LOWER(?) AND is_active = 1`)
    .get(cleanUsername) as
    | { id: string; username: string; password_hash: string; full_name: string; role: string }
    | undefined;

  if (!user) {
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }

  const envAdminPassword = process.env.ADMIN_PASSWORD?.trim() || '';
  const isAdminAccount = user.id === 'usr_admin' || user.username.toLowerCase() === 'admin';

  let authenticated = false;
  if (isAdminAccount && envAdminPassword) {
    authenticated = safeTimingEqualText(password, envAdminPassword);
  } else {
    if (isAdminAccount && (!user.password_hash || !user.password_hash.startsWith('scrypt$'))) {
      res.status(403).json({
        error: 'Admin password is not configured yet. Please complete First-Time Admin Setup.',
        needsAdminSetup: true,
      });
      return;
    }
    authenticated = verifyPassword(password, user.password_hash);
  }

  if (!authenticated) {
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }

  const sessionUser: SessionUser = {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
  };
  const token = createSessionForUser(sessionUser);

  logAudit({
    entityType: 'USER',
    entityId: user.id,
    action: 'USER_LOGIN',
    notes: `User ${user.username} (${user.role}) logged in successfully`,
  });

  res.json({
    sessionToken: token,
    user: sessionUser,
  });
});

router.post('/api/auth/logout', (req, res) => {
  const resolved = resolveSessionUser(req);
  if (resolved) {
    getDb().prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(resolved.token);
    logAudit({
      entityType: 'USER',
      entityId: resolved.user.id,
      action: 'USER_LOGOUT',
      notes: `User ${resolved.user.username} signed out`,
    });
  }
  res.json({ ok: true });
});

router.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.authUser });
});

// Admin-only User Management Routes
router.get('/api/users', requireRole(['ADMIN', 'SUPER_ADMIN']), (_req, res) => {
  const users = getDb()
    .prepare(`SELECT id, username, full_name, role, is_active, created_at FROM users ORDER BY username ASC`)
    .all();
  res.json(users);
});

router.post('/api/users', requireRole(['ADMIN', 'SUPER_ADMIN']), (req: AuthenticatedRequest, res) => {
  const { username, password, fullName, role } = (req.body ?? {}) as {
    username?: string;
    password?: string;
    fullName?: string;
    role?: string;
  };
  const cleanUsername = typeof username === 'string' ? username.trim() : '';
  const cleanFullName = typeof fullName === 'string' ? fullName.trim() : '';
  const targetRole = typeof role === 'string' && VALID_ROLES.has(role) ? role : 'OPERATOR';

  if (!USERNAME_PATTERN.test(cleanUsername)) {
    res.status(400).json({
      error: 'Username must be 3-32 characters (letters, numbers, dot, underscore, hyphen).',
    });
    return;
  }
  if (!cleanFullName || cleanFullName.length > 80) {
    res.status(400).json({ error: 'Full name is required (max 80 characters).' });
    return;
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    res.status(400).json({ error: 'Password must be between 6 and 128 characters.' });
    return;
  }
  if (targetRole === 'SUPER_ADMIN' && req.authUser?.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Only a Super Admin can create another Super Admin account.' });
    return;
  }

  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`)
    .get(cleanUsername) as { id: string } | undefined;
  if (existing) {
    res.status(409).json({ error: `Username "${cleanUsername}" already exists.` });
    return;
  }

  const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const passwordHash = hashPassword(password);
  db.prepare(
    `INSERT INTO users (id, username, password_hash, full_name, role, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(id, cleanUsername, passwordHash, cleanFullName, targetRole, new Date().toISOString());

  logAudit({
    entityType: 'USER',
    entityId: id,
    action: 'USER_CREATED',
    notes: `${cleanUsername} (${targetRole}) created by ${req.authUser?.username ?? 'admin'}`,
  });
  res.status(201).json({ ok: true, id });
});

router.patch('/api/users/:id', requireRole(['ADMIN', 'SUPER_ADMIN']), (req: AuthenticatedRequest, res) => {
  const { role, isActive, fullName, password } = (req.body ?? {}) as {
    role?: string;
    isActive?: boolean;
    fullName?: string;
    password?: string;
  };
  const db = getDb();
  const target = db
    .prepare(`SELECT id, username, role, is_active FROM users WHERE id = ?`)
    .get(req.params.id) as { id: string; username: string; role: string; is_active: number } | undefined;

  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  if (req.authUser?.id === target.id && isActive === false) {
    res.status(400).json({ error: 'You cannot deactivate your own active admin account.' });
    return;
  }

  let nextRole: string | null = null;
  if (role !== undefined) {
    if (!VALID_ROLES.has(role)) {
      res.status(400).json({ error: 'Invalid role specified.' });
      return;
    }
    if (role === 'SUPER_ADMIN' && req.authUser?.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Only a Super Admin can assign the SUPER_ADMIN role.' });
      return;
    }
    if (target.id === 'usr_admin' && role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
      res.status(400).json({ error: 'Primary admin account must retain ADMIN privileges.' });
      return;
    }
    nextRole = role;
  }

  let nextPasswordHash: string | null = null;
  if (password !== undefined && password !== '') {
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
      res.status(400).json({ error: 'New password must be between 6 and 128 characters.' });
      return;
    }
    nextPasswordHash = hashPassword(password);
  }

  db.prepare(
    `UPDATE users SET
       role = COALESCE(?, role),
       is_active = COALESCE(?, is_active),
       full_name = COALESCE(?, full_name),
       password_hash = COALESCE(?, password_hash)
     WHERE id = ?`
  ).run(
    nextRole,
    isActive !== undefined ? (isActive ? 1 : 0) : null,
    typeof fullName === 'string' && fullName.trim() ? fullName.trim().slice(0, 80) : null,
    nextPasswordHash,
    req.params.id
  );

  if (isActive === false) {
    db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(req.params.id);
  }

  logAudit({
    entityType: 'USER',
    entityId: req.params.id,
    action: 'USER_UPDATED',
    notes: `Updated user ${target.username} by ${req.authUser?.username ?? 'admin'}`,
  });
  res.json({ ok: true });
});

router.delete('/api/users/:id', requireRole(['ADMIN', 'SUPER_ADMIN']), (req: AuthenticatedRequest, res) => {
  const db = getDb();
  const target = db
    .prepare(`SELECT id, username FROM users WHERE id = ?`)
    .get(req.params.id) as { id: string; username: string } | undefined;

  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  if (target.id === 'usr_admin' || target.username.toLowerCase() === 'admin') {
    res.status(400).json({ error: 'Primary admin ID cannot be deleted.' });
    return;
  }
  if (target.id === req.authUser?.id) {
    res.status(400).json({ error: 'You cannot delete your currently signed-in account.' });
    return;
  }

  db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(req.params.id);
  logAudit({
    entityType: 'USER',
    entityId: req.params.id,
    action: 'USER_DELETED',
    notes: `Deleted user ${target.username}`,
  });
  res.json({ ok: true });
});

export default router;
