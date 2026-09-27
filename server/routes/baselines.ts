import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../auth.js';
import type { Database } from '../db/index.js';
import { BaselineSchema, errors, OkSchema } from '../schemas.js';
import {
  addBaselineRuns,
  BaselineInputSchema,
  BaselineRunsSchema,
  getBaselineRow,
  listBaselines,
  removeBaselineRun,
  upsertBaseline,
} from '../services/baselines.js';
import { getTypeBySlug } from '../services/testTypes.js';

const TypeParams = z.object({ slug: z.string().max(100).describe('Test type slug') });
const BaselineParams = TypeParams.extend({ baseline: z.string().max(100).describe('Baseline slug') });
const tags = ['baselines'];

export function baselineRoutes(app: FastifyInstance, db: Database): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/v1/test-types/:slug/baselines',
    {
      schema: {
        operationId: 'listBaselines',
        tags,
        summary: 'Pinned baselines of a test type, with their member runs',
        description:
          'A baseline is a named reference (e.g. "vLLM-ROCm 0.23.0", "last release", "old switch") with one ' +
          'member run per combination of its matchKeys (e.g. one per model, or per host). Each run is ' +
          'compared with the member whose parameters match it. Baselines are shown, never enforced: ' +
          'pass/fail keeps comparing with the previous comparable run.',
        params: TypeParams,
        response: { 200: z.object({ baselines: z.array(BaselineSchema) }), ...errors(404) },
      },
    },
    async (req) => {
      requireUser(req);
      const t = await getTypeBySlug(db, req.params.slug);
      return { baselines: await listBaselines(db, t.id) };
    },
  );

  r.put(
    '/api/v1/test-types/:slug/baselines/:baseline',
    {
      schema: {
        operationId: 'upsertBaseline',
        tags,
        summary: 'Create or update a pinned baseline (idempotent)',
        description:
          'runIds/externalIds, when given, replace the member list; omitted, the members stay. Members must ' +
          'carry every match key and no two may match the same runs.',
        params: BaselineParams,
        body: BaselineInputSchema,
        response: {
          200: z.object({ slug: z.string(), created: z.boolean() }),
          201: z.object({ slug: z.string(), created: z.boolean() }),
          ...errors(404),
        },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const t = await getTypeBySlug(db, req.params.slug);
      const res = await upsertBaseline(db, t.id, req.params.baseline, req.body, me.id);
      if (res.created) reply.code(201);
      return res;
    },
  );

  r.post(
    '/api/v1/test-types/:slug/baselines/:baseline/runs',
    {
      schema: {
        operationId: 'addBaselineRuns',
        tags,
        summary: 'Add member runs to a baseline; a member with the same match is replaced',
        params: BaselineParams,
        body: BaselineRunsSchema,
        response: {
          200: z.object({ added: z.number().int(), replaced: z.number().int() }),
          ...errors(404),
        },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const t = await getTypeBySlug(db, req.params.slug);
      return addBaselineRuns(db, t.id, req.params.baseline, req.body, me.id);
    },
  );

  r.delete(
    '/api/v1/test-types/:slug/baselines/:baseline/runs/:runId',
    {
      schema: {
        operationId: 'removeBaselineRun',
        tags,
        summary: 'Remove a member run from a baseline (the run itself stays)',
        params: BaselineParams.extend({ runId: z.uuid() }),
        response: { 200: OkSchema, ...errors(404) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const t = await getTypeBySlug(db, req.params.slug);
      await removeBaselineRun(db, t.id, req.params.baseline, req.params.runId, me.id);
      return { ok: true };
    },
  );

  r.delete(
    '/api/v1/test-types/:slug/baselines/:baseline',
    {
      schema: {
        operationId: 'deleteBaseline',
        tags,
        summary: 'Delete a baseline; its runs stay (admin)',
        params: BaselineParams,
        response: { 200: OkSchema, ...errors(403, 404) },
      },
    },
    async (req) => {
      requireAdmin(req);
      const t = await getTypeBySlug(db, req.params.slug);
      const b = await getBaselineRow(db, t.id, req.params.baseline);
      await db.deleteFrom('baselines').where('id', '=', b.id).execute();
      return { ok: true };
    },
  );
}
