// End-to-end API tests against a real Postgres (DATABASE_URL). CI provides one as a
// service container; the suite refuses to run silently without it.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app.js';
import { seedAdmin } from '../server/auth.js';
import { loadConfig } from '../server/config.js';
import { createDb, type Database } from '../server/db/index.js';
import { migrateToLatest } from '../server/db/migrations.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error('DATABASE_URL must be set in CI');

describe.skipIf(!url)('API', () => {
  let db: Database;
  let app: FastifyInstance;
  let cookie = '';
  let token = '';

  const asAdmin = (extra: Record<string, string> = {}) => ({
    cookie,
    'x-requested-with': 'labbook',
    ...extra,
  });
  const bearer = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    db = createDb(url!, 4);
    await sql`drop schema if exists public cascade; create schema public`.execute(db);
    await migrateToLatest(db);
    await seedAdmin(db, 'Admin', 'correct-horse-battery');
    const cfg = { ...loadConfig({ DATABASE_URL: url }), maxAttachmentBytes: 1024 * 1024 };
    app = await buildApp(db, cfg, { logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it('rejects anonymous API calls', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong password and accepts the seeded admin', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'nope' },
    });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    expect(ok.statusCode).toBe(200);
    const set = ok.cookies.find((c) => c.name === 'labbook_session');
    expect(set?.httpOnly).toBe(true);
    cookie = `labbook_session=${set!.value}`;
  });

  it('requires the CSRF header on cookie-authenticated writes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { cookie },
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates an API token and stores only its hash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: asAdmin(),
      payload: { name: 'ci' },
    });
    expect(res.statusCode).toBe(201);
    token = res.json().token;
    expect(token).toMatch(/^lbk_/);
    const rows = await db.selectFrom('api_tokens').select(['token_hash']).execute();
    expect(rows[0]!.token_hash).not.toContain(token);
  });

  it('defines a test type with PUT (idempotent)', async () => {
    const body = {
      name: 'Bench',
      tags: ['perf'],
      definition: {
        parameters: [{ key: 'model' }, { key: 'commit', identity: false }],
        dataPoints: [
          { key: 'tok_s', unit: 'tok/s', better: 'higher', bounds: { relMin: 0.97 } },
          { key: 'golden', type: 'boolean', bounds: { expected: true } },
        ],
      },
    };
    const a = await app.inject({
      method: 'PUT',
      url: '/api/v1/test-types/bench',
      headers: bearer(),
      payload: body,
    });
    expect(a.statusCode).toBe(201);
    const b = await app.inject({
      method: 'PUT',
      url: '/api/v1/test-types/bench',
      headers: bearer(),
      payload: body,
    });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ created: false, versionCreated: false, version: 1 });
  });

  it('refuses an incompatible schema change', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/test-types/bench',
      headers: bearer(),
      payload: { name: 'Bench', definition: { dataPoints: [{ key: 'tok_s', type: 'string' }] } },
    });
    expect(res.statusCode).toBe(400);
  });

  let firstId = '';
  it('submits runs, computes status against the previous comparable run', async () => {
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: bearer(),
      payload: {
        type: 'bench',
        externalId: 'r1',
        runAt: '2026-09-26T10:00:00Z',
        params: { model: 'llama', commit: 'aaa' },
        values: { tok_s: 770, golden: true },
        sets: ['chain-a'],
        attachments: [{ filename: 'bench.json', content: '{"ok":1}' }],
      },
    });
    expect(r1.statusCode).toBe(201);
    firstId = r1.json().id;
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: bearer(),
      payload: {
        type: 'bench',
        externalId: 'r2',
        runAt: '2026-09-27T10:00:00Z',
        params: { model: 'llama', commit: 'bbb' },
        values: { tok_s: 708, golden: true },
        sets: ['chain-a'],
      },
    });
    expect(r2.json().status).toBe('fail'); // −8% against r1 breaks relMin 0.97
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: bearer(),
      payload: { type: 'bench', params: { model: 'olmoe' }, values: { tok_s: 600, golden: true } },
    });
    expect(other.json().status).toBe('pass'); // different identity: no baseline, golden holds
  });

  it('re-uploading the same externalId updates instead of duplicating, and logs the change', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: bearer(),
      payload: {
        type: 'bench',
        externalId: 'r1',
        runAt: '2026-09-26T10:00:00Z',
        params: { model: 'llama', commit: 'aaa' },
        values: { tok_s: 771, golden: true },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: false, changed: ['results'] });
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/runs?type=bench&param.model=llama',
      headers: bearer(),
    });
    expect(list.json().total).toBe(2);
  });

  it('preserveText keeps notes edited after the first upload', async () => {
    const payload = {
      type: 'bench',
      externalId: 'keep',
      params: { model: 'llama' },
      values: { tok_s: 1 },
      notes: 'from importer',
    };
    const first = await app.inject({ method: 'POST', url: '/api/v1/runs', headers: bearer(), payload });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/runs/${first.json().id}`,
      headers: asAdmin(),
      payload: { notes: 'edited by a person' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: bearer(),
      payload: { ...payload, preserveText: true },
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${first.json().id}`,
      headers: bearer(),
    });
    expect(detail.json().notes).toBe('edited by a person');
  });

  it('rejects unknown data points with a helpful message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: bearer(),
      payload: { type: 'bench', values: { tokps: 1 } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('unknown data point');
  });

  it('batch submission reports per-item results', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/batch',
      headers: bearer(),
      payload: {
        runs: [
          { type: 'bench', externalId: 'b1', values: { tok_s: 1 } },
          { type: 'missing-type', values: {} },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: 1, failed: 1 });
  });

  it('edits notes and conclusion with history, and shows the evaluation', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/runs/${firstId}`,
      headers: asAdmin(),
      payload: { notes: 'first', conclusion: '**baseline**' },
    });
    expect(patch.json().changed).toEqual(['notes', 'conclusion']);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/runs/${firstId}`,
      headers: asAdmin(),
      payload: { notes: 'second' },
    });
    const detail = (
      await app.inject({ method: 'GET', url: `/api/v1/runs/${firstId}`, headers: bearer() })
    ).json();
    expect(detail.notes).toBe('second');
    expect(detail.edits.filter((e: { field: string }) => e.field === 'notes')).toHaveLength(2);
    expect(detail.attachments[0].filename).toBe('bench.json');
    expect(detail.sets[0].slug).toBe('chain-a');
  });

  it('uploads a raw attachment and serves it as a download', async () => {
    const up = await app.inject({
      method: 'PUT',
      url: `/api/v1/runs/${firstId}/attachments/golden1.txt`,
      headers: { ...bearer(), 'content-type': 'text/plain' },
      payload: 'PASS: 16/16',
    });
    expect(up.statusCode).toBe(201);
    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${up.json().id}`,
      headers: bearer(),
    });
    expect(get.body).toBe('PASS: 16/16');
    expect(get.headers['content-disposition']).toContain('attachment');
  });

  it('refuses an attachment above the size cap', async () => {
    const up = await app.inject({
      method: 'PUT',
      url: `/api/v1/runs/${firstId}/attachments/big.bin`,
      headers: { ...bearer(), 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(2 * 1024 * 1024),
    });
    expect(up.statusCode).toBe(413);
  });

  it('serves a set with its runs and definitions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sets/chain-a', headers: bearer() });
    expect(res.json().runs).toHaveLength(2);
    expect(res.json().definitions.bench.dataPoints).toHaveLength(2);
  });

  it('exports CSV with parameter and value columns', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/export?type=bench&format=csv',
      headers: bearer(),
    });
    const [header] = res.body.split('\n');
    expect(header).toContain('param.model');
    expect(header).toContain('value.tok_s');
  });

  it('dashboard lists the regression', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: bearer() });
    expect(res.statusCode).toBe(200);
    expect(res.json().regressions.length).toBeGreaterThan(0);
  });

  it('revoked tokens stop working', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/tokens', headers: asAdmin() });
    const id = list.json().tokens[0].id;
    await app.inject({ method: 'DELETE', url: `/api/v1/tokens/${id}`, headers: asAdmin() });
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs', headers: bearer() });
    expect(res.statusCode).toBe(401);
  });

  it('serves the OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain('/api/v1/runs');
  });
});
