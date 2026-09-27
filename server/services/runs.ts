import { createHash } from 'node:crypto';
import { sql, type SelectQueryBuilder } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import type { Links } from '../db/schema.js';
import { autoStatus, evaluateRun } from '../../shared/evaluate.js';
import { normalizeParams, SLUG_RE, validateValues } from '../../shared/definition.js';
import type { RunStatus, Scalar, TypeDefinition } from '../../shared/types.js';
import { badRequest, notFound } from '../errors.js';
import { getDefinition } from './testTypes.js';

const scalar = z.union([z.number(), z.boolean(), z.string(), z.null()]);

export const LinksSchema = z
  .object({
    commit: z.string().max(200).optional(),
    branch: z.string().max(200).optional(),
    ciUrl: z.string().max(2000).optional(),
    other: z
      .array(z.object({ label: z.string().max(200), url: z.string().max(2000) }))
      .max(50)
      .optional(),
  })
  .strict();

export const InlineAttachmentSchema = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: z.string().max(200).optional(),
    content: z.string().optional().describe('UTF-8 text content'),
    contentBase64: z.string().optional().describe('Binary content, base64'),
  })
  .refine((a) => (a.content === undefined) !== (a.contentBase64 === undefined), {
    message: 'give exactly one of content / contentBase64',
  });

export const RunInputSchema = z.object({
  type: z.string().describe('Test type slug'),
  typeVersion: z.number().int().positive().optional().describe('Defaults to the current version'),
  externalId: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe('Client-chosen id; re-submitting the same id updates the run instead of duplicating it'),
  runAt: z.iso.datetime({ offset: true }).optional().describe('When the test ran (default: now)'),
  source: z.string().max(300).optional().describe('Who or what produced the run (host, script, CI job)'),
  status: z.enum(['pass', 'fail', 'error', 'info']).optional().describe('Default: computed from the bounds'),
  params: z.record(z.string(), scalar).default({}),
  values: z.record(z.string(), scalar).default({}),
  notes: z.string().max(200_000).optional(),
  conclusion: z.string().max(200_000).optional(),
  links: LinksSchema.optional(),
  sets: z.array(z.string().regex(SLUG_RE)).max(50).optional().describe('Set slugs; missing sets are created'),
  attachments: z.array(InlineAttachmentSchema).max(50).optional(),
  preserveText: z
    .boolean()
    .optional()
    .describe('When the run already exists, keep its notes and conclusion (importers re-running a backfill)'),
});
export type RunInput = z.output<typeof RunInputSchema>;

export interface Actor {
  userId: string | null;
  tokenId: string | null;
}

type Tx = Database;

async function recordEdit(
  db: Tx,
  entity: 'run' | 'set' | 'test_type',
  id: string,
  field: string,
  oldValue: string | null,
  newValue: string | null,
  userId: string | null,
): Promise<void> {
  await db
    .insertInto('edits')
    .values({
      entity_type: entity,
      entity_id: id,
      field,
      old_value: oldValue,
      new_value: newValue,
      edited_by: userId,
    })
    .execute();
}

/** The previous run of the same type whose identity parameters match. */
export async function findBaseline(
  db: Database,
  typeId: string,
  def: TypeDefinition,
  params: Record<string, string>,
  runAt: Date,
  opts: { beforeSeq?: number; excludeId?: string } = {},
) {
  const identity: Record<string, string> = {};
  for (const p of def.parameters) {
    const v = params[p.key];
    if (p.identity && v !== undefined) identity[p.key] = v;
  }
  let q = db
    .selectFrom('runs')
    .select(['id', 'seq', 'run_at', 'results', 'params', 'status', 'external_id'])
    .where('test_type_id', '=', typeId)
    .where(sql<boolean>`params @> ${JSON.stringify(identity)}::jsonb`)
    .where(
      sql<boolean>`(run_at, seq) < (${runAt}::timestamptz, ${opts.beforeSeq ?? Number.MAX_SAFE_INTEGER}::bigint)`,
    );
  if (opts.excludeId) q = q.where('id', '<>', opts.excludeId);
  return q.orderBy('run_at', 'desc').orderBy('seq', 'desc').limit(1).executeTakeFirst();
}

export async function ensureSets(db: Tx, slugs: string[], userId: string | null): Promise<string[]> {
  const ids: string[] = [];
  for (const slug of slugs) {
    const found = await db.selectFrom('sets').select('id').where('slug', '=', slug).executeTakeFirst();
    if (found) {
      ids.push(found.id);
      continue;
    }
    const row = await db
      .insertInto('sets')
      .values({ slug, name: slug, created_by: userId })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ slug }))
      .returning('id')
      .executeTakeFirstOrThrow();
    ids.push(row.id);
  }
  return ids;
}

export async function linkRunToSets(db: Tx, runId: string, setIds: string[]): Promise<void> {
  if (!setIds.length) return;
  await db
    .insertInto('set_runs')
    .values(setIds.map((set_id) => ({ set_id, run_id: runId })))
    .onConflict((oc) => oc.columns(['set_id', 'run_id']).doNothing())
    .execute();
}

export async function upsertAttachment(
  db: Tx,
  runId: string,
  file: { filename: string; contentType: string; data: Buffer },
  maxBytes: number,
  userId: string | null,
): Promise<{ id: string; size: number }> {
  if (file.data.length > maxBytes) {
    throw badRequest(`attachment ${file.filename} is ${file.data.length} bytes; the limit is ${maxBytes}`);
  }
  const filename = file.filename.replace(/[/\\]/g, '_');
  const sha = createHash('sha256').update(file.data).digest('hex');
  const row = await db
    .insertInto('attachments')
    .values({
      run_id: runId,
      filename,
      content_type: file.contentType || guessContentType(filename),
      size_bytes: file.data.length,
      sha256: sha,
      data: file.data,
      uploaded_by: userId,
    })
    .onConflict((oc) =>
      oc.columns(['run_id', 'filename']).doUpdateSet((eb) => ({
        content_type: eb.ref('excluded.content_type'),
        size_bytes: eb.ref('excluded.size_bytes'),
        sha256: eb.ref('excluded.sha256'),
        data: eb.ref('excluded.data'),
        uploaded_by: eb.ref('excluded.uploaded_by'),
        created_at: sql`now()`,
      })),
    )
    .returning(['id', 'size_bytes'])
    .executeTakeFirstOrThrow();
  return { id: row.id, size: row.size_bytes };
}

export function guessContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    json: 'application/json',
    txt: 'text/plain',
    log: 'text/plain',
    err: 'text/plain',
    out: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    html: 'text/html',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gz: 'application/gzip',
    tgz: 'application/gzip',
    zip: 'application/zip',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

function cleanLinks(l: z.output<typeof LinksSchema> | undefined): Links {
  if (!l) return {};
  const out: Links = {};
  if (l.commit) out.commit = l.commit;
  if (l.branch) out.branch = l.branch;
  if (l.ciUrl) out.ciUrl = l.ciUrl;
  if (l.other?.length) out.other = l.other;
  return out;
}

/**
 * Submit one run. With an externalId that already exists for this type, the run is
 * updated in place (idempotent re-upload); every changed field lands in the edit log.
 */
export async function submitRun(
  db: Database,
  input: RunInput,
  actor: Actor,
  maxAttachmentBytes: number,
): Promise<{ id: string; created: boolean; status: RunStatus; changed: string[] }> {
  return db.transaction().execute(async (tx) => {
    const t = await tx
      .selectFrom('test_types')
      .select(['id', 'current_version'])
      .where('slug', '=', input.type)
      .executeTakeFirst();
    if (!t)
      throw notFound(`test type '${input.type}' not found; define it first (PUT /api/v1/test-types/{slug})`);
    const version = input.typeVersion ?? t.current_version;
    if (version > t.current_version) throw badRequest(`test type '${input.type}' has no version ${version}`);
    const def = await getDefinition(tx, t.id, version);

    const errors = validateValues(def, input.values);
    if (errors.length) throw badRequest('invalid values', errors);
    const params = normalizeParams(input.params);
    const values: Record<string, Scalar> = {};
    for (const [k, v] of Object.entries(input.values)) if (v !== null) values[k] = v;
    const runAt = input.runAt ? new Date(input.runAt) : new Date();

    const existing = input.externalId
      ? await tx
          .selectFrom('runs')
          .selectAll()
          .where('test_type_id', '=', t.id)
          .where('external_id', '=', input.externalId)
          .forUpdate()
          .executeTakeFirst()
      : undefined;

    const baseline = await findBaseline(tx, t.id, def, params, runAt, {
      ...(existing ? { beforeSeq: existing.seq, excludeId: existing.id } : {}),
    });
    const evaluation = evaluateRun(def, values, baseline?.results ?? null);
    const status: RunStatus = input.status ?? autoStatus(evaluation);
    const statusAuto = input.status === undefined;
    const links = input.links ? cleanLinks(input.links) : undefined;

    let id: string;
    let created: boolean;
    const changed: string[] = [];
    if (!existing) {
      const row = await tx
        .insertInto('runs')
        .values({
          test_type_id: t.id,
          type_version: version,
          external_id: input.externalId ?? null,
          run_at: runAt,
          source: input.source ?? '',
          submitted_by: actor.userId,
          token_id: actor.tokenId,
          params: JSON.stringify(params),
          results: JSON.stringify(values),
          status,
          status_auto: statusAuto,
          notes: input.notes ?? '',
          conclusion: input.conclusion ?? '',
          links: JSON.stringify(links ?? {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = row.id;
      created = true;
    } else {
      id = existing.id;
      created = false;
      const next = {
        type_version: version,
        run_at: runAt,
        source: input.source ?? existing.source,
        params,
        results: values,
        status: input.status ?? (existing.status_auto ? status : existing.status),
        notes: input.preserveText ? existing.notes : (input.notes ?? existing.notes),
        conclusion: input.preserveText ? existing.conclusion : (input.conclusion ?? existing.conclusion),
        links: links ?? existing.links,
      };
      const before: Record<string, unknown> = {
        type_version: existing.type_version,
        run_at: existing.run_at.toISOString(),
        source: existing.source,
        params: existing.params,
        results: existing.results,
        status: existing.status,
        notes: existing.notes,
        conclusion: existing.conclusion,
        links: existing.links,
      };
      const after: Record<string, unknown> = { ...next, run_at: runAt.toISOString() };
      for (const field of Object.keys(after)) {
        const o = stringifyField(before[field]);
        const n = stringifyField(after[field]);
        if (o !== n) {
          changed.push(field);
          await recordEdit(tx, 'run', id, field === 'results' ? 'values' : field, o, n, actor.userId);
        }
      }
      if (changed.length) {
        await tx
          .updateTable('runs')
          .set({
            type_version: next.type_version,
            run_at: next.run_at,
            source: next.source,
            params: JSON.stringify(next.params),
            results: JSON.stringify(next.results),
            status: next.status,
            status_auto: input.status === undefined ? existing.status_auto : false,
            notes: next.notes,
            conclusion: next.conclusion,
            links: JSON.stringify(next.links),
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .execute();
      }
    }

    if (input.sets?.length) await linkRunToSets(tx, id, await ensureSets(tx, input.sets, actor.userId));
    for (const a of input.attachments ?? []) {
      const data =
        a.contentBase64 !== undefined
          ? Buffer.from(a.contentBase64, 'base64')
          : Buffer.from(a.content ?? '', 'utf8');
      await upsertAttachment(
        tx,
        id,
        { filename: a.filename, contentType: a.contentType ?? '', data },
        maxAttachmentBytes,
        actor.userId,
      );
    }
    const finalStatus = await tx
      .selectFrom('runs')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { id, created, status: finalStatus.status, changed };
  });
}

function stringifyField(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

export const RunPatchSchema = z
  .object({
    status: z.enum(['pass', 'fail', 'error', 'info']).optional(),
    notes: z.string().max(200_000).optional(),
    conclusion: z.string().max(200_000).optional(),
    links: LinksSchema.optional(),
    source: z.string().max(300).optional(),
    runAt: z.iso.datetime({ offset: true }).optional(),
    params: z.record(z.string(), scalar).optional(),
    values: z.record(z.string(), scalar).optional(),
  })
  .strict();

export async function patchRun(
  db: Database,
  id: string,
  patch: z.output<typeof RunPatchSchema>,
  userId: string | null,
): Promise<string[]> {
  return db.transaction().execute(async (tx) => {
    const run = await tx.selectFrom('runs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!run) throw notFound('run not found');
    const set: Record<string, unknown> = {};
    const changed: string[] = [];
    const change = async (field: string, column: string, oldV: unknown, newV: unknown, stored: unknown) => {
      const o = stringifyField(oldV);
      const n = stringifyField(newV);
      if (o === n) return;
      changed.push(field);
      set[column] = stored;
      await recordEdit(tx, 'run', id, field, o, n, userId);
    };
    if (patch.status !== undefined) {
      await change('status', 'status', run.status, patch.status, patch.status);
      if (changed.includes('status')) set.status_auto = false;
    }
    if (patch.notes !== undefined) await change('notes', 'notes', run.notes, patch.notes, patch.notes);
    if (patch.conclusion !== undefined)
      await change('conclusion', 'conclusion', run.conclusion, patch.conclusion, patch.conclusion);
    if (patch.source !== undefined) await change('source', 'source', run.source, patch.source, patch.source);
    if (patch.runAt !== undefined) {
      const d = new Date(patch.runAt);
      await change('run_at', 'run_at', run.run_at.toISOString(), d.toISOString(), d);
    }
    if (patch.links !== undefined) {
      const l = cleanLinks(patch.links);
      await change('links', 'links', run.links, l, JSON.stringify(l));
    }
    if (patch.params !== undefined) {
      const p = normalizeParams(patch.params);
      await change('params', 'params', run.params, p, JSON.stringify(p));
    }
    if (patch.values !== undefined) {
      const def = await getDefinition(tx, run.test_type_id, run.type_version);
      const errors = validateValues(def, patch.values);
      if (errors.length) throw badRequest('invalid values', errors);
      const v: Record<string, Scalar> = {};
      for (const [k, x] of Object.entries(patch.values)) if (x !== null) v[k] = x;
      await change('values', 'results', run.results, v, JSON.stringify(v));
    }
    if (changed.length) {
      await tx
        .updateTable('runs')
        .set({ ...set, updated_at: new Date() } as never)
        .where('id', '=', id)
        .execute();
    }
    return changed;
  });
}

export interface RunFilter {
  type?: string | undefined;
  set?: string | undefined;
  status?: RunStatus[] | undefined;
  params?: Record<string, string> | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
  ids?: string[] | undefined;
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
}

function applyFilter<QB extends SelectQueryBuilder<any, any, any>>(db: Database, q: QB, f: RunFilter): QB {
  let out: SelectQueryBuilder<any, any, any> = q;
  if (f.type) out = out.where('t.slug', '=', f.type);
  if (f.set) {
    out = out.where(
      'r.id',
      'in',
      db
        .selectFrom('set_runs as sr')
        .innerJoin('sets as s', 's.id', 'sr.set_id')
        .select('sr.run_id')
        .where('s.slug', '=', f.set),
    );
  }
  if (f.status?.length) out = out.where('r.status', 'in', f.status);
  if (f.params && Object.keys(f.params).length) {
    out = out.where(sql<boolean>`r.params @> ${JSON.stringify(f.params)}::jsonb`);
  }
  if (f.from) out = out.where('r.run_at', '>=', new Date(f.from));
  if (f.to) out = out.where('r.run_at', '<=', new Date(f.to));
  if (f.ids?.length) out = out.where('r.id', 'in', f.ids);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    out = out.where(
      sql<boolean>`(r.notes ilike ${like} or r.conclusion ilike ${like} or r.external_id ilike ${like}
        or r.params::text ilike ${like} or r.source ilike ${like} or r.links::text ilike ${like})`,
    );
  }
  return out as QB;
}

export async function listRuns(db: Database, f: RunFilter) {
  const base = db
    .selectFrom('runs as r')
    .innerJoin('test_types as t', 't.id', 'r.test_type_id')
    .leftJoin('users as u', 'u.id', 'r.submitted_by');
  const rows = await applyFilter(
    db,
    base.select([
      'r.id',
      'r.seq',
      'r.type_version',
      'r.external_id',
      'r.run_at',
      'r.created_at',
      'r.updated_at',
      'r.source',
      'r.params',
      'r.results',
      'r.status',
      'r.status_auto',
      'r.notes',
      'r.conclusion',
      'r.links',
      't.slug as type_slug',
      't.name as type_name',
      't.id as type_id',
      'u.username as submitted_by',
    ]),
    f,
  )
    .orderBy('r.run_at', f.order)
    .orderBy('r.seq', f.order)
    .limit(f.limit)
    .offset(f.offset)
    .execute();
  const countRow = await applyFilter(
    db,
    base.select((eb) => eb.fn.countAll<number>().as('n')),
    f,
  ).executeTakeFirst();
  const ids = rows.map((r) => r.id);
  const [sets, atts] = ids.length
    ? await Promise.all([
        db
          .selectFrom('set_runs as sr')
          .innerJoin('sets as s', 's.id', 'sr.set_id')
          .select(['sr.run_id', 's.slug', 's.name'])
          .where('sr.run_id', 'in', ids)
          .execute(),
        db
          .selectFrom('attachments')
          .select(['run_id', (eb) => eb.fn.countAll<number>().as('n')])
          .where('run_id', 'in', ids)
          .groupBy('run_id')
          .execute(),
      ])
    : [[], []];
  return {
    total: Number(countRow?.n ?? 0),
    runs: rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      type: { slug: r.type_slug, name: r.type_name },
      typeVersion: r.type_version,
      externalId: r.external_id,
      runAt: r.run_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      source: r.source,
      submittedBy: r.submitted_by,
      params: r.params,
      values: r.results,
      status: r.status,
      statusAuto: r.status_auto,
      notes: r.notes,
      conclusion: r.conclusion,
      links: r.links,
      sets: sets.filter((s) => s.run_id === r.id).map((s) => ({ slug: s.slug, name: s.name })),
      attachmentCount: Number(atts.find((a) => a.run_id === r.id)?.n ?? 0),
    })),
  };
}

export type RunSummary = Awaited<ReturnType<typeof listRuns>>['runs'][number];

export async function getRunDetail(db: Database, id: string) {
  const { runs } = await listRuns(db, { ids: [id], limit: 1, offset: 0, order: 'desc' });
  const run = runs[0];
  if (!run) throw notFound('run not found');
  const row = await db
    .selectFrom('runs')
    .select(['test_type_id', 'seq', 'run_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  const def = await getDefinition(db, row.test_type_id, run.typeVersion);
  const baselineRow = await findBaseline(db, row.test_type_id, def, run.params, row.run_at, {
    beforeSeq: row.seq,
    excludeId: id,
  });
  const evaluation = evaluateRun(def, run.values, baselineRow?.results ?? null);
  const [attachments, edits, type] = await Promise.all([
    db
      .selectFrom('attachments as a')
      .leftJoin('users as u', 'u.id', 'a.uploaded_by')
      .select([
        'a.id',
        'a.filename',
        'a.content_type',
        'a.size_bytes',
        'a.sha256',
        'a.created_at',
        'u.username',
      ])
      .where('a.run_id', '=', id)
      .orderBy('a.filename')
      .execute(),
    db
      .selectFrom('edits as e')
      .leftJoin('users as u', 'u.id', 'e.edited_by')
      .select(['e.id', 'e.field', 'e.old_value', 'e.new_value', 'e.edited_at', 'u.username'])
      .where('e.entity_type', '=', 'run')
      .where('e.entity_id', '=', id)
      .orderBy('e.edited_at', 'desc')
      .orderBy('e.id', 'desc')
      .execute(),
    db
      .selectFrom('test_types')
      .select(['slug', 'name', 'current_version'])
      .where('id', '=', row.test_type_id)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    ...run,
    type: { slug: type.slug, name: type.name, currentVersion: type.current_version },
    definition: def,
    evaluation,
    baseline: baselineRow
      ? {
          id: baselineRow.id,
          seq: baselineRow.seq,
          runAt: baselineRow.run_at,
          externalId: baselineRow.external_id,
          params: baselineRow.params,
          values: baselineRow.results,
          status: baselineRow.status,
        }
      : null,
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.content_type,
      size: a.size_bytes,
      sha256: a.sha256,
      createdAt: a.created_at,
      uploadedBy: a.username,
    })),
    edits: edits.map((e) => ({
      id: e.id,
      field: e.field,
      oldValue: e.old_value,
      newValue: e.new_value,
      editedAt: e.edited_at,
      editedBy: e.username,
    })),
  };
}
