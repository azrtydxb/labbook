import { useQuery } from '@tanstack/react-query';
import { Download, GitCompareArrows, Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { BaselinesPanel, useBaselines } from '../components/Baselines';
import { Markdown } from '../components/Markdown';
import { MetricChart, type ChartSeries } from '../components/MetricChart';
import { RunsTable } from '../components/RunsTable';
import { Button, ErrorNote, Label, PageHeader, Panel, Select, Spinner, Tag, cx } from '../components/ui';
import { api, qs } from '../lib/api';
import { fmtDate } from '../lib/format';
import type { Run, TypeDetail } from '../lib/types';
import { identityKey, isBetter } from '../../../shared/evaluate';

export function TypeDetailPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const type = useQuery({
    queryKey: ['type', slug],
    queryFn: () => api.get<TypeDetail>(`/api/v1/test-types/${slug}`),
  });
  const runs = useQuery({
    queryKey: ['runs', { type: slug }],
    queryFn: () =>
      api.get<{ runs: Run[]; total: number }>(
        `/api/v1/runs${qs({ type: slug, limit: 10000, order: 'asc' })}`,
      ),
  });
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [xMode, setXMode] = useState<'time' | 'sequence'>('sequence');
  const [status, setStatus] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const baselines = useBaselines(slug);
  // Plot as % of a pinned baseline; kept in the URL so the view can be shared.
  const [sp, setSp] = useSearchParams();
  const relParam = sp.get('rel') ?? '';
  const setRel = (v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set('rel', v);
    else n.delete('rel');
    setSp(n, { replace: true });
  };

  const def = type.data?.merged;
  const all = useMemo(() => runs.data?.runs ?? [], [runs.data]);

  // Distinct values per parameter, for the filter row.
  const paramValues = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of def?.parameters ?? []) {
      const vs = [
        ...new Set(all.map((r) => r.params[p.key]).filter((v): v is string => v !== undefined)),
      ].sort();
      m.set(p.key, vs);
    }
    return m;
  }, [all, def]);

  // For `best` targets: per data point, the best value of the earlier comparable runs.
  const bestBefore = useMemo(() => {
    const out = new Map<string, Map<string, number>>();
    if (!def) return out;
    for (const dp of def.dataPoints) {
      if (dp.type !== 'number' || dp.better === 'none' || !dp.targets?.some((t) => t.ref === 'best'))
        continue;
      const best = new Map<string, number>();
      const before = new Map<string, number>();
      for (const r of all) {
        const k = identityKey(def, r.params);
        const b = best.get(k);
        if (b !== undefined) before.set(r.id, b);
        const v = r.values[dp.key];
        if (typeof v === 'number' && (b === undefined || isBetter(dp.better, v, b))) best.set(k, v);
      }
      out.set(dp.key, before);
    }
    return out;
  }, [all, def]);

  const defaultGroup = useMemo(() => {
    const identity = def?.parameters.filter((p) => p.identity) ?? [];
    return identity.find((p) => (paramValues.get(p.key)?.length ?? 0) > 1)?.key ?? '';
  }, [def, paramValues]);
  const group = groupBy ?? defaultGroup;

  const filtered = useMemo(
    () =>
      all.filter(
        (r) =>
          Object.entries(filters).every(([k, v]) => !v || r.params[k] === v) &&
          (!status || r.status === status),
      ),
    [all, filters, status],
  );

  if (type.isLoading || runs.isLoading) return <Spinner />;
  if (type.error || runs.error) return <ErrorNote error={type.error ?? runs.error} />;
  const t = type.data!;
  const d = def!;
  const numeric = d.dataPoints.filter((p) => p.type === 'number');
  const bls = baselines.data ?? [];
  const pctOf = bls.some((b) => b.slug === relParam) ? relParam : '';

  const seriesFor = (key: string): ChartSeries[] => {
    const groups = new Map<string, ChartSeries>();
    const order = group ? (paramValues.get(group) ?? []) : [];
    filtered.forEach((r, i) => {
      const v = r.values[key];
      if (typeof v !== 'number') return;
      const g = group ? (r.params[group] ?? '(none)') : t.name;
      if (!groups.has(g)) {
        const idx = group ? Math.max(0, order.indexOf(g)) : 0;
        groups.set(g, { name: group ? `${group} = ${g}` : t.name, colorIndex: idx, points: [] });
      }
      groups.get(g)!.points.push({
        x: xMode === 'time' ? new Date(r.runAt).getTime() : i + 1,
        y: v,
        id: r.id,
        runAt: r.runAt,
        status: r.status,
        params: r.params,
        commit: r.links.commit ?? r.params.commit,
        best: bestBefore.get(key)?.get(r.id),
      });
    });
    return [...groups.values()].sort((a, b) => a.colorIndex - b.colorIndex);
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const exportQs = (format: string) =>
    `/api/v1/export${qs({
      type: slug,
      format,
      status: status || undefined,
      ...Object.fromEntries(
        Object.entries(filters)
          .filter(([, v]) => v)
          .map(([k, v]) => [`param.${k}`, v]),
      ),
    })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        kicker={
          <Link to="/types" className="hover:text-accent">
            Test types
          </Link>
        }
        title={t.name}
        actions={
          <>
            <a
              href={exportQs('csv')}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rule-strong bg-panel px-3 text-sm hover:bg-panel-2"
            >
              <Download className="size-4" aria-hidden /> CSV
            </a>
            <a
              href={exportQs('json')}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rule-strong bg-panel px-3 text-sm hover:bg-panel-2"
            >
              <Download className="size-4" aria-hidden /> JSON
            </a>
            <Link
              to={`/types/${slug}/edit`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rule-strong bg-panel px-3 text-sm hover:bg-panel-2"
            >
              <Pencil className="size-4" aria-hidden /> Edit schema
            </Link>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-ink-3">{t.slug}</span>
          <span className="text-ink-3">·</span>
          <span>schema v{t.version}</span>
          <span className="text-ink-3">·</span>
          <span>{all.length} runs</span>
          {t.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </div>
        {t.description && <Markdown text={t.description} className="mt-2" />}
      </PageHeader>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-rule bg-panel p-3">
        {d.parameters
          .filter(
            (p) => (paramValues.get(p.key)?.length ?? 0) > 1 && (paramValues.get(p.key)?.length ?? 0) <= 60,
          )
          .map((p) => (
            <label key={p.key} className="w-40">
              <Label>{p.label}</Label>
              <Select
                value={filters[p.key] ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, [p.key]: e.target.value }))}
              >
                <option value="">All</option>
                {paramValues.get(p.key)!.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            </label>
          ))}
        <label className="w-32">
          <Label>Status</Label>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="pass">Pass</option>
            <option value="fail">Fail</option>
            <option value="error">Error</option>
            <option value="info">Info</option>
          </Select>
        </label>
        <label className="w-40">
          <Label>One line per</Label>
          <Select value={group} onChange={(e) => setGroupBy(e.target.value)}>
            <option value="">(single line)</option>
            {d.parameters.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
        </label>
        <div>
          <Label>X axis</Label>
          <div
            className="flex h-9 rounded-md border border-rule-strong p-0.5"
            role="radiogroup"
            aria-label="X axis"
          >
            {(['sequence', 'time'] as const).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={xMode === m}
                onClick={() => setXMode(m)}
                className={cx(
                  'rounded px-3 text-sm',
                  xMode === m ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2',
                )}
              >
                {m === 'sequence' ? 'Run order' : 'Date'}
              </button>
            ))}
          </div>
        </div>
        {bls.length > 0 && (
          <label className="w-52">
            <Label>Y axis</Label>
            <Select value={pctOf} onChange={(e) => setRel(e.target.value)}>
              <option value="">Absolute</option>
              {bls.map((b) => (
                <option key={b.slug} value={b.slug}>
                  % of {b.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <span className="ml-auto self-center text-xs text-ink-3">
          {filtered.length} of {all.length} runs
          {filtered.length > 0 &&
            ` · ${fmtDate(filtered[0]!.runAt)} to ${fmtDate(filtered[filtered.length - 1]!.runAt)}`}
        </span>
      </div>

      <div className={cx('grid grid-cols-1 gap-6', numeric.length > 1 && 'xl:grid-cols-2')}>
        {numeric.map((dp) => {
          const b = dp.bounds;
          const rel = [
            b?.relMin !== undefined ? `≥ ${b.relMin}× baseline` : '',
            b?.relMax !== undefined ? `≤ ${b.relMax}× baseline` : '',
          ]
            .filter(Boolean)
            .join(', ');
          return (
            <Panel
              key={dp.key}
              title={
                <>
                  {dp.label}
                  {pctOf ? (
                    <span className="ml-1.5 text-sm font-normal text-ink-3">
                      % of {bls.find((x) => x.slug === pctOf)?.name}
                    </span>
                  ) : (
                    dp.unit && <span className="ml-1.5 text-sm font-normal text-ink-3">{dp.unit}</span>
                  )}
                </>
              }
              subtitle={[
                dp.better === 'higher' ? 'Higher is better' : dp.better === 'lower' ? 'Lower is better' : '',
                rel ? `relative bound ${rel}` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              <MetricChart
                dp={dp}
                series={seriesFor(dp.key)}
                xMode={xMode}
                baselines={bls}
                relativeTo={pctOf || undefined}
              />
            </Panel>
          );
        })}
      </div>

      <Panel
        title="Runs"
        subtitle="Select runs to compare them side by side"
        actions={
          <Button
            variant="primary"
            size="sm"
            disabled={selected.size < 2}
            onClick={() => navigate(`/compare?ids=${[...selected].join(',')}`)}
          >
            <GitCompareArrows className="size-3.5" aria-hidden /> Compare {selected.size || ''}
          </Button>
        }
      >
        <RunsTable
          runs={[...filtered].reverse()}
          definition={d}
          showType={false}
          selected={selected}
          onToggle={toggle}
          maxValueCols={8}
        />
      </Panel>

      <BaselinesPanel typeSlug={slug} definition={d} selected={selected} />

      <Panel title="Schema versions" subtitle="Runs keep the version they were recorded under">
        <ol className="space-y-1 text-sm">
          {t.versions.map((v) => (
            <li key={v.version} className="flex flex-wrap gap-2">
              <span className="font-medium">v{v.version}</span>
              <span className="text-ink-3">{fmtDate(v.createdAt)}</span>
              {v.createdBy && <span className="text-ink-3">by {v.createdBy}</span>}
              {v.note && <span className="text-ink-2">{v.note}</span>}
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
