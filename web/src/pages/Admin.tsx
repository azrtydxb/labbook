import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Button,
  ErrorNote,
  Input,
  Label,
  PageHeader,
  Panel,
  Select,
  Spinner,
  Tag,
  cx,
} from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, relTime } from '../lib/format';
import type { Token, TypeSummary } from '../lib/types';

interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  disabled: boolean;
  createdAt: string;
}

function Tokens() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const q = useQuery({
    queryKey: ['tokens', all],
    queryFn: () => api.get<{ tokens: Token[] }>(`/api/v1/tokens${all ? '?all=true' : ''}`),
  });
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api.post<{ token: string; name: string }>('/api/v1/tokens', { name }),
    onSuccess: (t) => {
      setCreated(t);
      setCopied(false);
      setName('');
      void qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/tokens/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tokens'] }),
  });
  const origin = window.location.origin;
  return (
    <div className="space-y-6">
      <Panel
        title="Create an API token"
        subtitle="Scripts and agents upload runs with a bearer token. Only its hash is stored."
      >
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="w-72">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="CI runner on build-01"
              required
            />
          </label>
          <Button type="submit" variant="primary" loading={create.isPending}>
            <KeyRound className="size-4" aria-hidden /> Create token
          </Button>
        </form>
        <ErrorNote error={create.error} />
        {created && (
          <div className="mt-4 rounded-lg border border-pass/40 bg-pass-soft p-3 text-sm">
            <p className="font-medium text-ink">
              Token “{created.name}” created. Copy it now: it is not shown again.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-panel px-2 py-1.5 font-mono text-[13px]">
                {created.token}
              </code>
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(created.token).then(() => setCopied(true));
                }}
              >
                {copied ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  <Copy className="size-3.5" aria-hidden />
                )}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <pre className="mt-3 overflow-x-auto rounded bg-panel p-2 font-mono text-[12px] text-ink-2">
              {`export LABBOOK_URL=${origin}\nexport LABBOOK_TOKEN=${created.token}\ncurl -fsS -H "Authorization: Bearer $LABBOOK_TOKEN" $LABBOOK_URL/api/v1/test-types`}
            </pre>
          </div>
        )}
      </Panel>
      <Panel
        title="Tokens"
        actions={
          user?.role === 'admin' ? (
            <label className="flex items-center gap-2 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={all}
                onChange={(e) => setAll(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              Show every user’s tokens
            </label>
          ) : undefined
        }
      >
        {q.isLoading ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-rule text-left text-xs text-ink-3">
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Token</th>
                  <th className="py-2 pr-3 font-medium">Owner</th>
                  <th className="py-2 pr-3 font-medium">Runs</th>
                  <th className="py-2 pr-3 font-medium">Last used</th>
                  <th className="py-2 pr-3 font-medium">Created</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {q.data?.tokens.map((t) => (
                  <tr
                    key={t.id}
                    className={cx('border-b border-rule/70 last:border-0', t.revokedAt && 'text-ink-3')}
                  >
                    <td className="py-2 pr-3 font-medium">{t.name}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{t.prefix}…</td>
                    <td className="py-2 pr-3">{t.owner}</td>
                    <td className="py-2 pr-3 tabular-nums">{t.runs}</td>
                    <td className="py-2 pr-3">{relTime(t.lastUsedAt)}</td>
                    <td className="py-2 pr-3">{fmtDate(t.createdAt)}</td>
                    <td className="py-2 text-right">
                      {t.revokedAt ? (
                        <span className="text-xs">revoked {fmtDate(t.revokedAt)}</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => {
                            if (confirm(`Revoke “${t.name}”? Scripts using it stop working at once.`))
                              revoke.mutate(t.id);
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {q.data?.tokens.length === 0 && <p className="py-3 text-sm text-ink-3">No tokens yet.</p>}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Users() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const q = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ users: AdminUser[] }>('/api/v1/users'),
  });
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'member' });
  const create = useMutation({
    mutationFn: () => api.post('/api/v1/users', form),
    onSuccess: () => {
      setForm({ username: '', displayName: '', password: '', role: 'member' });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/api/v1/users/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
  return (
    <div className="space-y-6">
      <Panel title="Add a user" subtitle="Passwords are stored as Argon2id hashes.">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_140px_auto] lg:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label>
            <Label>Username</Label>
            <Input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
              required
            />
          </label>
          <label>
            <Label>Display name</Label>
            <Input
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </label>
          <label>
            <Label hint="10+ characters">Password</Label>
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              minLength={10}
              required
              autoComplete="new-password"
            />
          </label>
          <label>
            <Label>Role</Label>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
          </label>
          <Button type="submit" variant="primary" loading={create.isPending}>
            <Plus className="size-4" aria-hidden /> Add user
          </Button>
        </form>
        <ErrorNote error={create.error} />
      </Panel>
      <Panel title="Users">
        <ErrorNote error={update.error} />
        {q.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-xs text-ink-3">
                <th className="py-2 pr-3 font-medium">User</th>
                <th className="py-2 pr-3 font-medium">Role</th>
                <th className="py-2 pr-3 font-medium">Created</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {q.data?.users.map((u) => (
                <tr
                  key={u.id}
                  className={cx('border-b border-rule/70 last:border-0', u.disabled && 'text-ink-3')}
                >
                  <td className="py-2 pr-3">
                    <div className="font-medium">{u.displayName || u.username}</div>
                    <div className="text-xs text-ink-3">
                      {u.username}
                      {u.disabled && ' · disabled'}
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <Select
                      className="w-28"
                      value={u.role}
                      disabled={u.id === me?.id}
                      onChange={(e) => update.mutate({ id: u.id, body: { role: e.target.value } })}
                      aria-label={`Role of ${u.username}`}
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </Select>
                  </td>
                  <td className="py-2 pr-3">{fmtDate(u.createdAt)}</td>
                  <td className="space-x-1 py-2 text-right">
                    <Button
                      size="sm"
                      onClick={() => {
                        const pw = prompt(`New password for ${u.username} (10+ characters)`);
                        if (pw) update.mutate({ id: u.id, body: { password: pw } });
                      }}
                    >
                      Reset password
                    </Button>
                    {u.id !== me?.id && (
                      <Button
                        size="sm"
                        variant={u.disabled ? 'secondary' : 'danger'}
                        onClick={() => update.mutate({ id: u.id, body: { disabled: !u.disabled } })}
                      >
                        {u.disabled ? 'Enable' : 'Disable'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function Account() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/api/v1/auth/password', { currentPassword: cur, newPassword: next }),
    onSuccess: () => {
      setCur('');
      setNext('');
    },
  });
  return (
    <Panel title="Change your password">
      <form
        className="grid max-w-md gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <label>
          <Label>Current password</Label>
          <Input
            type="password"
            value={cur}
            onChange={(e) => setCur(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          <Label hint="10+ characters">New password</Label>
          <Input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={10}
            required
          />
        </label>
        <ErrorNote error={m.error} />
        {m.isSuccess && <p className="text-sm text-pass">Password changed.</p>}
        <div>
          <Button type="submit" variant="primary" loading={m.isPending}>
            Change password
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function TypesAdmin() {
  const q = useQuery({
    queryKey: ['types-lite'],
    queryFn: () => api.get<{ types: TypeSummary[] }>('/api/v1/test-types?trend=0'),
  });
  return (
    <Panel
      title="Test type schemas"
      actions={
        <Link
          to="/new-type"
          className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-ink"
        >
          <Plus className="size-3.5" aria-hidden /> New test type
        </Link>
      }
    >
      {q.isLoading ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-rule">
          {q.data?.types.map((t) => (
            <li key={t.slug} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div>
                <Link to={`/types/${t.slug}`} className="font-medium hover:text-accent">
                  {t.name}
                </Link>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                  <span className="font-mono">{t.slug}</span> · v{t.version} ·{' '}
                  {t.definition.parameters.length} parameters · {t.definition.dataPoints.length} data points ·{' '}
                  {t.runCount} runs
                  {t.tags.map((tag) => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                </div>
              </div>
              <Link to={`/types/${t.slug}/edit`} className="text-sm text-accent hover:underline">
                Edit schema
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function AdminPage() {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tabs = [
    { id: 'tokens', label: 'API tokens' },
    { id: 'types', label: 'Test types' },
    ...(user?.role === 'admin' ? [{ id: 'users', label: 'Users' }] : []),
    { id: 'account', label: 'Your account' },
  ];
  const tab = tabs.find((t) => t.id === sp.get('tab'))?.id ?? 'tokens';
  return (
    <div className="space-y-6">
      <PageHeader title="Admin" />
      <div className="flex gap-1 border-b border-rule" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setSp({ tab: t.id })}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === t.id
                ? 'border-accent font-medium text-ink'
                : 'border-transparent text-ink-2 hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'tokens' && <Tokens />}
      {tab === 'types' && <TypesAdmin />}
      {tab === 'users' && <Users />}
      {tab === 'account' && <Account />}
    </div>
  );
}
