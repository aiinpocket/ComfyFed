import dayjs from 'dayjs';

/** Quick-pick presets for a report's time window. Everything but `custom`
 * is relative to "now" and is re-resolved on every load, so a refresh on
 * `24h` always means the *last* 24 hours, not the 24 hours before the page
 * was opened. */
export type RangePreset = 'today' | '24h' | '7d' | '1m' | 'mtd' | 'custom';

export const RANGE_PRESETS: readonly RangePreset[] = ['today', '24h', '7d', '1m', 'mtd', 'custom'];

export type DateBounds = [Date | null, Date | null];

export interface RangeValue {
  preset: RangePreset;
  /** The hand-picked bounds; only consulted when `preset === 'custom'`, but
   * kept around so switching back to custom restores what was typed. */
  custom: DateBounds;
}

export const DEFAULT_RANGE_VALUE: RangeValue = { preset: '7d', custom: [null, null] };

/** Turns a preset (or custom pick) into concrete `[from, to]` bounds. */
export function resolveRange(value: RangeValue, now: Date = new Date()): DateBounds {
  const end = new Date(now.getTime());
  const at = dayjs(now);
  switch (value.preset) {
    case 'today':
      return [at.startOf('day').toDate(), end];
    case '24h':
      return [at.subtract(24, 'hour').toDate(), end];
    case '7d':
      return [at.subtract(7, 'day').toDate(), end];
    case '1m':
      return [at.subtract(1, 'month').toDate(), end];
    case 'mtd':
      return [at.startOf('month').toDate(), end];
    case 'custom':
      return value.custom;
  }
}

/** ISO-8601 with the browser's UTC offset (`2026-09-20T15:30:45+08:00`) for
 * each bound, or `undefined` on a blank end. Both backends convert an
 * offset-aware value to UTC before comparing against receipt timestamps;
 * a naive value would be read as UTC and shift the window by the local
 * offset. */
export function rangeParams(range: DateBounds): { from?: string; to?: string } {
  const [from, to] = range;
  const fmt = (d: Date) => dayjs(d).format('YYYY-MM-DDTHH:mm:ssZ');
  return {
    from: from ? fmt(from) : undefined,
    to: to ? fmt(to) : undefined,
  };
}
