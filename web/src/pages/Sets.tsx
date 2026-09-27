import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Empty, ErrorNote, Input, Label, PageHeader, Spinner, Tag, Textarea } from '../components/ui';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import type { SetSummary } from '../lib/types';

export function SetsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['sets'], queryFn: () => api.get<{ sets: SetSummary[] }>('/api/v1/sets') });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<{ slug: string }>('/api/v1/sets', { name, description }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['sets'] });
      navigate(`/sets/${s.slug}`);
    },
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const sets = q.data!.sets;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Sets"
        actions={
          <Button variant="primary" onClick={() => setCreating((c) => !c)}>
            <Plus className="size-4" aria-hidden /> New set
          </Button>
        }
      >
        A set groups runs that belong together, like a chain of landed changes, and holds the verdict on them.
      </PageHeader>
      {creating && (
        <form
          className="space-y-3 rounded-xl border border-rule bg-panel p-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="block max-w-md">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="pre-Phase-5 perf"
              required
              autoFocus
            />
          </label>
          <label className="block">
            <Label hint="markdown">Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </label>
          <ErrorNote error={create.error} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create set
            </Button>
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {sets.length === 0 ? (
        <Empty title="No sets yet">
          Create one, or pass <code>sets: ["slug"]</code> when submitting runs.
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border border-rule bg-panel">
          <ul className="divide-y divide-rule">
            {sets.map((s) => (
              <li key={s.slug}>
                <Link
                  to={`/sets/${s.slug}`}
                  className="grid gap-2 px-4 py-3 hover:bg-panel-2 md:grid-cols-[minmax(0,1fr)_200px_140px] md:items-center"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-ink">{s.name}</div>
                    <div className="mt-0.5 line-clamp-1 text-sm text-ink-2">
                      {s.hasConclusion
                        ? s.conclusion.split('\n').find((l) => l.trim())
                        : s.description.split('\n')[0] || 'No conclusion yet.'}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.types.map((t) => (
                        <Tag key={t.slug}>{t.name}</Tag>
                      ))}
                    </div>
                  </div>
                  <div className="text-sm text-ink-2">
                    {s.runCount} runs
                    {s.failingCount > 0 && <span className="ml-2 text-fail">{s.failingCount} failing</span>}
                  </div>
                  <div className="text-xs text-ink-3 md:text-right">
                    {s.firstRunAt
                      ? `${fmtDate(s.firstRunAt)} – ${fmtDate(s.lastRunAt)}`
                      : fmtDate(s.updatedAt)}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
