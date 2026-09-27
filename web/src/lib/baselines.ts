import { memberMatches } from '../../../shared/evaluate';
import type { Baseline, BaselineMember } from './types';

/** Baseline slugs, as the API accepts them. */
export const BASELINE_SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** A slug derived from a display name: "Release 2.4 (node A)" → "release-2.4-node-a". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 100);
}

/** True when a run's params agree with a member's match tuple on every key (same rule as the server). */
export function matches(params: Record<string, string>, match: Record<string, string>): boolean {
  return memberMatches(match, params);
}

/** The member of a baseline a run with these params is compared with, if any. */
export function memberFor(b: Baseline, params: Record<string, string>): BaselineMember | undefined {
  return b.members.find((m) => matches(params, m.match));
}

export function fmtMatch(match: Record<string, string>): string {
  const e = Object.entries(match);
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join(', ') : 'any run';
}

/** Shorten a label for chart annotations, keeping it on one line. */
export function truncate(s: string, n = 22): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Distinct dash pattern per baseline, so two baselines never look alike in one chart. */
export const BASELINE_DASH = ['7 4', '2 3', '10 3 2 3', '4 2', '12 4', '1 5'];

/** A ratio as a percentage of the baseline: 1.034 → "103%". */
export function fmtRatio(r: number): string {
  const p = r * 100;
  return `${Math.abs(p) < 10 ? p.toFixed(1) : Math.round(p).toLocaleString('en-US')}%`;
}
