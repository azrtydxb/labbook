import { useNavigate } from 'react-router';
import {
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { targetLabel, targetZone } from '../../../shared/evaluate';
import { BASELINE_DASH, fmtRatio, matches, memberFor, truncate } from '../lib/baselines';
import { fmtDate, fmtDateTime, fmtNum, SERIES, shortCommit } from '../lib/format';
import type { Baseline, BaselineMember, DataPointDef, RunStatus, Target } from '../lib/types';

export interface ChartPoint {
  x: number;
  y: number;
  id: string;
  runAt: string;
  status: RunStatus;
  params: Record<string, string>;
  commit?: string | undefined;
  /** Best earlier value among comparable runs, for `best` targets. */
  best?: number | undefined;
}

export interface ChartSeries {
  name: string;
  colorIndex: number;
  points: ChartPoint[];
}

/** A point as plotted: y may be a percentage of a baseline, `raw` is the recorded value. */
interface PlotPoint extends ChartPoint {
  series: string;
  raw: number;
  /** "N% of <baseline>" for every baseline with a member matching this run. */
  refs: { name: string; ratio: number }[];
  /** Names of the baselines this run is itself a member of. */
  memberOf: string[];
  /** How the recorded value fares against each measurable target. */
  targets: { label: string; verdict: 'on' | 'below' | 'above' }[];
}

/** A shaded target zone; open ends reach the chart edge, missing x spans the width. */
interface Band {
  key: string;
  x1?: number;
  x2?: number;
  min: number | null;
  max: number | null;
}

/** One dashed horizontal line: a baseline member's value, or 100% in relative mode. */
interface RefLine {
  key: string;
  y: number;
  color: string;
  dash: string;
  text: string;
}

/** Height of one reference-line label, in px. */
const LABEL_H = 12;

/**
 * Spread labels vertically so they neither overlap each other nor the min/max
 * bound labels. Works on estimated pixel positions; returns a y offset per label.
 */
function layoutLabels(
  lines: RefLine[],
  toPx: (v: number) => number,
  obstacles: number[],
  plotHeight: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const taken = [...obstacles];
  const wanted = lines.map((l) => ({ key: l.key, c: toPx(l.y) - 7 })).sort((a, b) => a.c - b.c);
  for (const w of wanted) {
    let c = Math.max(w.c, LABEL_H / 2);
    for (let guard = 0; guard < 50; guard++) {
      const hit = taken.find((o) => Math.abs(o - c) < LABEL_H);
      if (hit === undefined) break;
      c = hit + LABEL_H;
    }
    c = Math.min(c, plotHeight - LABEL_H / 2);
    taken.push(c);
    out.set(w.key, c - w.c);
  }
  return out;
}

/** Round the axis to 1-2-5 steps so ticks read as 0, 200, 400… rather than 37.3, 237.3. */
function niceScale(lo: number, hi: number, count = 5): { domain: [number, number]; ticks: number[] } {
  let span = hi - lo;
  if (span <= 0) span = Math.abs(hi) * 0.1 || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor((lo === hi ? lo - span / 2 : lo) / step) * step;
  const end = Math.ceil((lo === hi ? hi + span / 2 : hi) / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { domain: [start, end], ticks };
}

function PointTooltip({
  active,
  payload,
  dp,
  relName,
}: {
  active?: boolean;
  payload?: any[];
  dp: DataPointDef;
  relName: string | undefined;
}) {
  const p = payload?.[0]?.payload as PlotPoint | undefined;
  if (!active || !p) return null;
  const params = Object.entries(p.params).filter(([k]) => k !== 'commit');
  const refs = relName ? p.refs.filter((r) => r.name !== relName) : p.refs;
  return (
    <div className="max-w-xs rounded-lg border border-rule bg-panel px-3 py-2 text-xs shadow-lg">
      {relName ? (
        <>
          <div className="text-[15px] font-semibold text-ink">
            {fmtNum(p.y)}% <span className="text-xs font-normal text-ink-2">of {relName}</span>
          </div>
          <div className="mb-1 text-ink-2">
            {fmtNum(p.raw)} {dp.unit}
          </div>
        </>
      ) : (
        <div className="mb-1 text-[15px] font-semibold text-ink">
          {fmtNum(p.y)} <span className="text-xs font-normal text-ink-2">{dp.unit}</span>
        </div>
      )}
      {refs.map((r) => (
        <div key={r.name} className="text-ink-2">
          {fmtRatio(r.ratio)} of {r.name}
        </div>
      ))}
      {p.targets.map((t, i) => (
        <div key={i} className={t.verdict === 'on' ? 'text-pass' : 'text-fail'}>
          {t.verdict === 'on' ? 'on target' : `${t.verdict} target`}{' '}
          <span className="text-ink-3">({t.label})</span>
        </div>
      ))}
      {p.memberOf.length > 0 && (
        <div className="font-medium text-accent">baseline: {p.memberOf.join(', ')}</div>
      )}
      <div className="mt-1 text-ink-2">{p.series}</div>
      <div className="text-ink-3">{fmtDateTime(p.runAt)}</div>
      {p.commit && <div className="font-mono text-ink-2">{shortCommit(p.commit)}</div>}
      {params.length > 0 && (
        <div className="mt-1 text-ink-3">{params.map(([k, v]) => `${k}=${v}`).join(', ')}</div>
      )}
      {(p.status === 'fail' || p.status === 'error') && (
        <div className="mt-1 font-medium text-fail">Run {p.status}ed</div>
      )}
      <div className="mt-1 text-ink-3">Click to open the run</div>
    </div>
  );
}

function DashSample({ color, dash }: { color: string; dash: string }) {
  return (
    <svg width="22" height="6" aria-hidden className="shrink-0">
      <line x1="0" y1="3" x2="22" y2="3" stroke={color} strokeWidth="1.5" strokeDasharray={dash} />
    </svg>
  );
}

const MARGIN = { top: 14, right: 18, bottom: 6, left: 6 };
const X_AXIS_H = 30;

/**
 * One data point over time (or over run sequence), one line per group. The
 * allowed range from absolute bounds is shaded; failing runs wear a red ring.
 * Pinned baselines draw as labelled dashed lines, one per member that applies to
 * a visible series; baseline member runs are drawn as diamonds. With
 * `relativeTo`, y becomes a percentage of that baseline's matching member.
 * Target zones (informational, never pass/fail) are shaded as soft bands.
 */
export function MetricChart({
  dp,
  series,
  xMode,
  height = 260,
  baselines = [],
  relativeTo,
}: {
  dp: DataPointDef;
  series: ChartSeries[];
  xMode: 'time' | 'sequence';
  height?: number;
  /** Pinned baselines of the type; members apply to points whose params match. */
  baselines?: Baseline[];
  /** Slug of the baseline to plot against (100% = baseline); absolute when unset. */
  relativeTo?: string | null | undefined;
}) {
  const navigate = useNavigate();
  const rel = relativeTo ? baselines.find((b) => b.slug === relativeTo) : undefined;
  const numOf = (m: BaselineMember | undefined): number | undefined => {
    const v = m?.values[dp.key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const targets: Target[] = dp.type === 'number' ? (dp.targets ?? []) : [];
  const nameOf = (slug: string | undefined) => baselines.find((x) => x.slug === slug)?.name;
  /** The zone of a target around one run, in the data point's unit; null when unmeasurable. */
  const zoneAt = (t: Target, p: ChartPoint) => {
    if (t.ref === 'absolute') return targetZone(t, null);
    if (t.ref === 'best') return p.best === undefined ? null : targetZone(t, p.best);
    const bl = baselines.find((x) => x.slug === t.baseline);
    const v = bl ? numOf(memberFor(bl, p.params)) : undefined;
    return v === undefined ? null : targetZone(t, v);
  };

  let dropped = 0;
  const plotted = series.map((s) => ({
    ...s,
    points: s.points.flatMap((p): PlotPoint[] => {
      const refs = baselines.flatMap((b) => {
        const m = memberFor(b, p.params);
        const v = numOf(m);
        return m && m.runId !== p.id && v ? [{ name: b.name, ratio: p.y / v }] : [];
      });
      const memberOf = baselines.filter((b) => b.members.some((m) => m.runId === p.id)).map((b) => b.name);
      const graded = targets.flatMap((t): PlotPoint['targets'] => {
        const z = zoneAt(t, p);
        if (!z) return [];
        const verdict =
          z.min !== null && p.y < z.min ? 'below' : z.max !== null && p.y > z.max ? 'above' : 'on';
        return [{ label: targetLabel(t, nameOf(t.baseline)), verdict }];
      });
      let y = p.y;
      if (rel) {
        const v = numOf(memberFor(rel, p.params));
        if (!v) {
          dropped++;
          return [];
        }
        y = (100 * p.y) / v;
      }
      return [{ ...p, y, raw: p.y, series: s.name, refs, memberOf, targets: graded }];
    }),
  }));
  const all = plotted.flatMap((s) => s.points);
  // In relative mode a series can lose every point; keep the legend honest.
  const visible = plotted.filter((s) => s.points.length > 0);

  if (all.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-ink-3">
        {rel && dropped > 0
          ? `None of the ${dropped} runs has a matching ${rel.name} member with a ${dp.label} value.`
          : `No numeric values for ${dp.label} yet.`}
      </div>
    );
  }

  // Reference lines: 100% in relative mode, otherwise one per applicable baseline member.
  const many = series.length > 1;
  const lines: RefLine[] = rel
    ? [{ key: 'rel', y: 100, color: 'var(--ink-2)', dash: '6 3', text: `${truncate(rel.name, 28)} · 100%` }]
    : baselines.flatMap((b, bi) =>
        b.members.flatMap((m): RefLine[] => {
          const v = numOf(m);
          if (v === undefined) return [];
          const hits = series.filter((s) => s.points.some((p) => matches(p.params, m.match)));
          if (hits.length === 0) return [];
          const color =
            many && hits.length === 1 ? SERIES[hits[0]!.colorIndex % SERIES.length]! : 'var(--ink-2)';
          return [
            {
              key: `${b.slug}:${m.runId}`,
              y: v,
              color,
              dash: BASELINE_DASH[bi % BASELINE_DASH.length]!,
              text: `${truncate(b.name)} · ${fmtNum(v)}`,
            },
          ];
        }),
      );
  const legend = rel
    ? []
    : baselines
        .map((b, bi) => ({
          name: b.name,
          dash: BASELINE_DASH[bi % BASELINE_DASH.length]!,
          shown: lines.some((l) => l.key.startsWith(`${b.slug}:`)),
        }))
        .filter((l) => l.shown);

  const xs = all.map((p) => p.x);
  const xPad = xMode === 'sequence' ? 0.5 : Math.max(3600_000, (Math.max(...xs) - Math.min(...xs)) * 0.02);
  const xDomain: [number, number] = [Math.min(...xs) - xPad, Math.max(...xs) + xPad];

  // Target zones. In % mode only the chosen baseline's targets translate (flat at ratio × 100%).
  const bands: Band[] = [];
  const targetLegend: { label: string; edge: boolean }[] = [];
  const slots = [...new Set(xs)].sort((a, c) => a - c);
  const edges: { key: string; color: string; path: { x: number; y: number }[] }[] = [];
  targets.forEach((t, ti) => {
    const before = bands.length;
    const edgesBefore = edges.length;
    if (rel) {
      const z = t.ref === 'baseline' && t.baseline === rel.slug ? targetZone(t, 100) : null;
      if (z) bands.push({ key: `t${ti}`, ...z });
    } else if (t.ref === 'absolute') {
      bands.push({ key: `t${ti}`, ...targetZone(t, null)! });
    } else if (visible.length > 1) {
      // Several series: per-run shading interleaves into noise, so draw each series'
      // zone edge(s) as a thin dashed step line in the series colour instead.
      for (const s of visible) {
        const pts = [...s.points].sort((a, c) => a.x - c.x);
        for (const end of ['min', 'max'] as const) {
          const path = pts.flatMap((p) => {
            const v = zoneAt(t, p)?.[end];
            return v === null || v === undefined ? [] : [{ x: p.x, y: v }];
          });
          if (path.length === 0) continue;
          edges.push({ key: `t${ti}:${s.name}:${end}`, color: SERIES[s.colorIndex % SERIES.length]!, path });
        }
      }
    } else {
      // Relative to a baseline member or the running best, the zone differs per run:
      // each run gets its own column (half-way to its neighbours), so the zone steps
      // along the series.
      for (const p of all) {
        const z = zoneAt(t, p);
        if (!z) continue;
        const i = slots.indexOf(p.x);
        const prev = slots[i - 1];
        const next = slots[i + 1];
        bands.push({
          key: `t${ti}:${p.id}`,
          x1: prev !== undefined ? (prev + p.x) / 2 : p.x - xPad,
          x2: next !== undefined ? (p.x + next) / 2 : p.x + xPad,
          ...z,
        });
      }
    }
    if (bands.length > before || edges.length > edgesBefore) {
      targetLegend.push({ label: targetLabel(t, nameOf(t.baseline)), edge: edges.length > edgesBefore });
    }
  });

  const b = rel ? {} : (dp.bounds ?? {});
  const extra = [
    ...(b.min !== undefined ? [b.min] : []),
    ...(b.max !== undefined ? [b.max] : []),
    ...lines.map((l) => l.y),
    ...bands.flatMap((z) => [z.min, z.max].filter((v): v is number => v !== null && Number.isFinite(v))),
    ...edges.flatMap((e) => e.path.map((p) => p.y)),
  ];
  const ys = all.map((p) => p.y);
  const lo = Math.min(...ys, ...extra);
  const hi = Math.max(...ys, ...extra);
  const { domain: yDomain, ticks: yTicks } = niceScale(lo, hi);

  const plotHeight = height - MARGIN.top - MARGIN.bottom - X_AXIS_H;
  const toPx = (v: number) => ((yDomain[1] - v) / (yDomain[1] - yDomain[0] || 1)) * plotHeight;
  const obstacles = [
    ...(b.max !== undefined ? [toPx(b.max) + 10] : []),
    ...(b.min !== undefined ? [toPx(b.min) - 10] : []),
  ];
  const offsets = layoutLabels(lines, toPx, obstacles, plotHeight);
  const unit = rel ? '%' : dp.unit;

  return (
    <div>
      {(many || legend.length > 0 || targetLegend.length > 0) && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-label="Legend">
          {many &&
            visible.map((s) => (
              <li key={s.name} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-0.5 w-4 rounded"
                  style={{ background: SERIES[s.colorIndex % SERIES.length] }}
                />
                {s.name}
              </li>
            ))}
          {legend.map((l) => (
            <li key={l.name} className="flex items-center gap-1.5">
              <DashSample color="var(--ink-2)" dash={l.dash} />
              {l.name}
              <span className="text-ink-3">(baseline)</span>
            </li>
          ))}
          {targetLegend.map((l, i) => (
            <li key={i} className="flex items-center gap-1.5">
              {l.edge ? (
                <DashSample color="var(--ink-2)" dash="2 3" />
              ) : (
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-4 rounded-sm border"
                  style={{ background: 'var(--target)', borderColor: 'var(--target-edge)' }}
                />
              )}
              target {l.label}
            </li>
          ))}
        </ul>
      )}
      <div className="graph-paper rounded-lg border border-rule">
        <ResponsiveContainer width="100%" height={height}>
          <ScatterChart margin={MARGIN}>
            <CartesianGrid stroke="var(--rule)" strokeDasharray="0" vertical={false} />
            <XAxis
              type="number"
              dataKey="x"
              domain={xDomain}
              allowDataOverflow
              height={X_AXIS_H}
              tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--rule-strong)' }}
              tickFormatter={(v: number) =>
                xMode === 'time' ? fmtDate(new Date(v).toISOString()) : `#${Math.round(v)}`
              }
              minTickGap={24}
              allowDecimals={false}
            />
            <YAxis
              type="number"
              dataKey="y"
              domain={yDomain}
              ticks={yTicks}
              allowDataOverflow
              tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(v: number) => (rel ? `${fmtNum(v)}%` : fmtNum(v))}
            />
            {(b.min !== undefined || b.max !== undefined) && (
              <ReferenceArea
                y1={b.min ?? yDomain[0]}
                y2={b.max ?? yDomain[1]}
                fill="var(--band)"
                fillOpacity={1}
                stroke="none"
                ifOverflow="hidden"
              />
            )}
            {b.min !== undefined && (
              <ReferenceLine
                y={b.min}
                stroke="var(--band-edge)"
                strokeDasharray="4 3"
                label={{
                  value: `min ${fmtNum(b.min)}`,
                  position: 'insideBottomRight',
                  fill: 'var(--ink-3)',
                  fontSize: 10,
                }}
              />
            )}
            {b.max !== undefined && (
              <ReferenceLine
                y={b.max}
                stroke="var(--band-edge)"
                strokeDasharray="4 3"
                label={{
                  value: `max ${fmtNum(b.max)}`,
                  position: 'insideTopRight',
                  fill: 'var(--ink-3)',
                  fontSize: 10,
                }}
              />
            )}
            {bands.map((z) => (
              <ReferenceArea
                key={z.key}
                {...(z.x1 !== undefined ? { x1: z.x1, x2: z.x2 } : {})}
                y1={z.min ?? yDomain[0]}
                y2={z.max ?? yDomain[1]}
                fill="var(--target)"
                fillOpacity={1}
                stroke="none"
                ifOverflow="hidden"
              />
            ))}
            {edges.map((e) => (
              <Scatter
                key={e.key}
                data={e.path}
                line={{ stroke: e.color, strokeWidth: 1, strokeDasharray: '2 3', strokeOpacity: 0.7 }}
                lineType="joint"
                shape={() => <g />}
                tooltipType="none"
                legendType="none"
                isAnimationActive={false}
              />
            ))}
            {lines.map((l) => (
              <ReferenceLine
                key={l.key}
                y={l.y}
                stroke={l.color}
                strokeWidth={1.25}
                strokeDasharray={l.dash}
                label={(props: { viewBox?: { x?: number; y?: number; width?: number } }) => {
                  const vb = props.viewBox ?? {};
                  return (
                    <text
                      x={(vb.x ?? 0) + (vb.width ?? 0) - 4}
                      y={(vb.y ?? 0) - 3 + (offsets.get(l.key) ?? 0)}
                      textAnchor="end"
                      fontSize={10}
                      fill={l.color}
                      stroke="var(--panel)"
                      strokeWidth={3}
                      paintOrder="stroke"
                    >
                      {l.text}
                    </text>
                  );
                }}
              />
            ))}
            <Tooltip
              content={<PointTooltip dp={dp} relName={rel?.name} />}
              cursor={{ stroke: 'var(--ink-3)', strokeDasharray: '3 3' }}
            />
            {plotted.map((s) => {
              const color = SERIES[s.colorIndex % SERIES.length];
              const data = [...s.points].sort((a, b2) => a.x - b2.x);
              return (
                <Scatter
                  key={s.name}
                  name={s.name}
                  data={data}
                  fill={color}
                  line={{ stroke: color, strokeWidth: 2 }}
                  lineType="joint"
                  isAnimationActive={false}
                  shape={(props: any) => {
                    const pt = props.payload as PlotPoint;
                    const bad = pt.status === 'fail' || pt.status === 'error';
                    const member = pt.memberOf.length > 0;
                    const { cx, cy } = props as { cx: number; cy: number };
                    return (
                      <g
                        style={{ cursor: 'pointer' }}
                        onClick={() => navigate(`/runs/${pt.id}`)}
                        role="link"
                        aria-label={`Open run ${fmtNum(pt.y)} ${unit}${member ? `, baseline ${pt.memberOf.join(', ')}` : ''}`}
                      >
                        <circle cx={cx} cy={cy} r={12} fill="transparent" />
                        {member ? (
                          <path
                            d={`M${cx},${cy - 6.5}L${cx + 6.5},${cy}L${cx},${cy + 6.5}L${cx - 6.5},${cy}Z`}
                            fill={bad ? 'var(--panel)' : color}
                            stroke={bad ? 'var(--fail)' : 'var(--ink)'}
                            strokeWidth={bad ? 2.5 : 1.5}
                          />
                        ) : (
                          <circle
                            cx={cx}
                            cy={cy}
                            r={bad ? 5 : 4}
                            fill={bad ? 'var(--panel)' : color}
                            stroke={bad ? 'var(--fail)' : 'var(--panel)'}
                            strokeWidth={bad ? 2.5 : 2}
                          />
                        )}
                      </g>
                    );
                  }}
                />
              );
            })}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      {rel && dropped > 0 && (
        <p className="mt-1.5 text-xs text-ink-3">
          {dropped} {dropped === 1 ? 'run has' : 'runs have'} no matching {rel.name} member and{' '}
          {dropped === 1 ? 'is' : 'are'} not shown.
        </p>
      )}
    </div>
  );
}
