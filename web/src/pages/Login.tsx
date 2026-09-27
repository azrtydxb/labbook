import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ErrorNote, Input, Label } from '../components/ui';

export function LoginPage() {
  const { refresh } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/v1/auth/login', { username: username.trim(), password });
      refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-sidebar lg:block">
        <svg
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          viewBox="0 0 600 800"
          aria-hidden
        >
          <defs>
            <pattern id="g" width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M24 0H0V24" fill="none" stroke="#ffffff" strokeOpacity="0.05" />
            </pattern>
          </defs>
          <rect width="600" height="800" fill="url(#g)" />
          <rect x="0" y="330" width="600" height="120" fill="#4cc38a" fillOpacity="0.08" />
          <path
            d="M40 610 L110 596 L170 604 L230 560 L290 470 L350 452 L410 446 L470 392 L530 388 L570 384"
            fill="none"
            stroke="#8a98ff"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {[
            [40, 610],
            [110, 596],
            [170, 604],
            [230, 560],
            [290, 470],
            [350, 452],
            [410, 446],
            [470, 392],
            [530, 388],
            [570, 384],
          ].map(([x, y]) => (
            <circle key={x} cx={x} cy={y} r="5" fill="#8a98ff" stroke="#14213d" strokeWidth="2.5" />
          ))}
        </svg>
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <span className="text-lg font-semibold tracking-tight">labbook</span>
          <div className="max-w-md">
            <p className="text-3xl font-semibold leading-tight tracking-tight">
              Every bench, golden check and soak, kept with its notes and verdict.
            </p>
            <p className="mt-4 text-sm leading-relaxed text-[#aab4c8]">
              Define a test once, upload its results from any script, and see how each change moved the
              numbers.
            </p>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-center px-6 py-12">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Log in to labbook</h1>
            <p className="mt-1 text-sm text-ink-2">Use the account an administrator created for you.</p>
          </div>
          <label className="block">
            <Label>Username</Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </label>
          <label className="block">
            <Label>Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <ErrorNote error={error} />
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Log in
          </Button>
        </form>
      </div>
    </div>
  );
}
