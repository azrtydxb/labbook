import { useQuery } from '@tanstack/react-query';
import { Download, GitCompareArrows } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { RunsTable } from '../components/RunsTable';
import { Button, Empty, ErrorNote, Input, Label, PageHeader, Panel, Select, Spinner } from '../components/ui';
import { api, qs } from '../lib/api';
import type { Run, SetSummary, TypeSummary } from '../lib/types';

const PAGE = 100;

export function RunsPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState(sp.get('q') ?? '');
  const page = Number(sp.get('page') ?? '0');
  const filter: Record<string, string> = {};
  sp.forEach((v, k) => {
    if (k !== 'page') filter[k] = v;
  });
  const runs = useQuery({
    queryKey: ['runs', filter, page],
    queryFn: () =>
      api.get<{ runs: Run[]; total: number }>(
        `/api/v1/runs${qs({ ...filter, limit: PAGE, offset: page * PAGE })}`,
      ),
  });
  const types = useQuery({
    queryKey: ['types-lite'],
    queryFn: () => api.get<{ types: TypeSummary[] }>('/api/v1/test-types?trend=0'),
  });
  const sets = useQuery({
    queryKey: ['sets'],
    queryFn: () => api.get<{ sets: SetSummary[] }>('/api/v1/sets'),
  });

  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    n.delete('page');
    setSp(n);
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const def = types.data?.types.find((t) => t.slug === filter.type)?.definition;
  const paramFilters = Object.entries(filter).filter(([k]) => k.startsWith('param.'));

  return (
    <div className="space-y-6">
      <PageHeader
        title="All runs"
        actions={
          <>
            <a
              href={`/api/v1/export${qs({ ...filter, format: 'csv' })}`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rule-strong bg-panel px-3 text-sm hover:bg-panel-2"
            >
              <Download className="size-4" aria-hidden /> Export CSV
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
      />
      <form
        className="flex flex-wrap items-end gap-3 rounded-xl border border-rule bg-panel p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setParam('q', q.trim());
        }}
      >
        <label className="w-48">
          <Label>Test type</Label>
          <Select value={filter.type ?? ''} onChange={(e) => setParam('type', e.target.value)}>
            <option value="">All types</option>
            {types.data?.types.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="w-48">
          <Label>Set</Label>
          <Select value={filter.set ?? ''} onChange={(e) => setParam('set', e.target.value)}>
            <option value="">Any set</option>
            {sets.data?.sets.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="w-32">
          <Label>Status</Label>
          <Select value={filter.status ?? ''} onChange={(e) => setParam('status', e.target.value)}>
            <option value="">All</option>
            <option value="pass">Pass</option>
            <option value="fail">Fail</option>
            <option value="error">Error</option>
            <option value="info">Info</option>
            <option value="fail,error">Fail or error</option>
          </Select>
        </label>
        <label className="min-w-48 flex-1">
          <Label>Search</Label>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Notes, conclusions, commits, params"
          />
        </label>
        <Button type="submit">Search</Button>
        {paramFilters.map(([k, v]) => (
          <button
            key={k}
            type="button"
            onClick={() => setParam(k, '')}
            className="h-9 rounded-md border border-accent/40 bg-accent-soft px-2.5 text-xs text-accent"
            aria-label={`Remove filter ${k.slice(6)} = ${v}`}
          >
            {k.slice(6)} = {v} ✕
          </button>
        ))}
      </form>
      <Panel
        title={runs.data ? `${runs.data.total} runs` : 'Runs'}
        actions={
          runs.data && runs.data.total > PAGE ? (
            <div className="flex items-center gap-2 text-xs text-ink-3">
              <Button size="sm" disabled={page === 0} onClick={() => setParam('page', String(page - 1))}>
                Newer
              </Button>
              page {page + 1} of {Math.ceil(runs.data.total / PAGE)}
              <Button
                size="sm"
                disabled={(page + 1) * PAGE >= runs.data.total}
                onClick={() => setParam('page', String(page + 1))}
              >
                Older
              </Button>
            </div>
          ) : undefined
        }
      >
        {runs.isLoading ? (
          <Spinner />
        ) : runs.error ? (
          <ErrorNote error={runs.error} />
        ) : runs.data!.runs.length === 0 ? (
          <Empty title="No runs match these filters">Clear a filter or search for something else.</Empty>
        ) : (
          <RunsTable
            runs={runs.data!.runs}
            definition={def}
            showType={!filter.type}
            selected={selected}
            onToggle={toggle}
          />
        )}
      </Panel>
    </div>
  );
}
