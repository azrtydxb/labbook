import { z } from 'zod';
import type { Database } from '../db/index.js';
import {
  compareToBaseline,
  gradeTargets,
  identityKey,
  isBetter,
  matchOf,
  memberMatches,
  targetGrade,
  type Reference,
  type TargetResult,
} from '../../shared/evaluate.js';
import { SLUG_RE } from '../../shared/definition.js';
import type { Scalar, TypeDefinition } from '../../shared/types.js';
import { badRequest, notFound } from '../errors.js';
import { mergedDefinition } from './testTypes.js';

export const BaselineInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(20000).default(''),
  matchKeys: z
    .array(z.string().max(64))
    .max(20)
    .optional()
    .describe(
      'Parameters a member must share with a run to be its reference, e.g. ["model"] for one member ' +
        'per model. Default on create: none (a single member applies to every run).',
    ),
  runIds: z.array(z.uuid()).max(500).optional().describe('Replace the members with these runs'),
  externalIds: z.array(z.string()).max(500).optional().describe('Replace the members with these runs'),
});
export const BaselineRunsSchema = z.object({
  runIds: z.array(z.uuid()).max(500).default([]),
  externalIds: z.array(z.string()).max(500).default([]),
});

interface MemberRow {
  baseline_id: string;
  run_id: string;
  run_at: Date;
  external_id: string | null;
  seq: number;
  params: Record<string, string>;
  results: Record<string, Scalar>;
}

export async function getBaselineRow(db: Database, typeId: string, slug: string) {
  const b = await db
    .selectFrom('baselines')
    .selectAll()
    .where('test_type_id', '=', typeId)
    .where('slug', '=', slug)
    .executeTakeFirst();
  if (!b) throw notFound(`baseline '${slug}' not found`);
  return b;
}

function memberDto(matchKeys: string[], m: MemberRow) {
  return {
    runId: m.run_id,
    match: matchOf(matchKeys, m.params),
    runAt: m.run_at,
    externalId: m.external_id,
    label: m.params.label ?? m.external_id ?? `#${m.seq}`,
    params: m.params,
    values: m.results,
  };
}

/** Every baseline of a type with its members; members of one baseline are ordered oldest first. */
export async function listBaselines(db: Database, typeId: string) {
  const rows = await db
    .selectFrom('baselines')
    .selectAll()
    .where('test_type_id', '=', typeId)
    .orderBy('name')
    .execute();
  const members = rows.length
    ? await db
        .selectFrom('baseline_runs as br')
        .innerJoin('runs as r', 'r.id', 'br.run_id')
        .select([
          'br.baseline_id',
          'br.run_id',
          'r.run_at',
          'r.external_id',
          'r.seq',
          'r.params',
          'r.results',
        ])
        .where(
          'br.baseline_id',
          'in',
          rows.map((b) => b.id),
        )
        .orderBy('br.added_at')
        .execute()
    : [];
  return rows.map((b) => ({
    id: b.id,
    slug: b.slug,
    name: b.name,
    description: b.description,
    matchKeys: b.match_keys,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    members: members.filter((m) => m.baseline_id === b.id).map((m) => memberDto(b.match_keys, m)),
  }));
}

export type BaselineDto = Awaited<ReturnType<typeof listBaselines>>[number];

/** The member of a baseline that applies to a run; later-added members win a tie. */
export function memberFor(b: BaselineDto, params: Record<string, string>, excludeRunId?: string) {
  return b.members.filter((m) => m.runId !== excludeRunId && memberMatches(m.match, params)).at(-1);
}

async function resolveRuns(
  db: Database,
  typeId: string,
  runIds: string[],
  externalIds: string[],
): Promise<{ id: string; params: Record<string, string> }[]> {
  const out: { id: string; params: Record<string, string> }[] = [];
  for (const id of runIds) {
    const r = await db
      .selectFrom('runs')
      .select(['id', 'params', 'test_type_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound(`run ${id} not found`);
    if (r.test_type_id !== typeId) throw badRequest(`run ${id} belongs to another test type`);
    out.push(r);
  }
  for (const ext of externalIds) {
    const r = await db
      .selectFrom('runs')
      .select(['id', 'params'])
      .where('test_type_id', '=', typeId)
      .where('external_id', '=', ext)
      .executeTakeFirst();
    if (!r) throw notFound(`no run with externalId '${ext}' in this test type`);
    out.push(r);
  }
  return out;
}

/** Members must carry every match key, and no two may match the same runs. */
function checkMembers(matchKeys: string[], runs: { id: string; params: Record<string, string> }[]): void {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const r of runs) {
    const missing = matchKeys.filter((k) => r.params[k] === undefined);
    if (missing.length) problems.push(`run ${r.id} lacks match key(s) ${missing.join(', ')}`);
    const tuple = JSON.stringify(matchOf(matchKeys, r.params));
    const other = seen.get(tuple);
    if (other && other !== r.id) {
      const m = Object.entries(matchOf(matchKeys, r.params))
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      problems.push(`runs ${other} and ${r.id} both match ${m || 'every run'}; one member per match`);
    }
    seen.set(tuple, r.id);
  }
  if (problems.length) throw badRequest('invalid baseline members', problems);
}

async function logEdit(db: Database, typeId: string, slug: string, change: string, userId: string | null) {
  await db
    .insertInto('edits')
    .values({
      entity_type: 'test_type',
      entity_id: typeId,
      field: `baseline:${slug}`,
      old_value: null,
      new_value: change,
      edited_by: userId,
    })
    .execute();
}

export async function upsertBaseline(
  db: Database,
  typeId: string,
  slug: string,
  input: z.output<typeof BaselineInputSchema>,
  userId: string | null,
): Promise<{ slug: string; created: boolean }> {
  if (!SLUG_RE.test(slug)) throw badRequest('invalid slug');
  const def = await mergedDefinition(db, typeId);
  const unknown = (input.matchKeys ?? []).filter((k) => !def.parameters.some((p) => p.key === k));
  if (unknown.length) throw badRequest(`unknown parameter(s) ${unknown.join(', ')} in matchKeys`);

  return db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom('baselines')
      .selectAll()
      .where('test_type_id', '=', typeId)
      .where('slug', '=', slug)
      .forUpdate()
      .executeTakeFirst();
    const matchKeys = input.matchKeys ?? existing?.match_keys ?? [];
    const replace = input.runIds !== undefined || input.externalIds !== undefined;
    const members = replace
      ? await resolveRuns(tx, typeId, input.runIds ?? [], input.externalIds ?? [])
      : existing
        ? await tx
            .selectFrom('baseline_runs as br')
            .innerJoin('runs as r', 'r.id', 'br.run_id')
            .select(['r.id', 'r.params'])
            .where('br.baseline_id', '=', existing.id)
            .execute()
        : [];
    checkMembers(matchKeys, members);

    let id: string;
    if (!existing) {
      const row = await tx
        .insertInto('baselines')
        .values({
          test_type_id: typeId,
          slug,
          name: input.name,
          description: input.description,
          match_keys: matchKeys,
          created_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = row.id;
    } else {
      id = existing.id;
      await tx
        .updateTable('baselines')
        .set({
          name: input.name,
          description: input.description,
          match_keys: matchKeys,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .execute();
    }
    if (replace) {
      await tx.deleteFrom('baseline_runs').where('baseline_id', '=', id).execute();
      if (members.length) {
        await tx
          .insertInto('baseline_runs')
          .values(members.map((m) => ({ baseline_id: id, run_id: m.id })))
          .execute();
      }
    }
    await logEdit(
      tx,
      typeId,
      slug,
      `${existing ? 'updated' : 'created'}${replace ? ` with ${members.length} member(s)` : ''}`,
      userId,
    );
    return { slug, created: !existing };
  });
}

/** Add members; a member with the same match as an existing one replaces it. */
export async function addBaselineRuns(
  db: Database,
  typeId: string,
  slug: string,
  input: z.output<typeof BaselineRunsSchema>,
  userId: string | null,
): Promise<{ added: number; replaced: number }> {
  return db.transaction().execute(async (tx) => {
    const b = await getBaselineRow(tx, typeId, slug);
    const incoming = await resolveRuns(tx, typeId, input.runIds, input.externalIds);
    checkMembers(b.match_keys, incoming);
    const current = await tx
      .selectFrom('baseline_runs as br')
      .innerJoin('runs as r', 'r.id', 'br.run_id')
      .select(['r.id', 'r.params'])
      .where('br.baseline_id', '=', b.id)
      .execute();
    let added = 0;
    let replaced = 0;
    for (const run of incoming) {
      const tuple = JSON.stringify(matchOf(b.match_keys, run.params));
      const old = current.find((c) => JSON.stringify(matchOf(b.match_keys, c.params)) === tuple);
      if (old?.id === run.id) continue;
      if (old) {
        await tx
          .deleteFrom('baseline_runs')
          .where('baseline_id', '=', b.id)
          .where('run_id', '=', old.id)
          .execute();
        replaced++;
      } else {
        added++;
      }
      await tx.insertInto('baseline_runs').values({ baseline_id: b.id, run_id: run.id }).execute();
    }
    await tx.updateTable('baselines').set({ updated_at: new Date() }).where('id', '=', b.id).execute();
    await logEdit(tx, typeId, slug, `added ${added}, replaced ${replaced} member(s)`, userId);
    return { added, replaced };
  });
}

export async function removeBaselineRun(
  db: Database,
  typeId: string,
  slug: string,
  runId: string,
  userId: string | null,
): Promise<void> {
  const b = await getBaselineRow(db, typeId, slug);
  const res = await db
    .deleteFrom('baseline_runs')
    .where('baseline_id', '=', b.id)
    .where('run_id', '=', runId)
    .executeTakeFirst();
  if (!Number(res.numDeletedRows)) throw notFound('run is not a member of this baseline');
  await logEdit(db, typeId, slug, `removed member ${runId}`, userId);
}

/** Baselines each of these runs is a member of. */
export async function baselineMemberships(
  db: Database,
  runIds: string[],
): Promise<Map<string, { slug: string; name: string }[]>> {
  const out = new Map<string, { slug: string; name: string }[]>();
  if (!runIds.length) return out;
  const rows = await db
    .selectFrom('baseline_runs as br')
    .innerJoin('baselines as b', 'b.id', 'br.baseline_id')
    .select(['br.run_id', 'b.slug', 'b.name'])
    .where('br.run_id', 'in', runIds)
    .orderBy('b.name')
    .execute();
  for (const r of rows) {
    const list = out.get(r.run_id) ?? [];
    list.push({ slug: r.slug, name: r.name });
    out.set(r.run_id, list);
  }
  return out;
}

/**
 * Everything needed to compare runs of one type with their pinned baselines and
 * grade them against their targets. Targets come from the current definition, so a
 * newly added target also judges older runs (as the dashboard does with headlines).
 */
export async function typeReferences(db: Database, typeId: string) {
  const def: TypeDefinition = await mergedDefinition(db, typeId);
  const baselines = await listBaselines(db, typeId);
  const needsBest = def.dataPoints.some((d) => d.targets?.some((t) => t.ref === 'best'));
  // debt: 'best' targets scan every run of the type per request; revisit when a type
  // passes ~50k runs (keep a running-best table instead).
  const history = needsBest
    ? await db
        .selectFrom('runs')
        .select(['id', 'run_at', 'seq', 'params', 'results'])
        .where('test_type_id', '=', typeId)
        .orderBy('run_at')
        .orderBy('seq')
        .execute()
    : [];
  // Best earlier comparable value per run and data point.
  const bestBefore = new Map<string, Map<string, Reference>>();
  if (needsBest) {
    const running = new Map<string, Map<string, Reference>>();
    for (const r of history) {
      const idk = identityKey(def, r.params);
      const best = running.get(idk) ?? new Map<string, Reference>();
      bestBefore.set(r.id, new Map(best));
      for (const dp of def.dataPoints) {
        const v = r.results[dp.key];
        if (typeof v !== 'number') continue;
        const cur = best.get(dp.key);
        if (!cur || isBetter(dp.better, v, cur.value)) best.set(dp.key, { runId: r.id, value: v });
      }
      running.set(idk, best);
    }
  }

  function grade(run: {
    id: string;
    params: Record<string, string>;
    values: Record<string, Scalar>;
  }): TargetResult[] {
    return gradeTargets(def, run.values, {
      baseline: (slug, key) => {
        const b = baselines.find((x) => x.slug === slug);
        const m = b && memberFor(b, run.params, run.id);
        const v = m?.values[key];
        return m && typeof v === 'number' ? { runId: m.runId, value: v } : undefined;
      },
      best: (key) => bestBefore.get(run.id)?.get(key),
      baselineName: (slug) => baselines.find((x) => x.slug === slug)?.name,
    });
  }

  function compare(run: { id: string; params: Record<string, string>; values: Record<string, Scalar> }) {
    return baselines.flatMap((b) => {
      const m = memberFor(b, run.params, run.id);
      if (!m) return [];
      return [
        {
          slug: b.slug,
          name: b.name,
          runId: m.runId,
          runAt: m.runAt,
          label: m.label,
          match: m.match,
          points: compareToBaseline(def, run.values, m.values),
        },
      ];
    });
  }

  return { def, baselines, grade, compare, targetGrade };
}
