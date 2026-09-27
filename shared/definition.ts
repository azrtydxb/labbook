import { z } from 'zod';
import type { Scalar, TypeDefinition } from './types.js';

export const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

const key = z.string().regex(KEY_RE, 'keys start with a letter and use letters, digits, _ . -');

export const ParameterDefSchema = z.object({
  key,
  label: z.string().max(100).default(''),
  description: z.string().max(2000).default(''),
  identity: z.boolean().default(true),
});

export const BoundsSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    relMin: z.number().positive().optional(),
    relMax: z.number().positive().optional(),
    expected: z.union([z.boolean(), z.string()]).optional(),
  })
  .strict();

export const TargetSchema = z
  .object({
    ref: z
      .enum(['absolute', 'baseline', 'best'])
      .describe('absolute: min/max in the unit; baseline/best: min/max as ratios of the reference'),
    baseline: z.string().regex(SLUG_RE).optional().describe('Baseline slug, for ref=baseline'),
    min: z.number().optional(),
    max: z.number().optional(),
    label: z.string().max(100).optional(),
  })
  .strict()
  .refine((t) => t.min !== undefined || t.max !== undefined, { message: 'a target needs min or max' })
  .refine((t) => (t.ref === 'baseline') === (t.baseline !== undefined), {
    message: "give 'baseline' exactly when ref is 'baseline'",
  })
  .refine((t) => t.ref === 'absolute' || ((t.min ?? 1) > 0 && (t.max ?? 1) > 0), {
    message: 'relative targets are positive ratios, e.g. 0.75',
  });

export const DataPointDefSchema = z.object({
  key,
  label: z.string().max(100).default(''),
  unit: z.string().max(40).default(''),
  type: z.enum(['number', 'boolean', 'string']).default('number'),
  better: z.enum(['higher', 'lower', 'none']).default('none'),
  description: z.string().max(2000).default(''),
  bounds: BoundsSchema.optional(),
  targets: z
    .array(TargetSchema)
    .max(10)
    .optional()
    .describe('Zones that count as good; they grade runs on/below target and never change pass/fail'),
});

export const TypeDefinitionSchema = z
  .object({
    parameters: z.array(ParameterDefSchema).max(100).default([]),
    dataPoints: z.array(DataPointDefSchema).min(1).max(200),
    primary: z.string().optional(),
  })
  .superRefine((def, ctx) => {
    const seen = new Set<string>();
    for (const p of def.parameters) {
      if (seen.has(p.key)) ctx.addIssue({ code: 'custom', message: `duplicate parameter key ${p.key}` });
      seen.add(p.key);
    }
    const dps = new Set<string>();
    for (const d of def.dataPoints) {
      if (dps.has(d.key)) ctx.addIssue({ code: 'custom', message: `duplicate data point key ${d.key}` });
      dps.add(d.key);
      const b = d.bounds;
      if (b && d.type !== 'number' && (b.min ?? b.max ?? b.relMin ?? b.relMax) !== undefined) {
        ctx.addIssue({ code: 'custom', message: `${d.key}: numeric bounds on a ${d.type} data point` });
      }
      if (b?.expected !== undefined && d.type === 'number') {
        ctx.addIssue({ code: 'custom', message: `${d.key}: 'expected' applies to boolean/string only` });
      }
      if (b?.expected !== undefined && d.type !== typeof b.expected) {
        ctx.addIssue({ code: 'custom', message: `${d.key}: 'expected' must be a ${d.type}` });
      }
      if (d.targets?.length && d.type !== 'number') {
        ctx.addIssue({ code: 'custom', message: `${d.key}: targets apply to number data points only` });
      }
      if (d.targets?.some((t) => t.ref === 'best') && d.better === 'none') {
        ctx.addIssue({ code: 'custom', message: `${d.key}: a 'best' target needs better=higher or lower` });
      }
    }
    if (def.primary && !dps.has(def.primary)) {
      ctx.addIssue({ code: 'custom', message: `primary ${def.primary} is not a data point` });
    }
  });

export type TypeDefinitionInput = z.input<typeof TypeDefinitionSchema>;

/** Parse and fill defaults; labels default to the key. */
export function normalizeDefinition(input: unknown): TypeDefinition {
  const def = TypeDefinitionSchema.parse(input);
  return {
    parameters: def.parameters.map((p) => ({ ...p, label: p.label || p.key })),
    dataPoints: def.dataPoints.map((d) => ({ ...d, label: d.label || d.key })),
    ...(def.primary ? { primary: def.primary } : {}),
  };
}

/** Deterministic JSON so that equal definitions compare equal. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * A schema change must not break the runs recorded under older versions: keys may
 * be added, removed or relabelled, but an existing data point keeps its value type.
 */
export function incompatibleChanges(prev: TypeDefinition, next: TypeDefinition): string[] {
  const out: string[] = [];
  for (const d of next.dataPoints) {
    const old = prev.dataPoints.find((p) => p.key === d.key);
    if (old && old.type !== d.type) {
      out.push(`data point ${d.key} changes type ${old.type} → ${d.type}; add a new key instead`);
    }
  }
  return out;
}

/** Check submitted values against a definition. Returns the error messages. */
export function validateValues(def: TypeDefinition, values: Record<string, Scalar>): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    const dp = def.dataPoints.find((d) => d.key === k);
    if (!dp) {
      errors.push(`unknown data point '${k}' (known: ${def.dataPoints.map((d) => d.key).join(', ')})`);
      continue;
    }
    if (v === null) continue;
    if (dp.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) {
      errors.push(`data point '${k}' must be a finite number`);
    } else if (dp.type !== 'number' && typeof v !== dp.type) {
      errors.push(`data point '${k}' must be a ${dp.type}`);
    }
  }
  return errors;
}

/** Parameters are stored as strings so that grouping and filtering are exact. */
export function normalizeParams(params: Record<string, Scalar>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}
