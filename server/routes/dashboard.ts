import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import type { Database } from '../db/index.js';
import { evaluateRun, identityKey, primaryPoint } from '../../shared/evaluate.js';
import type { Scalar, TypeDefinition } from '../../shared/types.js';
import { listRuns } from '../services/runs.js';
import { getDefinition } from '../services/testTypes.js';

export function dashboardRoutes(app: FastifyInstance, db: Database): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/v1/dashboard',
    {
      schema: {
        tags: ['meta'],
        summary: 'Home dashboard: counts, recent runs, failing runs and regressions',
        querystring: z.object({
          regressionThreshold: z.coerce
            .number()
            .min(0)
            .max(1)
            .default(0.03)
            .describe('Relative worsening of the primary data point that counts as a regression'),
        }),
      },
    },
    async (req) => {
      requireUser(req);
      const weekAgo = new Date(Date.now() - 7 * 86400_000);
      const counts = await db
        .selectFrom('runs')
        .select([
          (eb) => eb.fn.countAll<number>().as('runs'),
          (eb) => eb.fn.countAll<number>().filterWhere('run_at', '>=', weekAgo).as('runs7d'),
          (eb) => eb.fn.countAll<number>().filterWhere('status', 'in', ['fail', 'error']).as('failing'),
        ])
        .executeTakeFirstOrThrow();
      const types = await db
        .selectFrom('test_types')
        .select(['id', 'slug', 'name', 'current_version'])
        .execute();
      const sets = await db
        .selectFrom('sets')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirstOrThrow();
      const attachments = await db
        .selectFrom('attachments')
        .select([
          (eb) => eb.fn.countAll<number>().as('n'),
          (eb) => eb.fn.sum<number>('size_bytes').as('bytes'),
        ])
        .executeTakeFirstOrThrow();

      const recent = await listRuns(db, { limit: 12, offset: 0, order: 'desc' });
      const failing = await listRuns(db, { status: ['fail', 'error'], limit: 10, offset: 0, order: 'desc' });

      // Regressions: the primary data point moved the wrong way by more than the
      // threshold against the previous comparable run, or a relative bound failed.
      const regressions: {
        runId: string;
        type: { slug: string; name: string };
        runAt: Date;
        params: Record<string, string>;
        key: string;
        label: string;
        unit: string;
        value: number;
        baseline: number;
        baselineRunId: string;
        deltaPct: number;
        boundFailed: boolean;
      }[] = [];
      for (const t of types) {
        const rows = await db
          .selectFrom('runs')
          .select(['id', 'run_at', 'params', 'results', 'type_version'])
          .where('test_type_id', '=', t.id)
          .orderBy('run_at', 'asc')
          .orderBy('seq', 'asc')
          .execute();
        const current = await getDefinition(db, t.id, t.current_version);
        const lastByIdentity = new Map<string, { id: string; values: Record<string, Scalar> }>();
        for (const row of rows) {
          const def: TypeDefinition =
            row.type_version === t.current_version
              ? current
              : await getDefinition(db, t.id, row.type_version);
          const primary = primaryPoint(def);
          const idKey = identityKey(def, row.params);
          const prev = lastByIdentity.get(idKey);
          lastByIdentity.set(idKey, { id: row.id, values: row.results });
          if (!prev || !primary || primary.type !== 'number' || primary.better === 'none') continue;
          const ev = evaluateRun(def, row.results, prev.values);
          const p = ev.points.find((x) => x.key === primary.key);
          const boundFailed = ev.points.some(
            (x) => x.verdict === 'fail' && x.reasons.some((m) => m.includes('baseline')),
          );
          if (!p || p.deltaPct === null) continue;
          const worse = primary.better === 'higher' ? -p.deltaPct : p.deltaPct;
          if (worse > req.query.regressionThreshold || boundFailed) {
            regressions.push({
              runId: row.id,
              type: { slug: t.slug, name: t.name },
              runAt: row.run_at,
              params: row.params,
              key: primary.key,
              label: primary.label,
              unit: primary.unit,
              value: p.value as number,
              baseline: p.baseline as number,
              baselineRunId: prev.id,
              deltaPct: p.deltaPct,
              boundFailed,
            });
          }
        }
      }
      regressions.sort((a, b) => b.runAt.getTime() - a.runAt.getTime());

      return {
        counts: {
          types: types.length,
          runs: Number(counts.runs),
          runs7d: Number(counts.runs7d),
          failing: Number(counts.failing),
          sets: Number(sets.n),
          attachments: Number(attachments.n),
          attachmentBytes: Number(attachments.bytes ?? 0),
        },
        recent: recent.runs,
        failing: failing.runs,
        regressions: regressions.slice(0, 12),
      };
    },
  );
}
