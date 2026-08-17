import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PASSWORD_KEYLEN = 32;
const COOKIE_NAME = 'aster_session';

function b64(value) {
  return Buffer.from(value).toString('base64url');
}

function parseCookie(header = '') {
  return Object.fromEntries(String(header).split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([key, value]) => key && value));
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const derived = scryptSync(String(password), salt, PASSWORD_KEYLEN, { N: 16_384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${derived.toString('base64url')}`;
}

function verifyPassword(password, encoded) {
  const [scheme, n, r, p, salt, expected] = String(encoded || '').split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !expected) return false;
  try {
    const actual = scryptSync(String(password), salt, PASSWORD_KEYLEN, { N: Number(n), r: Number(r), p: Number(p) });
    const target = Buffer.from(expected, 'base64url');
    return actual.length === target.length && timingSafeEqual(actual, target);
  } catch { return false; }
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  constructor(pool, secret) {
    this.pool = pool;
    this.secret = String(secret || '');
    this.sessions = new Map();
    this.failures = new Map();
  }

  async login(username, password, attemptKey = 'unknown') {
    const now = Date.now();
    const failure = this.failures.get(attemptKey);
    if (failure && failure.count >= 8 && failure.until > now) return null;
    const [rows] = await this.pool.execute(
      `SELECT c.username, c.password_hash, u.id, u.tenant_id, u.display_name, u.role
       FROM user_credentials c JOIN users u ON u.id=c.user_id
       WHERE c.username=? AND u.status='active' AND u.tenant_id IS NOT NULL LIMIT 1`,
      [String(username || '').trim().slice(0, 120)],
    );
    const row = rows[0];
    if (!row || !verifyPassword(password, row.password_hash)) {
      const next = failure?.count + 1 || 1;
      this.failures.set(attemptKey, { count: next, until: next >= 8 ? now + 5 * 60 * 1000 : now + 60 * 1000 });
      return null;
    }
    this.failures.delete(attemptKey);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + SESSION_TTL_MS;
    const principal = { tenantId: String(row.tenant_id), userId: String(row.id), role: String(row.role) };
    this.sessions.set(tokenHash(token), { principal, user: { username: row.username, displayName: row.display_name, role: row.role }, expiresAt });
    await this.pool.execute('UPDATE user_credentials SET last_login_at=UTC_TIMESTAMP(3) WHERE username=?', [row.username]);
    return { token, expiresAt, user: { username: row.username, displayName: row.display_name, role: row.role } };
  }

  principalFrom(req) {
    const token = parseCookie(req.headers.cookie || '')[COOKIE_NAME];
    if (!token) return null;
    const session = this.sessions.get(tokenHash(token));
    if (!session) return null;
    if (session.expiresAt <= Date.now()) { this.sessions.delete(tokenHash(token)); return null; }
    return session.principal;
  }

  userFrom(req) {
    const token = parseCookie(req.headers.cookie || '')[COOKIE_NAME];
    const session = token ? this.sessions.get(tokenHash(token)) : null;
    if (!session || session.expiresAt <= Date.now()) return null;
    return session.user;
  }

  logout(req) {
    const token = parseCookie(req.headers.cookie || '')[COOKIE_NAME];
    if (token) this.sessions.delete(tokenHash(token));
  }

  cookie(token, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }

  clearCookie() {
    return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }
}
