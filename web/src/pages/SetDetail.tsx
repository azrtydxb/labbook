import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, GitCompareArrows, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { BaselineBadge } from '../components/Baselines';
import { MarkdownField } from '../components/Markdown';
import { MetricChart, type ChartSeries } from '../components/MetricChart';
import {
  Button,
  Delta,
  Empty,
  ErrorNote,
  PageHeader,
  Panel,
  Spinner,
  StatusBadge,
  cx,
} from '../components/ui';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, fmtValue, shortCommit } from '../lib/format';
import type { Run, SetDetail, TypeDefinition } from '../lib/types';
import { evaluateRun, identityKey, primaryPoint } from '../../../shared/evaluate';

type Mode = 'previous' | 'baseline';

function TypeSection({
  slug,
  runs,
  def,
  baseline,
  mode,
  onRemove,
  onBaseline,
  selected,
  onToggle,
}: {
  slug: string;
  runs: Run[];
  def: TypeDefinition;
  baseline: Run | undefined;
  mode: Mode;
  onRemove: (id: string) => void;
  onBaseline: (id: string) => void;
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [xMode, setXMode] = useState<'sequence' | 'time'>('sequence');
  // Headline first, then data points with bounds, then the rest: six columns at most.
  const shown = def.dataPoints.filter((d) => d.type !== 'string');
  const head = primaryPoint(def);
  const dps = [
    ...shown.filter((d) => d.key === head?.key),
    ...shown.filter((d) => d.key !== head?.key && d.bounds),
    ...shown.filter((d) => d.key !== head?.key && !d.bounds),
  ].slice(0, 6);
  const numeric = def.dataPoints.filter((d) => d.type === 'number');
  const primary = primaryPoint(def);
  const [chartKey, setChartKey] = useState(primary?.key ?? numeric[0]?.key ?? '');
  const chartDp = numeric.find((d) => d.key === chartKey) ?? numeric[0];

  // Reference run per row: the previous run in the set with the same identity, or the set baseline.
  const lastById = new Map<string, Run>();
  const rows = runs.map((r) => {
    const idk = identityKey(def, r.params);
    const prev = lastById.get(idk);
    lastById.set(idk, r);
    const ref = mode === 'baseline' ? (baseline && baseline.id !== r.id ? baseline : undefined) : prev;
    return { run: r, ref, ev: evaluateRun(def, r.values, ref?.values ?? null) };
  });

  const identityParams = def.parameters.filter((p) => p.identity).map((p) => p.key);
  const groups = new Map<string, ChartSeries>();
  const groupNames = [
    ...new Set(runs.map((r) => identityParams.map((k) => r.params[k] ?? '').join(' / '))),
  ].sort();
  runs.forEach((r, i) => {
    const v = chartDp ? r.values[chartDp.key] : undefined;
    if (typeof v !== 'number') return;
    const g = identityParams.map((k) => r.params[k] ?? '').join(' / ') || def.dataPoints[0]!.label;
    if (!groups.has(g))
      groups.set(g, { name: g, colorIndex: Math.max(0, groupNames.indexOf(g)), points: [] });
    groups.get(g)!.points.push({
      x: xMode === 'time' ? new Date(r.runAt).getTime() : i + 1,
      y: v,
      id: r.id,
      runAt: r.runAt,
      status: r.status,
      params: r.params,
      commit: r.links.commit ?? r.params.commit,
    });
  });

  return (
    <Panel
      title={
        <Link to={`/types/${slug}`} className="hover:text-accent">
          {runs[0]?.type.name ?? slug}
        </Link>
      }
      subtitle={`${runs.length} runs, in run order`}
      bodyClass="p-0"
    >
      {chartDp && (
        <div className="border-b border-rule p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Data point to chart">
              {numeric.map((d) => (
                <button
                  key={d.key}
                  role="radio"
                  aria-checked={chartDp.key === d.key}
                  onClick={() => setChartKey(d.key)}
                  className={cx(
                    'rounded-md px-2.5 py-1 text-xs',
                    chartDp.key === d.key
                      ? 'bg-accent-soft font-medium text-accent'
                      : 'text-ink-2 hover:bg-panel-2',
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex gap-1 text-xs">
              {(['sequence', 'time'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setXMode(m)}
                  aria-pressed={xMode === m}
                  className={cx(
                    'rounded px-2 py-1',
                    xMode === m ? 'bg-panel-2 font-medium text-ink' : 'text-ink-3',
                  )}
                >
                  {m === 'sequence' ? 'Run order' : 'Date'}
                </button>
              ))}
            </div>
          </div>
          <MetricChart dp={chartDp} series={[...groups.values()]} xMode={xMode} height={240} />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-xs text-ink-3">
              <th className="w-8 py-2 pl-4">
                <span className="sr-only">Select</span>
              </th>
              <th className="py-2 pr-3 font-medium">Run</th>
              {dps.map((d) => (
                <th key={d.key} className="py-2 pr-3 text-right font-medium">
                  {d.label}
                  {d.unit && <span className="ml-1 font-normal">({d.unit})</span>}
                </th>
              ))}
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-4">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ run: r, ref, ev }) => (
              <tr
                key={r.id}
                className={cx(
                  'border-b border-rule/70 align-top last:border-0 hover:bg-panel-2',
                  baseline?.id === r.id && 'bg-accent-soft/50',
                )}
              >
                <td className="py-2 pl-4">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    checked={selected.has(r.id)}
                    onChange={() => onToggle(r.id)}
                    aria-label={`Select ${r.params.label ?? r.externalId ?? r.seq}`}
                  />
                </td>
                <td className="max-w-[300px] py-2 pr-3">
                  <Link to={`/runs/${r.id}`} className="font-medium text-ink hover:text-accent">
                    {r.params.label ?? r.externalId ?? `#${r.seq}`}
                  </Link>
                  <div className="text-xs text-ink-3">
                    {[
                      identityParams
                        .map((k) => r.params[k])
                        .filter(Boolean)
                        .join(' / '),
                      shortCommit(r.links.commit ?? r.params.commit),
                      fmtDate(r.runAt),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    {baseline?.id === r.id && (
                      <span className="ml-1 font-medium text-accent">set baseline</span>
                    )}
                  </div>
                  <BaselineBadge baselines={r.baselineOf} className="mt-0.5" />
                  {r.conclusion && (
                    <div className="mt-0.5 line-clamp-2 text-xs text-ink-2">{r.conclusion}</div>
                  )}
                </td>
                {dps.map((d) => {
                  const p = ev.points.find((x) => x.key === d.key);
                  return (
                    <td key={d.key} className="py-2 pr-3 text-right">
                      <div
                        className={cx(
                          'tabular-nums',
                          p?.verdict === 'fail' ? 'font-semibold text-fail' : 'text-ink',
                        )}
                      >
                        {fmtValue(r.values[d.key])}
                      </div>
                      {ref && d.type === 'number' && <Delta pct={p?.deltaPct} improved={p?.improved} />}
                    </td>
                  );
                })}
                <td className="py-2 pr-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="whitespace-nowrap py-2 pr-4 text-right">
                  {baseline?.id !== r.id && (
                    <button
                      onClick={() => onBaseline(r.id)}
                      className="mr-2 text-xs text-ink-3 hover:text-accent"
                    >
                      Make baseline
                    </button>
                  )}
                  <button
                    onClick={() => onRemove(r.id)}
                    className="rounded p-1 text-ink-3 hover:bg-fail-soft hover:text-fail"
                    aria-label={`Remove ${r.params.label ?? r.seq} from the set`}
                    title="Remove from set"
                  >
                    <X className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function SetDetailPage() {
  const { slug = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['set', slug], queryFn: () => api.get<SetDetail>(`/api/v1/sets/${slug}`) });
  const [mode, setMode] = useState<Mode>('previous');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['set', slug] });
    void qc.invalidateQueries({ queryKey: ['sets'] });
  };
  const patch = (body: Record<string, unknown>) => api.patch(`/api/v1/sets/${slug}`, body).then(refresh);
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/sets/${slug}/runs/${id}`),
    onSuccess: refresh,
  });
  const setBaseline = useMutation({ mutationFn: (id: string) => patch({ baselineRunId: id }) });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const s = q.data!;
  const byType = new Map<string, Run[]>();
  for (const r of s.runs) {
    if (!byType.has(r.type.slug)) byType.set(r.type.slug, []);
    byType.get(r.type.slug)!.push(r);
  }
  const baselineRun = s.runs.find((r) => r.id === s.baselineRunId);
  const failing = s.runs.filter((r) => r.status === 'fail' || r.status === 'error').length;
  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-6">
      <PageHeader
        kicker={
          <Link to="/sets" className="hover:text-accent">
            Sets
          </Link>
        }
        title={s.name}
        actions={
          <>
            <a
              href={`/api/v1/export?set=${encodeURIComponent(slug)}&format=csv`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rule-strong bg-panel px-3 text-sm hover:bg-panel-2"
            >
              <Download className="size-4" aria-hidden /> CSV
            </a>
            <Button
              variant="primary"
              disabled={selected.size < 2}
              onClick={() => navigate(`/compare?ids=${[...selected].join(',')}`)}
            >
              <GitCompareArrows className="size-4" aria-hidden /> Compare {selected.size || ''}
            </Button>
          </>
        }
      >
        {s.runs.length} runs over {byType.size} test type{byType.size === 1 ? '' : 's'}
        {s.runs.length > 0 &&
          `, ${fmtDate(s.runs[0]!.runAt)} to ${fmtDate(s.runs[s.runs.length - 1]!.runAt)}`}
        {failing > 0 && <span className="text-fail">; {failing} failing</span>}. Last changed{' '}
        {fmtDateTime(s.updatedAt)}.
      </PageHeader>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel>
          <MarkdownField
            label="Conclusion"
            value={s.conclusion}
            edits={s.edits.filter((e) => e.field === 'conclusion')}
            placeholder="What does this set of runs show? Write the verdict."
            onSave={(v) => patch({ conclusion: v })}
          />
        </Panel>
        <Panel>
          <MarkdownField
            label="Description"
            value={s.description}
            edits={s.edits.filter((e) => e.field === 'description')}
            placeholder="Describe the set: workload, hardware, what changed between runs."
            onSave={(v) => patch({ description: v })}
          />
        </Panel>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-ink-2">Changes are shown against</span>
        <div
          className="flex rounded-md border border-rule-strong p-0.5"
          role="radiogroup"
          aria-label="Compare against"
        >
          {(
            [
              ['previous', 'the previous comparable run in the set'],
              ['baseline', baselineRun ? 'the set baseline' : 'the set baseline (none chosen)'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cx(
                'rounded px-3 py-1 text-sm',
                mode === m ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {baselineRun && (
          <span className="text-xs text-ink-3">
            baseline:{' '}
            <Link className="text-accent hover:underline" to={`/runs/${baselineRun.id}`}>
              {baselineRun.params.label ?? baselineRun.externalId}
            </Link>{' '}
            <button className="ml-1 hover:text-fail" onClick={() => void patch({ baselineRunId: null })}>
              (clear)
            </button>
          </span>
        )}
      </div>
      <ErrorNote error={remove.error ?? setBaseline.error} />

      {s.runs.length === 0 ? (
        <Empty title="This set has no runs yet">
          Add runs from a run page, or submit them with <code>sets: ["{slug}"]</code>.
        </Empty>
      ) : (
        [...byType.entries()].map(([typeSlug, runs]) => (
          <TypeSection
            key={typeSlug}
            slug={typeSlug}
            runs={runs}
            def={s.definitions[typeSlug] ?? { parameters: [], dataPoints: [] }}
            baseline={baselineRun?.type.slug === typeSlug ? baselineRun : undefined}
            mode={mode}
            onRemove={(id) => {
              if (confirm('Remove this run from the set? The run itself is kept.')) remove.mutate(id);
            }}
            onBaseline={(id) => setBaseline.mutate(id)}
            selected={selected}
            onToggle={toggle}
          />
        ))
      )}
    </div>
  );
}
