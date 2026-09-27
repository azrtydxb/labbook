import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../auth.js';
import type { Database } from '../db/index.js';
import { conflict } from '../errors.js';
import { primaryPoint } from '../../shared/evaluate.js';
import {
  getDefinition,
  getTypeBySlug,
  mergedDefinition,
  TypeCreateSchema,
  TypeInputSchema,
  typeDto,
  upsertType,
} from '../services/testTypes.js';

const SlugParams = z.object({ slug: z.string().max(100) });

export function typeRoutes(app: FastifyInstance, db: Database): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/v1/test-types',
    {
      schema: {
        tags: ['test types'],
        summary: 'List test types with run counts and the recent trend of the primary data point',
        querystring: z.object({ trend: z.coerce.number().int().min(0).max(200).default(30) }),
      },
    },
    async (req) => {
      requireUser(req);
      const types = await db.selectFrom('test_types').selectAll().orderBy('name').execute();
      const stats = await db
        .selectFrom('runs')
        .select([
          'test_type_id',
          (eb) => eb.fn.countAll<number>().as('runs'),
          (eb) => eb.fn.max('run_at').as('last_run_at'),
          (eb) => eb.fn.countAll<number>().filterWhere('status', 'in', ['fail', 'error']).as('failing'),
        ])
        .groupBy('test_type_id')
        .execute();
      const out = [];
      for (const t of types) {
        const def = await getDefinition(db, t.id, t.current_version);
        const primary = primaryPoint(def);
        const trend = req.query.trend
          ? await db
              .selectFrom('runs')
              .select(['id', 'run_at', 'status', 'results', 'params'])
              .where('test_type_id', '=', t.id)
              .orderBy('run_at', 'desc')
              .orderBy('seq', 'desc')
              .limit(req.query.trend)
              .execute()
          : [];
        const s = stats.find((x) => x.test_type_id === t.id);
        out.push({
          id: t.id,
          slug: t.slug,
          name: t.name,
          description: t.description,
          tags: t.tags,
          version: t.current_version,
          definition: def,
          runCount: Number(s?.runs ?? 0),
          failingCount: Number(s?.failing ?? 0),
          lastRunAt: s?.last_run_at ?? null,
          primary: primary
            ? { key: primary.key, label: primary.label, unit: primary.unit, better: primary.better }
            : null,
          trend: trend.reverse().map((x) => ({
            id: x.id,
            runAt: x.run_at,
            status: x.status,
            value: primary ? (x.results[primary.key] ?? null) : null,
            params: x.params,
          })),
          updatedAt: t.updated_at,
        });
      }
      return { types: out };
    },
  );

  r.get(
    '/api/v1/test-types/:slug',
    {
      schema: {
        tags: ['test types'],
        summary: 'A test type: current definition, all versions, and the merged definition',
        params: SlugParams,
      },
    },
    async (req) => {
      requireUser(req);
      const t = await getTypeBySlug(db, req.params.slug);
      const versions = await db
        .selectFrom('test_type_versions as v')
        .leftJoin('users as u', 'u.id', 'v.created_by')
        .select(['v.version', 'v.note', 'v.created_at', 'u.username'])
        .where('v.test_type_id', '=', t.id)
        .orderBy('v.version', 'desc')
        .execute();
      return {
        ...(await typeDto(db, t)),
        merged: await mergedDefinition(db, t.id),
        versions: versions.map((v) => ({
          version: v.version,
          note: v.note,
          createdAt: v.created_at,
          createdBy: v.username,
        })),
      };
    },
  );

  r.get(
    '/api/v1/test-types/:slug/versions/:version',
    {
      schema: {
        tags: ['test types'],
        summary: 'One schema version',
        params: SlugParams.extend({ version: z.coerce.number().int().positive() }),
      },
    },
    async (req) => {
      requireUser(req);
      const t = await getTypeBySlug(db, req.params.slug);
      return { version: req.params.version, definition: await getDefinition(db, t.id, req.params.version) };
    },
  );

  r.post(
    '/api/v1/test-types',
    { schema: { tags: ['test types'], summary: 'Define a new test type', body: TypeCreateSchema } },
    async (req, reply) => {
      const me = requireUser(req);
      const res = await upsertType(db, req.body.slug, req.body, me.id, 'create');
      reply.code(201);
      return { slug: req.body.slug, ...res };
    },
  );

  r.put(
    '/api/v1/test-types/:slug',
    {
      schema: {
        tags: ['test types'],
        summary: 'Create or update a test type (idempotent). A changed definition becomes a new version.',
        params: SlugParams,
        body: TypeInputSchema,
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const res = await upsertType(db, req.params.slug, req.body, me.id, 'upsert');
      if (res.created) reply.code(201);
      return { slug: req.params.slug, ...res };
    },
  );

  r.delete(
    '/api/v1/test-types/:slug',
    {
      schema: {
        tags: ['test types'],
        summary: 'Delete a test type without runs (admin)',
        params: SlugParams,
      },
    },
    async (req) => {
      requireAdmin(req);
      const t = await getTypeBySlug(db, req.params.slug);
      const n = await db
        .selectFrom('runs')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('test_type_id', '=', t.id)
        .executeTakeFirstOrThrow();
      if (Number(n.n) > 0) throw conflict(`test type has ${n.n} runs; delete them first`);
      await db.deleteFrom('test_types').where('id', '=', t.id).execute();
      return { ok: true };
    },
  );
}
