import type {
  DataPointDef,
  PointEvaluation,
  RunEvaluation,
  RunStatus,
  Scalar,
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

/** The identity parameters of a run, as a stable key for grouping comparable runs. */
export function identityKey(def: TypeDefinition, params: Record<string, Scalar>): string {
  return def.parameters
    .filter((p) => p.identity)
    .map((p) => `${p.key}=${params[p.key] ?? ''}`)
    .join('|');
}
