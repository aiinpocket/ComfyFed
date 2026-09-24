import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import { rangeParams, resolveRange, type RangeValue } from './reportRange';

// A fixed "now" mid-month, mid-day, so every preset has a distinct answer.
const NOW = new Date(2026, 8, 20, 15, 30, 45); // 2026-09-20 15:30:45 local

function value(preset: RangeValue['preset'], custom: RangeValue['custom'] = [null, null]): RangeValue {
  return { preset, custom };
}

describe('resolveRange', () => {
  it('today = start of today → now', () => {
    const [from, to] = resolveRange(value('today'), NOW);
    expect(from).toEqual(new Date(2026, 8, 20, 0, 0, 0, 0));
    expect(to).toEqual(NOW);
  });

  it('24h = now minus 24 hours → now', () => {
    const [from, to] = resolveRange(value('24h'), NOW);
    expect(from).toEqual(new Date(2026, 8, 19, 15, 30, 45));
    expect(to).toEqual(NOW);
  });

  it('7d = now minus 7 days → now', () => {
    const [from, to] = resolveRange(value('7d'), NOW);
    expect(from).toEqual(new Date(2026, 8, 13, 15, 30, 45));
    expect(to).toEqual(NOW);
  });

  it('1m = now minus one calendar month → now', () => {
    const [from, to] = resolveRange(value('1m'), NOW);
    expect(from).toEqual(new Date(2026, 7, 20, 15, 30, 45));
    expect(to).toEqual(NOW);
  });

  it('mtd = first of this month 00:00 → now', () => {
    const [from, to] = resolveRange(value('mtd'), NOW);
    expect(from).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
    expect(to).toEqual(NOW);
  });

  it('custom passes the picked bounds through untouched, blanks included', () => {
    const start = new Date(2026, 0, 2, 3, 4, 5);
    expect(resolveRange(value('custom', [start, null]), NOW)).toEqual([start, null]);
    expect(resolveRange(value('custom', [null, null]), NOW)).toEqual([null, null]);
  });
});

describe('rangeParams', () => {
  it('formats both bounds as ISO-8601 with the local UTC offset', () => {
    const start = new Date(2026, 8, 1, 0, 0, 0);
    const end = new Date(2026, 8, 20, 15, 30, 45);
    const { from, to } = rangeParams([start, end]);
    // Offset comes from the test machine's zone; assert shape + round-trip
    // rather than a hard-coded "+08:00".
    expect(from).toMatch(/^2026-09-01T00:00:00[+-]\d{2}:\d{2}$/);
    expect(to).toMatch(/^2026-09-20T15:30:45[+-]\d{2}:\d{2}$/);
    expect(dayjs(from).toDate()).toEqual(start);
    expect(dayjs(to).toDate()).toEqual(end);
  });

  it('leaves a blank bound undefined', () => {
    expect(rangeParams([null, null])).toEqual({ from: undefined, to: undefined });
    const only = rangeParams([null, new Date(2026, 8, 20, 12, 0, 0)]);
    expect(only.from).toBeUndefined();
    expect(only.to).toMatch(/^2026-09-20T12:00:00/);
  });
});
