import { z } from 'zod';
import type { Database } from '../db/index.js';
import {
  canonicalJson,
  incompatibleChanges,
  normalizeDefinition,
  SLUG_RE,
  TypeDefinitionSchema,
} from '../../shared/definition.js';
import type { TypeDefinition } from '../../shared/types.js';
import { badRequest, conflict, notFound } from '../errors.js';

export const TypeInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(20000).default(''),
  tags: z.array(z.string().min(1).max(50)).max(30).default([]),
  definition: TypeDefinitionSchema,
  note: z.string().max(2000).optional().describe('Why the schema changed (kept with the new version).'),
});
export const TypeCreateSchema = TypeInputSchema.extend({
  slug: z.string().regex(SLUG_RE, 'lowercase letters, digits, . _ -'),
});
export type TypeInput = z.input<typeof TypeInputSchema>;

const defCache = new Map<string, TypeDefinition>();

/** Versions are immutable, so a definition can be cached forever. */
export async function getDefinition(db: Database, typeId: string, version: number): Promise<TypeDefinition> {
  const k = `${typeId}:${version}`;
  const hit = defCache.get(k);
  if (hit) return hit;
  const row = await db
    .selectFrom('test_type_versions')
    .select('definition')
    .where('test_type_id', '=', typeId)
    .where('version', '=', version)
    .executeTakeFirst();
  if (!row) throw notFound(`test type version ${version} not found`);
  defCache.set(k, row.definition);
  return row.definition;
}

export async function getTypeBySlug(db: Database, slug: string) {
  const t = await db.selectFrom('test_types').selectAll().where('slug', '=', slug).executeTakeFirst();
  if (!t) throw notFound(`test type '${slug}' not found`);
  return t;
}

export async function typeDto(db: Database, t: Awaited<ReturnType<typeof getTypeBySlug>>) {
  const definition = await getDefinition(db, t.id, t.current_version);
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    tags: t.tags,
    version: t.current_version,
    definition,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

/**
 * Create a type, or update it in place. A changed definition becomes a new version;
 * runs keep the version they were recorded under.
 */
export async function upsertType(
  db: Database,
  slug: string,
  input: z.output<typeof TypeInputSchema>,
  actorId: string | null,
  mode: 'create' | 'upsert',
): Promise<{ created: boolean; versionCreated: boolean; version: number }> {
  if (!SLUG_RE.test(slug)) throw badRequest('invalid slug');
  const definition = normalizeDefinition(input.definition);
  return db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom('test_types')
      .selectAll()
      .where('slug', '=', slug)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      const t = await tx
        .insertInto('test_types')
        .values({
          slug,
          name: input.name,
          description: input.description,
          tags: input.tags,
          current_version: 1,
          created_by: actorId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('test_type_versions')
        .values({
          test_type_id: t.id,
          version: 1,
          definition: JSON.stringify(definition),
          note: input.note ?? 'initial version',
          created_by: actorId,
        })
        .execute();
      return { created: true, versionCreated: true, version: 1 };
    }
    if (mode === 'create') throw conflict(`test type '${slug}' already exists`);

    const current = await getDefinition(tx, existing.id, existing.current_version);
    let version = existing.current_version;
    let versionCreated = false;
    if (canonicalJson(current) !== canonicalJson(definition)) {
      const problems = incompatibleChanges(current, definition);
      if (problems.length) throw badRequest('incompatible schema change', problems);
      version += 1;
      versionCreated = true;
      await tx
        .insertInto('test_type_versions')
        .values({
          test_type_id: existing.id,
          version,
          definition: JSON.stringify(definition),
          note: input.note ?? '',
          created_by: actorId,
        })
        .execute();
    }
    const changedMeta =
      existing.name !== input.name ||
      existing.description !== input.description ||
      canonicalJson(existing.tags) !== canonicalJson(input.tags);
    if (versionCreated || changedMeta) {
      await tx
        .updateTable('test_types')
        .set({
          name: input.name,
          description: input.description,
          tags: input.tags,
          current_version: version,
          updated_at: new Date(),
        })
        .where('id', '=', existing.id)
        .execute();
      if (versionCreated) {
        await tx
          .insertInto('edits')
          .values({
            entity_type: 'test_type',
            entity_id: existing.id,
            field: 'definition',
            old_value: `v${existing.current_version}`,
            new_value: `v${version}${input.note ? `: ${input.note}` : ''}`,
            edited_by: actorId,
          })
          .execute();
      }
    }
    return { created: false, versionCreated, version };
  });
}

/**
 * The union of data points and parameters over every version, latest first, so
 * charts and tables can show runs recorded under older schemas.
 */
export async function mergedDefinition(db: Database, typeId: string): Promise<TypeDefinition> {
  const rows = await db
    .selectFrom('test_type_versions')
    .select('definition')
    .where('test_type_id', '=', typeId)
    .orderBy('version', 'desc')
    .execute();
  const merged: TypeDefinition = { parameters: [], dataPoints: [] };
  for (const [i, { definition }] of rows.entries()) {
    if (i === 0 && definition.primary) merged.primary = definition.primary;
    for (const p of definition.parameters)
      if (!merged.parameters.some((x) => x.key === p.key)) merged.parameters.push(p);
    for (const d of definition.dataPoints)
      if (!merged.dataPoints.some((x) => x.key === d.key)) merged.dataPoints.push(d);
  }
  return merged;
}
