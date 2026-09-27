import { describe, expect, it } from 'vitest';
import { autoStatus, evaluatePoint, evaluateRun, identityKey, primaryPoint } from '../shared/evaluate.js';
import {
  canonicalJson,
  incompatibleChanges,
  normalizeDefinition,
  normalizeParams,
  validateValues,
} from '../shared/definition.js';
import { csvCell } from '../server/services/export.js';
import type { DataPointDef } from '../shared/types.js';

const tps: DataPointDef = {
  key: 'tok_s',
  label: 'tok/s',
  unit: 'tok/s',
  type: 'number',
  better: 'higher',
  description: '',
  bounds: { min: 500, relMin: 0.97 },
};

const def = normalizeDefinition({
  parameters: [
    { key: 'model', identity: true },
    { key: 'commit', identity: false },
  ],
  dataPoints: [
    tps,
    { key: 'ttft', type: 'number', better: 'lower', bounds: { relMax: 1.1 } },
    { key: 'golden', type: 'boolean', bounds: { expected: true } },
    { key: 'note', type: 'string' },
  ],
});

describe('evaluatePoint', () => {
  it('passes inside absolute and relative bounds and reports the improvement', () => {
    const e = evaluatePoint(tps, 770, 761);
    expect(e.verdict).toBe('pass');
    expect(e.delta).toBeCloseTo(9);
    expect(e.improved).toBe(true);
  });

  it('fails below the absolute minimum', () => {
    const e = evaluatePoint(tps, 400, null);
    expect(e.verdict).toBe('fail');
    expect(e.reasons[0]).toContain('min');
  });

  it('fails a relative drop larger than the bound (catches a −8% regression)', () => {
    const e = evaluatePoint(tps, 708, 770.5);
    expect(e.verdict).toBe('fail');
    expect(e.improved).toBe(false);
    expect(e.reasons.join()).toContain('baseline');
  });

  it('skips relative bounds without a baseline', () => {
    const e = evaluatePoint({ ...tps, bounds: { relMin: 0.97 } }, 100, undefined);
    expect(e.verdict).toBe('none');
  });

  it('treats a missing value as missing, not failed', () => {
    expect(evaluatePoint(tps, undefined, 700).verdict).toBe('missing');
  });

  it('checks expected booleans', () => {
    const golden = def.dataPoints.find((d) => d.key === 'golden')!;
    expect(evaluatePoint(golden, false, true).verdict).toBe('fail');
    expect(evaluatePoint(golden, true, undefined).verdict).toBe('pass');
  });
});

describe('evaluateRun / autoStatus', () => {
  it('any failing point fails the run', () => {
    const ev = evaluateRun(def, { tok_s: 770, ttft: 300, golden: true }, { tok_s: 770, ttft: 195 });
    expect(ev.verdict).toBe('fail');
    expect(autoStatus(ev)).toBe('fail');
  });

  it('no bounds evaluated gives info', () => {
    const ev = evaluateRun(def, { note: 'x' }, null);
    expect(autoStatus(ev)).toBe('info');
  });
});

describe('definition helpers', () => {
  it('defaults labels to keys and picks the first number as primary', () => {
    expect(def.parameters[0]!.label).toBe('model');
    expect(primaryPoint(def)!.key).toBe('tok_s');
  });

  it('rejects duplicate keys and a bad primary', () => {
    expect(() => normalizeDefinition({ dataPoints: [{ key: 'a' }, { key: 'a' }] })).toThrow();
    expect(() => normalizeDefinition({ dataPoints: [{ key: 'a' }], primary: 'b' })).toThrow();
  });

  it('rejects numeric bounds on a boolean', () => {
    expect(() =>
      normalizeDefinition({ dataPoints: [{ key: 'a', type: 'boolean', bounds: { min: 1 } }] }),
    ).toThrow();
  });

  it('flags a type change of an existing key as incompatible', () => {
    const next = normalizeDefinition({ dataPoints: [{ key: 'tok_s', type: 'string' }] });
    expect(incompatibleChanges(def, next)).toHaveLength(1);
    const added = normalizeDefinition({ dataPoints: [...def.dataPoints, { key: 'extra' }] });
    expect(incompatibleChanges(def, added)).toHaveLength(0);
  });

  it('validates values against the schema', () => {
    expect(validateValues(def, { tok_s: 1, golden: true })).toEqual([]);
    expect(validateValues(def, { tok_s: '1' })).toHaveLength(1);
    expect(validateValues(def, { nope: 1 })[0]).toContain('unknown data point');
    expect(validateValues(def, { tok_s: Number.NaN })).toHaveLength(1);
  });

  it('canonical JSON ignores key order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
  });

  it('stores params as strings and groups on identity params only', () => {
    const p = normalizeParams({ model: 'llama', concurrency: 16, skip: null });
    expect(p).toEqual({ model: 'llama', concurrency: '16' });
    expect(identityKey(def, { model: 'llama', commit: 'a' })).toBe(
      identityKey(def, { model: 'llama', commit: 'b' }),
    );
  });
});

describe('csv', () => {
  it('quotes cells with separators, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(1.5)).toBe('1.5');
  });
});
