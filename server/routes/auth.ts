import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  hashPassword,
  newApiToken,
  newSessionToken,
  requireAdmin,
  requireUser,
  SESSION_COOKIE,
  setSessionCookie,
  sha256,
  verifyPassword,
} from '../auth.js';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from '../errors.js';
import { ApiTokenSchema, errors, OkSchema, UserListItemSchema, UserSchema } from '../schemas.js';

const failures = new Map<string, { n: number; until: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

const Password = z.string().min(10, 'at least 10 characters').max(200);
const Username = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, . _ -');

export function authRoutes(app: FastifyInstance, db: Database, cfg: Config): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/v1/health',
    {
      schema: {
        operationId: 'health',
        tags: ['meta'],
        summary: 'Liveness (no authentication)',
        security: [],
        response: { 200: OkSchema },
      },
    },
    async () => ({ ok: true }),
  );

  r.post(
    '/api/v1/auth/login',
    {
      schema: {
        operationId: 'login',
        tags: ['auth'],
        summary: 'Log in (web GUI); sets the httpOnly session cookie',
        description: 'Scripts and agents use a bearer API token instead.',
        security: [],
        body: z.object({ username: z.string().max(64), password: z.string().max(200) }),
        response: { 200: z.object({ user: UserSchema }), ...errors(429) },
      },
    },
    async (req, reply) => {
      const key = `${req.ip}|${req.body.username.toLowerCase()}`;
      const f = failures.get(key);
      if (f && f.n >= MAX_FAILURES && f.until > Date.now()) {
        throw new HttpError(429, 'too many failed logins; try again later');
      }
      const u = await db
        .selectFrom('users')
        .selectAll()
        .where('username', '=', req.body.username.toLowerCase())
        .executeTakeFirst();
      const ok = u && !u.disabled && (await verifyPassword(u.password_hash, req.body.password));
      if (!ok || !u) {
        const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + WINDOW_MS };
        cur.n += 1;
        failures.set(key, cur);
        throw unauthorized('invalid username or password');
      }
      failures.delete(key);
      const s = newSessionToken();
      await db
        .insertInto('sessions')
        .values({
          id: s.id,
          user_id: u.id,
          expires_at: new Date(Date.now() + cfg.sessionTtlHours * 3600_000),
        })
        .execute();
      await db.deleteFrom('sessions').where('expires_at', '<', new Date()).execute();
      setSessionCookie(reply, s.token, cfg.sessionTtlHours, req.protocol === 'https');
      return { user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role } };
    },
  );

  r.post(
    '/api/v1/auth/logout',
    { schema: { operationId: 'logout', tags: ['auth'], summary: 'Log out', response: { 200: OkSchema } } },
    async (req, reply) => {
      const c = req.cookies[SESSION_COOKIE];
      if (c) await db.deleteFrom('sessions').where('id', '=', sha256(c)).execute();
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );

  r.get(
    '/api/v1/auth/me',
    {
      schema: {
        operationId: 'whoami',
        tags: ['auth'],
        summary: 'The current user and how they authenticated',
        response: {
          200: z.object({ user: UserSchema, authMethod: z.enum(['session', 'token']).nullable() }),
          ...errors(),
        },
      },
    },
    async (req) => ({ user: requireUser(req), authMethod: req.authMethod }),
  );

  r.post(
    '/api/v1/auth/password',
    {
      schema: {
        operationId: 'changePassword',
        tags: ['auth'],
        summary: 'Change your own password',
        response: { 200: OkSchema, ...errors() },
        body: z.object({ currentPassword: z.string().max(200), newPassword: Password }),
      },
    },
    async (req) => {
      const me = requireUser(req);
      const u = await db.selectFrom('users').selectAll().where('id', '=', me.id).executeTakeFirstOrThrow();
      if (!(await verifyPassword(u.password_hash, req.body.currentPassword))) {
        throw badRequest('current password is wrong');
      }
      await db
        .updateTable('users')
        .set({ password_hash: await hashPassword(req.body.newPassword) })
        .where('id', '=', me.id)
        .execute();
      return { ok: true };
    },
  );

  // ---- users (admin) -------------------------------------------------------

  r.get(
    '/api/v1/users',
    {
      schema: {
        operationId: 'listUsers',
        tags: ['users'],
        summary: 'List users (admin)',
        response: { 200: z.object({ users: z.array(UserListItemSchema) }), ...errors(403) },
      },
    },
    async (req) => {
      requireAdmin(req);
      const rows = await db
        .selectFrom('users')
        .select(['id', 'username', 'display_name', 'role', 'disabled', 'created_at'])
        .orderBy('username')
        .execute();
      return {
        users: rows.map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.display_name,
          role: u.role,
          disabled: u.disabled,
          createdAt: u.created_at,
        })),
      };
    },
  );

  r.post(
    '/api/v1/users',
    {
      schema: {
        operationId: 'createUser',
        tags: ['users'],
        summary: 'Create a user (admin)',
        response: { 201: z.object({ id: z.uuid() }), ...errors(403, 409) },
        body: z.object({
          username: Username,
          displayName: z.string().max(200).default(''),
          password: Password,
          role: z.enum(['admin', 'member']).default('member'),
        }),
      },
    },
    async (req, reply) => {
      requireAdmin(req);
      const exists = await db
        .selectFrom('users')
        .select('id')
        .where('username', '=', req.body.username)
        .executeTakeFirst();
      if (exists) throw conflict('username taken');
      const u = await db
        .insertInto('users')
        .values({
          username: req.body.username,
          display_name: req.body.displayName,
          password_hash: await hashPassword(req.body.password),
          role: req.body.role,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      reply.code(201);
      return { id: u.id };
    },
  );

  r.patch(
    '/api/v1/users/:id',
    {
      schema: {
        operationId: 'updateUser',
        tags: ['users'],
        summary: 'Update a user: role, disabled, display name, password reset (admin)',
        response: { 200: OkSchema, ...errors(403, 404) },
        params: z.object({ id: z.uuid() }),
        body: z.object({
          displayName: z.string().max(200).optional(),
          role: z.enum(['admin', 'member']).optional(),
          disabled: z.boolean().optional(),
          password: Password.optional(),
        }),
      },
    },
    async (req) => {
      const me = requireAdmin(req);
      const u = await db.selectFrom('users').selectAll().where('id', '=', req.params.id).executeTakeFirst();
      if (!u) throw notFound('user not found');
      if (u.id === me.id && (req.body.role === 'member' || req.body.disabled === true)) {
        throw badRequest('you cannot demote or disable yourself');
      }
      await db
        .updateTable('users')
        .set({
          ...(req.body.displayName !== undefined ? { display_name: req.body.displayName } : {}),
          ...(req.body.role !== undefined ? { role: req.body.role } : {}),
          ...(req.body.disabled !== undefined ? { disabled: req.body.disabled } : {}),
          ...(req.body.password !== undefined
            ? { password_hash: await hashPassword(req.body.password) }
            : {}),
        })
        .where('id', '=', u.id)
        .execute();
      if (req.body.disabled || req.body.password) {
        await db.deleteFrom('sessions').where('user_id', '=', u.id).execute();
      }
      return { ok: true };
    },
  );

  // ---- API tokens ----------------------------------------------------------

  r.get(
    '/api/v1/tokens',
    {
      schema: {
        operationId: 'listTokens',
        tags: ['tokens'],
        summary: 'List API tokens (yours; admins may pass all=true)',
        response: { 200: z.object({ tokens: z.array(ApiTokenSchema) }), ...errors() },
        querystring: z.object({ all: z.enum(['true', 'false']).optional() }),
      },
    },
    async (req) => {
      const me = requireUser(req);
      let q = db
        .selectFrom('api_tokens as t')
        .innerJoin('users as u', 'u.id', 't.user_id')
        .select([
          't.id',
          't.name',
          't.prefix',
          't.created_at',
          't.last_used_at',
          't.revoked_at',
          'u.username',
          sql<number>`(select count(*) from runs r where r.token_id = t.id)`.as('runs'),
        ])
        .orderBy('t.created_at', 'desc');
      if (!(req.query.all === 'true' && me.role === 'admin')) q = q.where('t.user_id', '=', me.id);
      const rows = await q.execute();
      return {
        tokens: rows.map((t) => ({
          id: t.id,
          name: t.name,
          prefix: t.prefix,
          owner: t.username,
          createdAt: t.created_at,
          lastUsedAt: t.last_used_at,
          revokedAt: t.revoked_at,
          runs: Number(t.runs),
        })),
      };
    },
  );

  r.post(
    '/api/v1/tokens',
    {
      schema: {
        operationId: 'createToken',
        tags: ['tokens'],
        summary: 'Create an API token; the secret is returned once',
        description: 'Only from a web GUI session: a token cannot mint further tokens.',
        response: {
          201: z.object({ id: z.uuid(), name: z.string(), prefix: z.string(), token: z.string() }),
          ...errors(403),
        },
        body: z.object({ name: z.string().min(1).max(100) }),
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      if (req.authMethod !== 'session') throw forbidden('create tokens from the web GUI session');
      const t = newApiToken();
      const row = await db
        .insertInto('api_tokens')
        .values({ user_id: me.id, name: req.body.name, token_hash: t.hash, prefix: t.prefix })
        .returning('id')
        .executeTakeFirstOrThrow();
      reply.code(201);
      return { id: row.id, name: req.body.name, prefix: t.prefix, token: t.token };
    },
  );

  r.delete(
    '/api/v1/tokens/:id',
    {
      schema: {
        operationId: 'revokeToken',
        tags: ['tokens'],
        summary: 'Revoke an API token',
        params: z.object({ id: z.uuid() }),
        response: { 200: OkSchema, ...errors(404) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const t = await db
        .selectFrom('api_tokens')
        .selectAll()
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!t || (t.user_id !== me.id && me.role !== 'admin')) throw notFound('token not found');
      await db
        .updateTable('api_tokens')
        .set({ revoked_at: new Date() })
        .where('id', '=', t.id)
        .where('revoked_at', 'is', null)
        .execute();
      return { ok: true };
    },
  );
}
