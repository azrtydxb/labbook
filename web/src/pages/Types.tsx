import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Link } from 'react-router';
import { Sparkline } from '../components/Sparkline';
import { Empty, ErrorNote, PageHeader, Spinner, Tag } from '../components/ui';
import { api } from '../lib/api';
import { fmtValue, relTime } from '../lib/format';
import type { TypeSummary } from '../lib/types';

export function TypesPage() {
  const q = useQuery({
    queryKey: ['types'],
    queryFn: () => api.get<{ types: TypeSummary[] }>('/api/v1/test-types?trend=30'),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const types = q.data!.types;
  return (
    <div>
      <PageHeader
        title="Test types"
        actions={
          <Link
            to="/new-type"
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3.5 text-sm font-medium text-accent-ink hover:brightness-110"
          >
            <Plus className="size-4" aria-hidden /> New test type
          </Link>
        }
      >
        A test type fixes what a run records: its parameters, its data points and their pass bounds.
      </PageHeader>
      {types.length === 0 ? (
        <Empty title="No test types yet">Create the first one to start submitting runs.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {types.map((t) => {
            const last = [...t.trend].reverse().find((x) => typeof x.value === 'number');
            return (
              <Link
                key={t.slug}
                to={`/types/${t.slug}`}
                className="group flex flex-col justify-between rounded-xl border border-rule bg-panel p-4 hover:border-rule-strong"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-semibold text-ink group-hover:text-accent">{t.name}</h2>
                    <span className="shrink-0 text-xs text-ink-3">v{t.version}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-ink-2">{t.description || 'No description.'}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.tags.map((tag) => (
                      <Tag key={tag}>{tag}</Tag>
                    ))}
                  </div>
                </div>
                <div className="mt-4 flex items-end justify-between gap-3 border-t border-rule pt-3">
                  <div>
                    <div className="text-lg font-semibold tabular-nums">
                      {last ? fmtValue(last.value) : '–'}
                    </div>
                    <div className="text-xs text-ink-3">
                      {t.primary?.label}
                      {t.primary?.unit ? ` (${t.primary.unit})` : ''} · {t.runCount} runs ·{' '}
                      {relTime(t.lastRunAt)}
                    </div>
                  </div>
                  <Sparkline points={t.trend} width={130} height={36} label={`Trend for ${t.name}`} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
