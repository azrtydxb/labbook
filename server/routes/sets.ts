import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../auth.js';
import type { Database } from '../db/index.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { SLUG_RE } from '../../shared/definition.js';
import type { TypeDefinition } from '../../shared/types.js';
import { linkRunToSets, listRuns } from '../services/runs.js';
import { mergedDefinition } from '../services/testTypes.js';
import {
  ChangedSchema,
  errors,
  OkSchema,
  SetDetailSchema,
  SetRefResultSchema,
  SetSummarySchema,
} from '../schemas.js';

const SetBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(200_000).default(''),
  conclusion: z.string().max(200_000).default(''),
});
const SlugParams = z.object({ slug: z.string().max(100) });

async function getSet(db: Database, slug: string) {
  const s = await db.selectFrom('sets').selectAll().where('slug', '=', slug).executeTakeFirst();
  if (!s) throw notFound(`set '${slug}' not found`);
  return s;
}

async function recordEdit(db: Database, id: string, field: string, o: string, n: string, userId: string) {
  if (o === n) return false;
  await db
    .insertInto('edits')
    .values({ entity_type: 'set', entity_id: id, field, old_value: o, new_value: n, edited_by: userId })
    .execute();
  return true;
}

export function setRoutes(app: FastifyInstance, db: Database): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/v1/sets',
    {
      schema: {
        operationId: 'listSets',
        tags: ['sets'],
        summary: 'List sets, most recently active first',
        response: { 200: z.object({ sets: z.array(SetSummarySchema) }), ...errors() },
      },
    },
    async (req) => {
      requireUser(req);
      const sets = await db
        .selectFrom('sets as s')
        .leftJoin('set_runs as sr', 'sr.set_id', 's.id')
        .leftJoin('runs as r', 'r.id', 'sr.run_id')
        .select([
          's.id',
          's.slug',
          's.name',
          's.description',
          's.conclusion',
          's.created_at',
          's.updated_at',
          (eb) => eb.fn.count<number>('r.id').as('runs'),
          (eb) => eb.fn.count<number>('r.id').filterWhere('r.status', 'in', ['fail', 'error']).as('failing'),
          (eb) => eb.fn.max('r.run_at').as('last_run_at'),
          (eb) => eb.fn.min('r.run_at').as('first_run_at'),
        ])
        .groupBy('s.id')
        .orderBy('s.updated_at', 'desc')
        .execute();
      const typeRows = await db
        .selectFrom('set_runs as sr')
        .innerJoin('runs as r', 'r.id', 'sr.run_id')
        .innerJoin('test_types as t', 't.id', 'r.test_type_id')
        .select(['sr.set_id', 't.slug', 't.name'])
        .distinct()
        .execute();
      return {
        sets: sets
          .map((s) => ({
            id: s.id,
            slug: s.slug,
            name: s.name,
            description: s.description,
            hasConclusion: s.conclusion.trim().length > 0,
            conclusion: s.conclusion,
            runCount: Number(s.runs),
            failingCount: Number(s.failing),
            firstRunAt: s.first_run_at,
            lastRunAt: s.last_run_at,
            createdAt: s.created_at,
            updatedAt: s.updated_at,
            types: typeRows.filter((t) => t.set_id === s.id).map((t) => ({ slug: t.slug, name: t.name })),
          }))
          .sort((a, b) =>
            String(b.lastRunAt ?? b.updatedAt).localeCompare(String(a.lastRunAt ?? a.updatedAt)),
          ),
      };
    },
  );

  r.post(
    '/api/v1/sets',
    {
      schema: {
        operationId: 'createSet',
        tags: ['sets'],
        summary: 'Create a set (the slug is derived from the name unless given)',
        response: { 201: SetRefResultSchema, ...errors(409) },
        body: SetBody.extend({ slug: z.string().regex(SLUG_RE).optional() }),
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const slug =
        req.body.slug ??
        req.body.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 100);
      if (!SLUG_RE.test(slug)) throw badRequest('cannot derive a slug from the name; pass one');
      const exists = await db.selectFrom('sets').select('id').where('slug', '=', slug).executeTakeFirst();
      if (exists) throw conflict(`set '${slug}' already exists`);
      const s = await db
        .insertInto('sets')
        .values({ slug, ...req.body, created_by: me.id })
        .returning(['id', 'slug'])
        .executeTakeFirstOrThrow();
      reply.code(201);
      return s;
    },
  );

  r.put(
    '/api/v1/sets/:slug',
    {
      schema: {
        operationId: 'upsertSet',
        tags: ['sets'],
        summary: 'Create or update a set (idempotent)',
        response: {
          200: SetRefResultSchema.extend({ created: z.boolean() }),
          201: SetRefResultSchema.extend({ created: z.boolean() }),
          ...errors(),
        },
        params: SlugParams,
        body: SetBody,
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      if (!SLUG_RE.test(req.params.slug)) throw badRequest('invalid slug');
      const s = await db
        .selectFrom('sets')
        .selectAll()
        .where('slug', '=', req.params.slug)
        .executeTakeFirst();
      if (!s) {
        const row = await db
          .insertInto('sets')
          .values({ slug: req.params.slug, ...req.body, created_by: me.id })
          .returning(['id', 'slug'])
          .executeTakeFirstOrThrow();
        reply.code(201);
        return { ...row, created: true };
      }
      let changed = false;
      for (const f of ['name', 'description', 'conclusion'] as const) {
        changed = (await recordEdit(db, s.id, f, s[f], req.body[f], me.id)) || changed;
      }
      if (changed) {
        await db
          .updateTable('sets')
          .set({ ...req.body, updated_at: new Date() })
          .where('id', '=', s.id)
          .execute();
      }
      return { id: s.id, slug: s.slug, created: false };
    },
  );

  r.get(
    '/api/v1/sets/:slug',
    {
      schema: {
        operationId: 'getSet',
        tags: ['sets'],
        summary: 'A set with all its runs, the definitions of their types, and its edit history',
        response: { 200: SetDetailSchema, ...errors(404) },
        params: SlugParams,
      },
    },
    async (req) => {
      requireUser(req);
      const s = await getSet(db, req.params.slug);
      const { runs } = await listRuns(db, { set: s.slug, limit: 10000, offset: 0, order: 'asc' });
      const definitions: Record<string, TypeDefinition> = {};
      const types = await db.selectFrom('test_types').select(['id', 'slug']).execute();
      for (const slug of new Set(runs.map((x) => x.type.slug))) {
        const t = types.find((x) => x.slug === slug);
        if (t) definitions[slug] = await mergedDefinition(db, t.id);
      }
      const edits = await db
        .selectFrom('edits as e')
        .leftJoin('users as u', 'u.id', 'e.edited_by')
        .select(['e.id', 'e.field', 'e.old_value', 'e.new_value', 'e.edited_at', 'u.username'])
        .where('e.entity_type', '=', 'set')
        .where('e.entity_id', '=', s.id)
        .orderBy('e.edited_at', 'desc')
        .execute();
      return {
        id: s.id,
        slug: s.slug,
        name: s.name,
        description: s.description,
        conclusion: s.conclusion,
        baselineRunId: s.baseline_run_id,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        runs,
        definitions,
        edits: edits.map((e) => ({
          id: e.id,
          field: e.field,
          oldValue: e.old_value,
          newValue: e.new_value,
          editedAt: e.edited_at,
          editedBy: e.username,
        })),
      };
    },
  );

  r.patch(
    '/api/v1/sets/:slug',
    {
      schema: {
        operationId: 'updateSet',
        tags: ['sets'],
        summary: 'Edit name, description, conclusion or baseline run (changes are logged)',
        response: { 200: ChangedSchema, ...errors(404) },
        params: SlugParams,
        body: z
          .object({
            name: z.string().min(1).max(200).optional(),
            description: z.string().max(200_000).optional(),
            conclusion: z.string().max(200_000).optional(),
            baselineRunId: z.uuid().nullable().optional(),
          })
          .strict(),
      },
    },
    async (req) => {
      const me = requireUser(req);
      const s = await getSet(db, req.params.slug);
      const set: Record<string, unknown> = {};
      for (const f of ['name', 'description', 'conclusion'] as const) {
        const v = req.body[f];
        if (v !== undefined && (await recordEdit(db, s.id, f, s[f], v, me.id))) set[f] = v;
      }
      if (req.body.baselineRunId !== undefined) {
        if (req.body.baselineRunId) {
          const inSet = await db
            .selectFrom('set_runs')
            .select('run_id')
            .where('set_id', '=', s.id)
            .where('run_id', '=', req.body.baselineRunId)
            .executeTakeFirst();
          if (!inSet) throw badRequest('the baseline run must belong to the set');
        }
        if (
          await recordEdit(db, s.id, 'baseline', s.baseline_run_id ?? '', req.body.baselineRunId ?? '', me.id)
        ) {
          set.baseline_run_id = req.body.baselineRunId;
        }
      }
      if (Object.keys(set).length) {
        await db
          .updateTable('sets')
          .set({ ...set, updated_at: new Date() } as never)
          .where('id', '=', s.id)
          .execute();
      }
      return { changed: Object.keys(set) };
    },
  );

  r.post(
    '/api/v1/sets/:slug/runs',
    {
      schema: {
        operationId: 'addSetRuns',
        tags: ['sets'],
        summary: 'Add runs to a set, by id or by (type, externalId)',
        response: { 200: z.object({ added: z.number().int() }), ...errors(404) },
        params: SlugParams,
        body: z.object({
          runIds: z.array(z.uuid()).max(5000).default([]),
          externalIds: z
            .array(z.object({ type: z.string(), externalId: z.string() }))
            .max(5000)
            .default([]),
        }),
      },
    },
    async (req) => {
      const me = requireUser(req);
      const s = await getSet(db, req.params.slug);
      const ids = [...req.body.runIds];
      for (const x of req.body.externalIds) {
        const row = await db
          .selectFrom('runs as r')
          .innerJoin('test_types as t', 't.id', 'r.test_type_id')
          .select('r.id')
          .where('t.slug', '=', x.type)
          .where('r.external_id', '=', x.externalId)
          .executeTakeFirst();
        if (!row) throw notFound(`no run ${x.type}/${x.externalId}`);
        ids.push(row.id);
      }
      for (const id of ids) await linkRunToSets(db, id, [s.id]);
      await db.updateTable('sets').set({ updated_at: new Date() }).where('id', '=', s.id).execute();
      await db
        .insertInto('edits')
        .values({
          entity_type: 'set',
          entity_id: s.id,
          field: 'runs',
          old_value: null,
          new_value: `added ${ids.length} run(s)`,
          edited_by: me.id,
        })
        .execute();
      return { added: ids.length };
    },
  );

  r.delete(
    '/api/v1/sets/:slug/runs/:runId',
    {
      schema: {
        operationId: 'removeSetRun',
        tags: ['sets'],
        summary: 'Remove a run from a set',
        response: { 200: OkSchema, ...errors(404) },
        params: SlugParams.extend({ runId: z.uuid() }),
      },
    },
    async (req) => {
      const me = requireUser(req);
      const s = await getSet(db, req.params.slug);
      await db
        .deleteFrom('set_runs')
        .where('set_id', '=', s.id)
        .where('run_id', '=', req.params.runId)
        .execute();
      if (s.baseline_run_id === req.params.runId) {
        await db.updateTable('sets').set({ baseline_run_id: null }).where('id', '=', s.id).execute();
      }
      await db
        .insertInto('edits')
        .values({
          entity_type: 'set',
          entity_id: s.id,
          field: 'runs',
          old_value: req.params.runId,
          new_value: 'removed',
          edited_by: me.id,
        })
        .execute();
      return { ok: true };
    },
  );

  r.delete(
    '/api/v1/sets/:slug',
    {
      schema: {
        operationId: 'deleteSet',
        tags: ['sets'],
        summary: 'Delete a set; its runs stay (admin)',
        params: SlugParams,
        response: { 200: OkSchema, ...errors(403, 404) },
      },
    },
    async (req) => {
      requireAdmin(req);
      const s = await getSet(db, req.params.slug);
      await db.deleteFrom('sets').where('id', '=', s.id).execute();
      return { ok: true };
    },
  );
}
