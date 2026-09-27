import {
  BookOpen,
  FlaskConical,
  GitCompareArrows,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Settings,
  Sun,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';
import { useTheme, type ThemeChoice } from '../lib/theme';
import { cx } from './ui';

const NAV = [
  { to: '/', label: 'Overview', Icon: LayoutDashboard, end: true },
  { to: '/types', label: 'Test types', Icon: FlaskConical },
  { to: '/sets', label: 'Sets', Icon: BookOpen },
  { to: '/runs', label: 'All runs', Icon: ListChecks },
  { to: '/compare', label: 'Compare', Icon: GitCompareArrows },
  { to: '/admin', label: 'Admin', Icon: Settings },
];

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const opts: { v: ThemeChoice; Icon: typeof Sun; label: string }[] = [
    { v: 'light', Icon: Sun, label: 'Light theme' },
    { v: 'system', Icon: Monitor, label: 'System theme' },
    { v: 'dark', Icon: Moon, label: 'Dark theme' },
  ];
  return (
    <div className="flex rounded-md bg-sidebar-active/60 p-0.5" role="radiogroup" aria-label="Theme">
      {opts.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={theme === o.v}
          aria-label={o.label}
          title={o.label}
          onClick={() => setTheme(o.v)}
          className={cx(
            'flex h-7 flex-1 items-center justify-center rounded',
            theme === o.v ? 'bg-sidebar-ink/15 text-white' : 'text-sidebar-ink hover:text-white',
          )}
        >
          <o.Icon className="size-3.5" aria-hidden />
        </button>
      ))}
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#25355c" />
        <path
          d="M6 23 L12 15 L17 19 L26 8"
          fill="none"
          stroke="#8a98ff"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="26" cy="8" r="2.6" fill="#fff" />
      </svg>
      <span className="text-[17px] font-semibold tracking-tight text-white">labbook</span>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {NAV.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm',
              isActive
                ? 'bg-sidebar-active font-medium text-white'
                : 'text-sidebar-ink hover:bg-sidebar-active/60 hover:text-white',
            )
          }
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </NavLink>
      ))}
    </nav>
  );
  const footer = (
    <div className="space-y-3 border-t border-white/10 pt-4">
      <ThemeSwitch />
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-xs">
          <div className="truncate font-medium text-white">{user?.displayName || user?.username}</div>
          <div className="truncate text-sidebar-ink">
            {user?.username} · {user?.role}
          </div>
        </div>
        <button
          onClick={() => void logout()}
          className="rounded p-1.5 text-sidebar-ink hover:bg-sidebar-active hover:text-white"
          aria-label="Log out"
          title="Log out"
        >
          <LogOut className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
  return (
    <div className="min-h-screen lg:flex">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col justify-between bg-sidebar px-3 py-5 lg:flex">
        <div className="space-y-6">
          <div className="px-2">
            <Brand />
          </div>
          {nav}
        </div>
        {footer}
      </aside>
      <header className="sticky top-0 z-30 flex items-center justify-between bg-sidebar px-4 py-3 lg:hidden">
        <Brand />
        <button
          onClick={() => setOpen((o) => !o)}
          className="rounded p-1.5 text-sidebar-ink"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </header>
      {open && (
        <div className="fixed inset-x-0 top-[52px] z-20 space-y-4 bg-sidebar px-4 pb-5 pt-2 shadow-xl lg:hidden">
          {nav}
          {footer}
        </div>
      )}
      <main key={loc.pathname} className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto max-w-[1400px]">{children}</div>
      </main>
    </div>
  );
}
