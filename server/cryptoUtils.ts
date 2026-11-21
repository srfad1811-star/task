import crypto from 'node:crypto';

const MASTER_SECRET_RAW =
  process.env.STORAGE_ENCRYPTION_KEY ||
  process.env.SESSION_SECRET ||
  'broadcastqa-studio-default-local-key-change-in-production';

const AES_KEY = crypto.createHash('sha256').update(MASTER_SECRET_RAW).digest();

export function encryptSecret(plainText: string): string {
  if (!plainText) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(cipherText: string | null | undefined): string {
  if (!cipherText) return '';
  if (!cipherText.startsWith('enc:v1:')) {
    return cipherText;
  }
  try {
    const [, , ivHex, tagHex, dataHex] = cipherText.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', AES_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

export function maskSecret(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length <= 6) return '••••••';
  return `${value.slice(0, 3)}••••••${value.slice(-3)}`;
}

export function signPlaybackToken(archiveId: string, expiresAtEpochSec: number): string {
  return crypto
    .createHmac('sha256', AES_KEY)
    .update(`playback:${archiveId}:${expiresAtEpochSec}`)
    .digest('hex');
}

export function verifyPlaybackToken(
  archiveId: string,
  expiresAtEpochSec: number,
  token: string
): boolean {
  if (!token || !Number.isFinite(expiresAtEpochSec)) return false;
  if (Math.floor(Date.now() / 1000) > expiresAtEpochSec) return false;
  const expected = signPlaybackToken(archiveId, expiresAtEpochSec);
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export interface SignedSessionClaims {
  id: string;
  username: string;
  fullName: string;
  role: string;
  exp: number;
}

export function signStatelessSessionToken(claims: SignedSessionClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const nonce = crypto.randomBytes(12).toString('hex');
  const body = `v1.${nonce}.${payload}`;
  const sig = crypto.createHmac('sha256', AES_KEY).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyStatelessSessionToken(token: string): SignedSessionClaims | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const body = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const sig = parts[3];
  if (!sig) return null;
  const expectedSig = crypto.createHmac('sha256', AES_KEY).update(body).digest('base64url');
  const bufSig = Buffer.from(sig, 'utf8');
  const bufExpected = Buffer.from(expectedSig, 'utf8');
  if (bufSig.length !== bufExpected.length || !crypto.timingSafeEqual(bufSig, bufExpected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(parts[2], 'base64url').toString('utf8')) as SignedSessionClaims;
    if (!parsed?.id || !parsed?.username || !parsed?.role || typeof parsed.exp !== 'number') {
      return null;
    }
    if (parsed.exp <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function sha256FileBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function redactStreamCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : '';
      parsed.password = parsed.password ? '***' : '';
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/token|key|pass|secret|auth|sig/i.test(key)) {
        parsed.searchParams.set(key, '***');
      }
    }
    return parsed.toString();
  } catch {
    return url.replace(/(token|key|pass|secret|auth)=([^&\s]+)/gi, '$1=***');
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string | null | undefined): boolean {
  if (!password || !storedHash || !storedHash.startsWith('scrypt$')) {
    return false;
  }
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function safeTimingEqualText(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifySha256Digest(plainInput: string, expectedHex: string): boolean {
  if (!plainInput || !expectedHex) return false;
  const actual = crypto.createHash('sha256').update(plainInput, 'utf8').digest();
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}


