import type {
  DataPointDef,
  PointEvaluation,
  RunEvaluation,
  RunStatus,
  Scalar,
  Target,
  TypeDefinition,
} from './types.js';

/** The headline data point of a definition: `primary`, else the first number. */
export function primaryPoint(def: TypeDefinition): DataPointDef | undefined {
  if (def.primary) {
    const p = def.dataPoints.find((d) => d.key === def.primary);
    if (p) return p;
  }
  return def.dataPoints.find((d) => d.type === 'number') ?? def.dataPoints[0];
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toPrecision(4);
}

export function evaluatePoint(
  dp: DataPointDef,
  value: Scalar | undefined,
  baseline: Scalar | undefined,
): PointEvaluation {
  const out: PointEvaluation = {
    key: dp.key,
    value,
    baseline,
    delta: null,
    deltaPct: null,
    improved: null,
    verdict: 'none',
    reasons: [],
  };
  if (value === undefined || value === null) {
    out.verdict = 'missing';
    return out;
  }
  if (dp.type === 'number' && typeof value === 'number' && typeof baseline === 'number') {
    out.delta = value - baseline;
    out.deltaPct = baseline !== 0 ? (value - baseline) / Math.abs(baseline) : null;
    if (dp.better === 'higher' && out.delta !== 0) out.improved = out.delta > 0;
    if (dp.better === 'lower' && out.delta !== 0) out.improved = out.delta < 0;
  }
  const b = dp.bounds;
  if (!b) return out;
  let checked = false;
  let failed = false;
  if (dp.type === 'number' && typeof value === 'number') {
    if (b.min !== undefined) {
      checked = true;
      if (value < b.min) {
        failed = true;
        out.reasons.push(`${fmt(value)} < min ${fmt(b.min)}`);
      }
    }
    if (b.max !== undefined) {
      checked = true;
      if (value > b.max) {
        failed = true;
        out.reasons.push(`${fmt(value)} > max ${fmt(b.max)}`);
      }
    }
    if (typeof baseline === 'number' && baseline !== 0) {
      const ratio = value / baseline;
      if (b.relMin !== undefined) {
        checked = true;
        if (ratio < b.relMin) {
          failed = true;
          out.reasons.push(`${fmt(ratio)}× baseline < ${fmt(b.relMin)}×`);
        }
      }
      if (b.relMax !== undefined) {
        checked = true;
        if (ratio > b.relMax) {
          failed = true;
          out.reasons.push(`${fmt(ratio)}× baseline > ${fmt(b.relMax)}×`);
        }
      }
    }
  }
  if (b.expected !== undefined && dp.type !== 'number') {
    checked = true;
    if (value !== b.expected) {
      failed = true;
      out.reasons.push(`expected ${String(b.expected)}, got ${String(value)}`);
    }
  }
  if (checked) out.verdict = failed ? 'fail' : 'pass';
  return out;
}

export function evaluateRun(
  def: TypeDefinition,
  values: Record<string, Scalar>,
  baseline: Record<string, Scalar> | null | undefined,
): RunEvaluation {
  const points = def.dataPoints.map((dp) => evaluatePoint(dp, values[dp.key], baseline?.[dp.key]));
  const verdict = points.some((p) => p.verdict === 'fail')
    ? 'fail'
    : points.some((p) => p.verdict === 'pass')
      ? 'pass'
      : 'none';
  return { verdict, points };
}

/** The status a run gets when the submitter does not state one. */
export function autoStatus(evaluation: RunEvaluation): RunStatus {
  if (evaluation.verdict === 'fail') return 'fail';
  if (evaluation.verdict === 'pass') return 'pass';
  return 'info';
}

/** A run's parameters restricted to a baseline's match keys. */
export function matchOf(matchKeys: string[], params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(matchKeys.map((k) => [k, params[k] ?? '']));
}

/** Whether a baseline member (by its match) applies to a run with these parameters. */
export function memberMatches(match: Record<string, string>, params: Record<string, string>): boolean {
  return Object.entries(match).every(([k, v]) => (params[k] ?? '') === v);
}

export interface BaselinePoint {
  key: string;
  value: Scalar | undefined;
  baseline: Scalar | undefined;
  delta: number | null;
  /** Fraction of the baseline, e.g. 0.03 = 3% above. */
  deltaPct: number | null;
  /** value / baseline, e.g. 1.03 = 103% of the baseline. */
  ratio: number | null;
  improved: boolean | null;
}

/**
 * Every data point against a pinned baseline. Informational only: bounds (and so
 * the verdict) keep comparing with the previous comparable run.
 */
export function compareToBaseline(
  def: TypeDefinition,
  values: Record<string, Scalar>,
  baseline: Record<string, Scalar>,
): BaselinePoint[] {
  return def.dataPoints.map((dp) => {
    const {
      key,
      value,
      baseline: b,
      delta,
      deltaPct,
      improved,
    } = evaluatePoint({ ...dp, bounds: undefined }, values[dp.key], baseline[dp.key]);
    const ratio = typeof value === 'number' && typeof b === 'number' && b !== 0 ? value / b : null;
    return { key, value, baseline: b, delta, deltaPct, ratio, improved };
  });
}

export interface TargetResult {
  key: string;
  /** Position of the target in the data point's `targets`. */
  index: number;
  label: string;
  ref: Target['ref'];
  baseline?: string | undefined;
  /** The run the zone is relative to (baseline member or earlier best), if any. */
  referenceRunId: string | null;
  reference: number | null;
  /** The zone in the data point's unit. */
  zone: { min: number | null; max: number | null };
  value: number | null;
  /** unknown: no value, or no reference to measure against. */
  verdict: 'on' | 'off' | 'unknown';
}

export interface Reference {
  runId: string;
  value: number;
}

/** The zone of one target in absolute units, or null when its reference is missing. */
export function targetZone(
  t: Target,
  reference: number | null,
): { min: number | null; max: number | null } | null {
  if (t.ref === 'absolute') return { min: t.min ?? null, max: t.max ?? null };
  if (reference === null) return null;
  // Ratios of a negative reference would flip the zone; order the ends.
  const a = t.min !== undefined ? t.min * reference : null;
  const b = t.max !== undefined ? t.max * reference : null;
  if (reference < 0 && a !== null && b !== null) return { min: b, max: a };
  return { min: a, max: b };
}

export function targetLabel(t: Target, baselineName?: string): string {
  if (t.label) return t.label;
  const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;
  const range =
    t.ref === 'absolute'
      ? [t.min !== undefined ? `≥ ${fmt(t.min)}` : '', t.max !== undefined ? `≤ ${fmt(t.max)}` : '']
      : [t.min !== undefined ? `≥ ${pct(t.min)}` : '', t.max !== undefined ? `≤ ${pct(t.max)}` : ''];
  const of = t.ref === 'baseline' ? ` of ${baselineName ?? t.baseline}` : t.ref === 'best' ? ' of best' : '';
  return `${range.filter(Boolean).join(' and ')}${of}`;
}

/**
 * Grade a run's values against the targets of its definition. `baseline(slug)`
 * gives the matching member of a pinned baseline; `best(key)` the best earlier
 * comparable value. Informational: never affects pass/fail.
 */
export function gradeTargets(
  def: TypeDefinition,
  values: Record<string, Scalar>,
  refs: {
    baseline: (slug: string, key: string) => Reference | undefined;
    best: (key: string) => Reference | undefined;
    baselineName?: (slug: string) => string | undefined;
  },
): TargetResult[] {
  const out: TargetResult[] = [];
  for (const dp of def.dataPoints) {
    for (const [index, t] of (dp.targets ?? []).entries()) {
      const r =
        t.ref === 'baseline'
          ? refs.baseline(t.baseline ?? '', dp.key)
          : t.ref === 'best'
            ? refs.best(dp.key)
            : undefined;
      const v = values[dp.key];
      const value = typeof v === 'number' ? v : null;
      const zone = targetZone(t, r?.value ?? null);
      let verdict: TargetResult['verdict'] = 'unknown';
      if (zone && value !== null) {
        verdict =
          (zone.min === null || value >= zone.min) && (zone.max === null || value <= zone.max) ? 'on' : 'off';
      }
      out.push({
        key: dp.key,
        index,
        label: targetLabel(t, t.baseline ? refs.baselineName?.(t.baseline) : undefined),
        ref: t.ref,
        baseline: t.baseline,
        referenceRunId: r?.runId ?? null,
        reference: r?.value ?? null,
        zone: zone ?? { min: null, max: null },
        value,
        verdict,
      });
    }
  }
  return out;
}

/** A run's overall grade: off if any target is missed, on if all measurable ones are met. */
export function targetGrade(results: TargetResult[]): 'on' | 'off' | 'none' {
  if (results.some((r) => r.verdict === 'off')) return 'off';
  return results.some((r) => r.verdict === 'on') ? 'on' : 'none';
}

/** Best of two values for a data point's `better` direction. */
export function isBetter(better: DataPointDef['better'], a: number, b: number): boolean {
  return better === 'higher' ? a > b : better === 'lower' ? a < b : false;
}

/** The identity parameters of a run, as a stable key for grouping comparable runs. */
export function identityKey(def: TypeDefinition, params: Record<string, Scalar>): string {
  return def.parameters
    .filter((p) => p.identity)
    .map((p) => `${p.key}=${params[p.key] ?? ''}`)
    .join('|');
}
