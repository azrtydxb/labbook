import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './db/index.js';
import { forbidden, HttpError, unauthorized } from './errors.js';

export const SESSION_COOKIE = 'labbook_session';
/** Header the web app sends on every write; a cross-site form cannot set it. */
export const CSRF_HEADER = 'x-requested-with';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    authMethod: 'session' | 'token' | null;
    tokenId: string | null;
  }
}

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function newApiToken(): { token: string; hash: string; prefix: string } {
  const token = `lbk_${randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token), prefix: token.slice(0, 12) };
}

export function newSessionToken(): { token: string; id: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, id: sha256(token) };
}

const PUBLIC_API = new Set(['POST /api/v1/auth/login', 'GET /api/v1/health']);

/** Resolve the caller from a bearer token or the session cookie. */
export function registerAuth(app: FastifyInstance, db: Database): void {
  app.decorateRequest('user', null);
  app.decorateRequest('authMethod', null);
  app.decorateRequest('tokenId', null);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const path = req.url.split('?')[0] ?? '';
    const isApi = path.startsWith('/api/v1/');
    if (!isApi) return;

    const authz = req.headers.authorization;
    if (authz?.toLowerCase().startsWith('bearer ')) {
      const token = authz.slice(7).trim();
      const row = await db
        .selectFrom('api_tokens as t')
        .innerJoin('users as u', 'u.id', 't.user_id')
        .select(['t.id as token_id', 'u.id', 'u.username', 'u.display_name', 'u.role', 'u.disabled'])
        .where('t.token_hash', '=', sha256(token))
        .where('t.revoked_at', 'is', null)
        .executeTakeFirst();
      if (!row || row.disabled) throw unauthorized('invalid or revoked API token');
      req.user = { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
      req.authMethod = 'token';
      req.tokenId = row.token_id;
      // Best effort; a failure here must not fail the request.
      void db
        .updateTable('api_tokens')
        .set({ last_used_at: new Date() })
        .where('id', '=', row.token_id)
        .execute()
        .catch(() => undefined);
      return;
    }

    const cookie = req.cookies?.[SESSION_COOKIE];
    if (cookie) {
      const row = await db
        .selectFrom('sessions as s')
        .innerJoin('users as u', 'u.id', 's.user_id')
        .select(['u.id', 'u.username', 'u.display_name', 'u.role', 'u.disabled', 's.expires_at'])
        .where('s.id', '=', sha256(cookie))
        .executeTakeFirst();
      if (row && !row.disabled && row.expires_at > new Date()) {
        req.user = { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
        req.authMethod = 'session';
      }
    }

    const route = `${req.method} ${path}`;
    if (!req.user) {
      if (PUBLIC_API.has(route)) return;
      throw unauthorized();
    }
    // CSRF: cookie-authenticated writes must carry the custom header (SameSite=Lax
    // already blocks cross-site POSTs; this also covers same-site subdomains).
    const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    if (req.authMethod === 'session' && !safe && req.headers[CSRF_HEADER] !== 'labbook') {
      throw new HttpError(403, `missing ${CSRF_HEADER}: labbook header`);
    }
  });
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireAdmin(req: FastifyRequest): AuthUser {
  const u = requireUser(req);
  if (u.role !== 'admin') throw forbidden('admin role required');
  return u;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  ttlHours: number,
  secure: boolean,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: ttlHours * 3600,
  });
}

/** Seed the first admin from the environment when the users table is empty. */
export async function seedAdmin(
  db: Database,
  username: string | undefined,
  password: string | undefined,
): Promise<'created' | 'exists' | 'skipped'> {
  if (!username || !password) return 'skipped';
  const any = await db.selectFrom('users').select('id').limit(1).executeTakeFirst();
  if (any) return 'exists';
  await db
    .insertInto('users')
    .values({
      username: username.toLowerCase(),
      display_name: 'Administrator',
      password_hash: await hashPassword(password),
      role: 'admin',
    })
    .execute();
  return 'created';
}
