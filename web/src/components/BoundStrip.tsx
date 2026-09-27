import type { DataPointDef, Scalar } from '../lib/types';
import { fmtNum } from '../lib/format';

/**
 * A data point on its own little scale: the shaded band is the allowed range
 * (absolute bounds, or relative bounds applied to the baseline), the hollow tick
 * is the baseline, and the dot is this run's value.
 */
export function BoundStrip({
  dp,
  value,
  baseline,
  failed,
}: {
  dp: DataPointDef;
  value: Scalar | undefined;
  baseline: Scalar | undefined;
  failed: boolean;
}) {
  if (typeof value !== 'number') return null;
  const b = dp.bounds ?? {};
  const base = typeof baseline === 'number' ? baseline : undefined;
  let lo = b.min;
  let hi = b.max;
  if (base !== undefined) {
    if (b.relMin !== undefined) lo = Math.max(lo ?? -Infinity, base * b.relMin);
    if (b.relMax !== undefined) hi = Math.min(hi ?? Infinity, base * b.relMax);
  }
  const hasBand = lo !== undefined || hi !== undefined;
  if (!hasBand && base === undefined) return null;
  const marks = [value, base, lo, hi].filter((x): x is number => x !== undefined && Number.isFinite(x));
  let min = Math.min(...marks);
  let max = Math.max(...marks);
  const span = max - min || Math.abs(max) * 0.1 || 1;
  min -= span * 0.25;
  max += span * 0.25;
  const W = 220;
  const H = 22;
  const x = (v: number) => ((v - min) / (max - min)) * W;
  const bandL = x(lo !== undefined && Number.isFinite(lo) ? lo : min);
  const bandR = x(hi !== undefined && Number.isFinite(hi) ? hi : max);
  const desc = [
    `value ${fmtNum(value)}`,
    base !== undefined ? `baseline ${fmtNum(base)}` : '',
    lo !== undefined ? `lower bound ${fmtNum(lo)}` : '',
    hi !== undefined ? `upper bound ${fmtNum(hi)}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <svg
      width="100%"
      viewBox={`-6 0 ${W + 12} ${H}`}
      className="block h-[22px] max-w-[232px]"
      role="img"
      aria-label={desc}
    >
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--rule-strong)" strokeWidth={1} />
      {hasBand && (
        <rect
          x={bandL}
          width={Math.max(1, bandR - bandL)}
          y={4}
          height={H - 8}
          rx={3}
          fill="var(--band)"
          stroke="var(--band-edge)"
          strokeWidth={1}
        />
      )}
      {base !== undefined && (
        <line
          x1={x(base)}
          x2={x(base)}
          y1={3}
          y2={H - 3}
          stroke="var(--ink-3)"
          strokeWidth={2}
          strokeDasharray="2 2"
        />
      )}
      <circle
        cx={x(value)}
        cy={H / 2}
        r={5}
        fill={failed ? 'var(--fail)' : 'var(--ink)'}
        stroke="var(--panel)"
        strokeWidth={2}
      />
    </svg>
  );
}
