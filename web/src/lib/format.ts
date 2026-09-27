import type { Scalar } from './types';

export function fmtNum(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return String(v);
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-3)) return v.toExponential(2);
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  const decimals = abs >= 1000 ? 1 : abs >= 100 ? 1 : abs >= 10 ? 2 : abs >= 1 ? 3 : digits;
  return v.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}

export function fmtValue(v: Scalar | undefined, unit = ''): string {
  if (v === undefined || v === null) return '–';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return unit ? `${fmtNum(v)} ${unit}` : fmtNum(v);
  return v;
}

export function fmtPct(p: number | null | undefined, signed = true): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '–';
  const s = (p * 100).toFixed(Math.abs(p) < 0.1 ? 1 : 0);
  return `${signed && p > 0 ? '+' : ''}${s}%`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return fmtDate(iso);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function shortCommit(c: string | undefined): string {
  if (!c) return '';
  return /^[0-9a-f]{8,40}$/i.test(c) ? c.slice(0, 7) : c;
}

/** Categorical series colours, in fixed order (validated palette). */
export const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'].map(
  (v) => `var(${v})`,
);
