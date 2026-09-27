import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { RunsTable } from '../components/RunsTable';
import {
  Button,
  Delta,
  Empty,
  ErrorNote,
  Label,
  PageHeader,
  Panel,
  Select,
  Spinner,
  StatusBadge,
  cx,
} from '../components/ui';
import { api, qs } from '../lib/api';
import { fmtDateTime, fmtValue, shortCommit } from '../lib/format';
import type { DataPointDef, Run, TypeDefinition, TypeSummary } from '../lib/types';
import { evaluatePoint } from '../../../shared/evaluate';

function Picker({ onPick }: { onPick: (ids: string[]) => void }) {
  const types = useQuery({
    queryKey: ['types-lite'],
    queryFn: () => api.get<{ types: TypeSummary[] }>('/api/v1/test-types?trend=0'),
  });
  const [type, setType] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const runs = useQuery({
    queryKey: ['runs', { type, picker: true }],
    queryFn: () => api.get<{ runs: Run[] }>(`/api/v1/runs${qs({ type, limit: 200 })}`),
    enabled: !!type,
  });
  const def = types.data?.types.find((t) => t.slug === type)?.definition;
  return (
    <Panel
      title="Pick runs to compare"
      actions={
        <Button variant="primary" disabled={selected.size < 2} onClick={() => onPick([...selected])}>
          Compare {selected.size || ''} runs
        </Button>
      }
    >
      <label className="mb-4 block w-64">
        <Label>Test type</Label>
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Choose a type…</option>
          {types.data?.types.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.name}
            </option>
          ))}
        </Select>
      </label>
      {runs.isLoading && <Spinner />}
      {runs.data && (
        <RunsTable
          runs={runs.data.runs}
          definition={def}
          showType={false}
          selected={selected}
          onToggle={(id) =>
            setSelected((s) => {
              const n = new Set(s);
              if (n.has(id)) n.delete(id);
              else n.add(id);
              return n;
            })
          }
        />
      )}
    </Panel>
  );
}

export function ComparePage() {
  const [sp, setSp] = useSearchParams();
  const ids = (sp.get('ids') ?? '').split(',').filter(Boolean);
  const q = useQuery({
    queryKey: ['compare', ids.join(',')],
    queryFn: () =>
      api.get<{ runs: Run[]; definitions: Record<string, TypeDefinition> }>(
        `/api/v1/compare?ids=${ids.join(',')}`,
      ),
    enabled: ids.length > 0,
  });
  const setIds = (next: string[]) => setSp(next.length ? { ids: next.join(',') } : {});

  if (ids.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Compare runs">
          Put two or more runs side by side. The first run is the reference.
        </PageHeader>
        <Picker onPick={setIds} />
      </div>
    );
  }
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { runs, definitions } = q.data!;
  if (runs.length === 0) return <Empty title="None of these runs exist any more" />;

  // Union of data points and parameters across the runs' schemas, in first-seen order.
  const dps: DataPointDef[] = [];
  const params: string[] = [];
  for (const r of runs) {
    const def = definitions[`${r.type.slug}@${r.typeVersion}`];
    def?.dataPoints.forEach((d) => {
      if (!dps.some((x) => x.key === d.key)) dps.push(d);
    });
    def?.parameters.forEach((p) => {
      if (!params.includes(p.key)) params.push(p.key);
    });
    Object.keys(r.params).forEach((k) => {
      if (!params.includes(k)) params.push(k);
    });
  }
  const ref = runs[0]!;
  const mixed = new Set(runs.map((r) => r.type.slug)).size > 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Compare runs"
        actions={
          <Button variant="ghost" onClick={() => setIds([])}>
            Pick other runs
          </Button>
        }
      >
        Changes are relative to the first column. Click ✕ to drop a run, or “Use as reference” to reorder.
        {mixed && ' These runs come from different test types; only shared data points line up.'}
      </PageHeader>
      <Panel bodyClass="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rule align-bottom">
                <th className="sticky left-0 z-10 min-w-[180px] bg-panel px-4 py-3 text-left text-xs font-medium text-ink-3">
                  &nbsp;
                </th>
                {runs.map((r, i) => (
                  <th
                    key={r.id}
                    className={cx(
                      'min-w-[170px] px-3 py-3 text-left align-top',
                      i === 0 && 'bg-accent-soft/50',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <Link to={`/runs/${r.id}`} className="font-semibold text-ink hover:text-accent">
                        {r.params.label ?? r.externalId ?? `#${r.seq}`}
                      </Link>
                      <button
                        onClick={() => setIds(ids.filter((x) => x !== r.id))}
                        className="rounded p-0.5 text-ink-3 hover:text-fail"
                        aria-label="Remove from comparison"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                    <div className="mt-0.5 text-xs font-normal text-ink-3">{r.type.name}</div>
                    <div className="text-xs font-normal text-ink-3">{fmtDateTime(r.runAt)}</div>
                    <div className="mt-1 flex items-center gap-2 font-normal">
                      <StatusBadge status={r.status} />
                      {i === 0 ? (
                        <span className="text-xs text-accent">reference</span>
                      ) : (
                        <button
                          className="text-xs text-ink-3 hover:text-accent"
                          onClick={() => setIds([r.id, ...ids.filter((x) => x !== r.id)])}
                        >
                          Use as reference
                        </button>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td
                  colSpan={runs.length + 1}
                  className="bg-panel-2 px-4 py-1.5 text-xs font-medium text-ink-2"
                >
                  Data points
                </td>
              </tr>
              {dps.map((d) => (
                <tr key={d.key} className="border-b border-rule/70">
                  <td className="sticky left-0 z-10 bg-panel px-4 py-2">
                    <div className="font-medium text-ink">{d.label}</div>
                    <div className="text-xs text-ink-3">
                      {[d.unit, d.better !== 'none' ? `${d.better} is better` : '']
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </td>
                  {runs.map((r, i) => {
                    const ev = evaluatePoint(d, r.values[d.key], i === 0 ? undefined : ref.values[d.key]);
                    return (
                      <td key={r.id} className={cx('px-3 py-2', i === 0 && 'bg-accent-soft/50')}>
                        <div
                          className={cx(
                            'text-[15px] font-semibold tabular-nums',
                            ev.verdict === 'fail' ? 'text-fail' : 'text-ink',
                          )}
                        >
                          {fmtValue(r.values[d.key])}
                        </div>
                        {i > 0 && d.type === 'number' && <Delta pct={ev.deltaPct} improved={ev.improved} />}
                        {i > 0 && d.type !== 'number' && r.values[d.key] !== ref.values[d.key] && (
                          <span className="text-xs text-error">differs</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <td
                  colSpan={runs.length + 1}
                  className="bg-panel-2 px-4 py-1.5 text-xs font-medium text-ink-2"
                >
                  Parameters and links
                </td>
              </tr>
              {params.map((k) => (
                <tr key={k} className="border-b border-rule/70">
                  <td className="sticky left-0 z-10 bg-panel px-4 py-2 text-ink-2">{k}</td>
                  {runs.map((r, i) => (
                    <td
                      key={r.id}
                      className={cx(
                        'break-all px-3 py-2',
                        i === 0 && 'bg-accent-soft/50',
                        i > 0 && r.params[k] !== ref.params[k] ? 'font-medium text-ink' : 'text-ink-2',
                      )}
                    >
                      {r.params[k] ?? '–'}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-b border-rule/70">
                <td className="sticky left-0 z-10 bg-panel px-4 py-2 text-ink-2">commit</td>
                {runs.map((r, i) => (
                  <td
                    key={r.id}
                    className={cx('px-3 py-2 font-mono text-xs', i === 0 && 'bg-accent-soft/50')}
                  >
                    {shortCommit(r.links.commit) || '–'}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="sticky left-0 z-10 bg-panel px-4 py-2 align-top text-ink-2">conclusion</td>
                {runs.map((r, i) => (
                  <td
                    key={r.id}
                    className={cx('px-3 py-2 align-top text-xs text-ink-2', i === 0 && 'bg-accent-soft/50')}
                  >
                    <span className="line-clamp-6 whitespace-pre-line">{r.conclusion || '–'}</span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
