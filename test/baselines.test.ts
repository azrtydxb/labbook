// Pinned baselines and target zones, end to end against Postgres. Deliberately not
// GPU-shaped: a storage IOPS test and a network throughput test.
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

describe.skipIf(!url)('baselines and targets', () => {
  let db: Database;
  let app: FastifyInstance;
  let headers: Record<string, string> = {};

  const call = async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url: `/api/v1${path}`,
      headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    return { status: res.statusCode, body: res.json() };
  };

  const run = async (type: string, externalId: string, runAt: string, params: object, values: object) => {
    const r = await call('POST', '/runs', { type, externalId, runAt, params, values });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  };

  beforeAll(async () => {
    db = createDb(url!, 4);
    await sql`drop schema if exists public cascade; create schema public`.execute(db);
    await migrateToLatest(db);
    await seedAdmin(db, 'admin', 'correct-horse-battery');
    app = await buildApp(db, loadConfig({ DATABASE_URL: url }), { logger: false });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    const c = login.cookies.find((x) => x.name === 'labbook_session')!;
    headers = { cookie: `labbook_session=${c.value}`, 'x-requested-with': 'labbook' };
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  const iops = {
    name: 'fio random read',
    definition: {
      parameters: [{ key: 'device' }, { key: 'controller' }, { key: 'label', identity: false }],
      dataPoints: [
        {
          key: 'iops',
          unit: 'IOPS',
          better: 'higher',
          targets: [{ ref: 'baseline', baseline: 'old-controller', min: 0.75 }],
        },
        { key: 'lat_p99_us', unit: 'µs', better: 'lower' },
      ],
    },
  };
  const ids: Record<string, string> = {};

  it('accepts targets in a definition and rejects malformed ones', async () => {
    expect((await call('PUT', '/test-types/fio-randread', iops)).status).toBe(201);
    const bad = await call('PUT', '/test-types/fio-bad', {
      name: 'bad',
      definition: {
        dataPoints: [
          { key: 'iops', targets: [{ ref: 'baseline', min: 0.75 }] },
          { key: 'ok', type: 'boolean', targets: [{ ref: 'absolute', min: 1 }] },
          { key: 'x', better: 'none', targets: [{ ref: 'best', min: 0.97 }] },
        ],
      },
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/baseline/);
  });

  it('builds a baseline with one member per device and rejects ambiguous members', async () => {
    ids.oldNvme = await run(
      'fio-randread',
      'old-nvme',
      '2026-01-01T00:00:00Z',
      { device: 'nvme', controller: 'old' },
      { iops: 400000, lat_p99_us: 90 },
    );
    ids.oldSata = await run(
      'fio-randread',
      'old-sata',
      '2026-01-01T00:01:00Z',
      { device: 'sata', controller: 'old' },
      { iops: 90000, lat_p99_us: 400 },
    );
    ids.oldSata2 = await run(
      'fio-randread',
      'old-sata-rerun',
      '2026-01-01T00:02:00Z',
      { device: 'sata', controller: 'old' },
      { iops: 95000, lat_p99_us: 380 },
    );

    const dup = await call('PUT', '/test-types/fio-randread/baselines/old-controller', {
      name: 'Old controller',
      matchKeys: ['device'],
      runIds: [ids.oldSata, ids.oldSata2],
    });
    expect(dup.status).toBe(400);
    expect(dup.body.details.join(' ')).toMatch(/both match device=sata/);

    const unknownKey = await call('PUT', '/test-types/fio-randread/baselines/old-controller', {
      name: 'Old controller',
      matchKeys: ['rack'],
    });
    expect(unknownKey.status).toBe(400);

    const ok = await call('PUT', '/test-types/fio-randread/baselines/old-controller', {
      name: 'Old controller',
      matchKeys: ['device'],
      externalIds: ['old-nvme', 'old-sata'],
    });
    expect(ok).toMatchObject({ status: 201, body: { created: true } });

    // A newer sata run replaces the sata member (a sub-baseline update), not adds one.
    const add = await call('POST', '/test-types/fio-randread/baselines/old-controller/runs', {
      runIds: [ids.oldSata2],
    });
    expect(add.body).toEqual({ added: 0, replaced: 1 });

    const list = await call('GET', '/test-types/fio-randread/baselines');
    const b = list.body.baselines[0];
    expect(b.matchKeys).toEqual(['device']);
    expect(b.members.map((m: { runId: string; match: object }) => [m.runId, m.match])).toEqual([
      [ids.oldNvme, { device: 'nvme' }],
      [ids.oldSata2, { device: 'sata' }],
    ]);
  });

  it('compares a run with its matching member and grades it against the target zone', async () => {
    ids.newNvme = await run(
      'fio-randread',
      'new-nvme',
      '2026-02-01T00:00:00Z',
      { device: 'nvme', controller: 'new' },
      { iops: 320000, lat_p99_us: 70 },
    );
    ids.newSata = await run(
      'fio-randread',
      'new-sata',
      '2026-02-01T00:01:00Z',
      { device: 'sata', controller: 'new' },
      { iops: 60000, lat_p99_us: 300 },
    );

    const nvme = (await call('GET', `/runs/${ids.newNvme}`)).body;
    expect(nvme.baselines).toHaveLength(1);
    const cmp = nvme.baselines[0];
    expect(cmp).toMatchObject({ slug: 'old-controller', runId: ids.oldNvme, match: { device: 'nvme' } });
    const iopsPt = cmp.points.find((p: { key: string }) => p.key === 'iops');
    expect(iopsPt.ratio).toBeCloseTo(0.8);
    expect(iopsPt.improved).toBe(false);
    // 320k ≥ 0.75 × 400k: on target, while pass/fail is untouched (no bounds).
    expect(nvme.targets).toEqual([
      expect.objectContaining({
        key: 'iops',
        verdict: 'on',
        reference: 400000,
        referenceRunId: ids.oldNvme,
        zone: { min: 300000, max: null },
        label: '≥ 75% of Old controller',
      }),
    ]);
    expect(nvme.target).toBe('on');

    // 60k < 0.75 × 95k (the sata member was replaced by the rerun).
    const sata = (await call('GET', `/runs/${ids.newSata}`)).body;
    expect(sata.targets[0]).toMatchObject({ verdict: 'off', reference: 95000 });
    expect(sata.status).toBe('info');

    const listed = (await call('GET', '/runs?type=fio-randread&order=asc')).body.runs;
    const grade = Object.fromEntries(
      listed.map((r: { externalId: string; target: string }) => [r.externalId, r.target]),
    );
    expect(grade).toMatchObject({ 'new-nvme': 'on', 'new-sata': 'off' });
    const member = listed.find((r: { id: string }) => r.id === ids.oldNvme);
    expect(member.baselineOf).toEqual([{ slug: 'old-controller', name: 'Old controller' }]);
  });

  it('grades against the best earlier comparable run', async () => {
    await call('PUT', '/test-types/iperf', {
      name: 'iperf3 throughput',
      definition: {
        parameters: [{ key: 'link' }, { key: 'commit', identity: false }],
        dataPoints: [
          { key: 'gbps', unit: 'Gbit/s', better: 'higher', targets: [{ ref: 'best', min: 0.97 }] },
          { key: 'retransmits', better: 'lower', targets: [{ ref: 'absolute', max: 10 }] },
        ],
      },
    });
    const a = await run(
      'iperf',
      'a',
      '2026-03-01T00:00:00Z',
      { link: '25g' },
      { gbps: 23.5, retransmits: 2 },
    );
    await run('iperf', 'b', '2026-03-02T00:00:00Z', { link: '25g' }, { gbps: 22.0, retransmits: 4 });
    const c = await run(
      'iperf',
      'c',
      '2026-03-03T00:00:00Z',
      { link: '25g' },
      { gbps: 22.9, retransmits: 30 },
    );
    const other = await run(
      'iperf',
      'd',
      '2026-03-04T00:00:00Z',
      { link: '10g' },
      { gbps: 9.4, retransmits: 0 },
    );

    const first = (await call('GET', `/runs/${a}`)).body;
    expect(first.targets.find((t: { key: string }) => t.key === 'gbps').verdict).toBe('unknown');

    // 22.9 ≥ 0.97 × 23.5 (the best earlier 25g run, not the previous one), retransmits over 10.
    const third = (await call('GET', `/runs/${c}`)).body;
    const gbps = third.targets.find((t: { key: string }) => t.key === 'gbps');
    expect(gbps).toMatchObject({ verdict: 'on', reference: 23.5, referenceRunId: a });
    expect(third.targets.find((t: { key: string }) => t.key === 'retransmits').verdict).toBe('off');
    expect(third.target).toBe('off');

    // A different link has its own history: nothing to compare with yet.
    const tenG = (await call('GET', `/runs/${other}`)).body;
    expect(tenG.targets.find((t: { key: string }) => t.key === 'gbps').verdict).toBe('unknown');
    expect(tenG.target).toBe('on');
  });

  it('removes members and deletes baselines without touching runs', async () => {
    const rm = await call('DELETE', `/test-types/fio-randread/baselines/old-controller/runs/${ids.oldNvme}`);
    expect(rm.status).toBe(200);
    const nvme = (await call('GET', `/runs/${ids.newNvme}`)).body;
    expect(nvme.baselines).toEqual([]);
    expect(nvme.targets[0].verdict).toBe('unknown');

    expect((await call('DELETE', '/test-types/fio-randread/baselines/old-controller')).status).toBe(200);
    expect((await call('GET', '/test-types/fio-randread/baselines')).body.baselines).toEqual([]);
    expect((await call('GET', `/runs/${ids.oldSata2}`)).status).toBe(200);
  });
});
