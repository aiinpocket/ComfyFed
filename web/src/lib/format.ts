import type { TFunction } from 'i18next';

/** "3h 12m 05s" style duration from a raw second count. */
export function formatGpuSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Coarse relative time ("3 分鐘前" / "3 min ago"), translated. */
export function formatRelative(iso: string | null | undefined, t: TFunction): string {
  if (!iso) return t('common.never');
  // The server serialises naive UTC datetimes; append Z so Date parses as UTC.
  const normalized = /[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const then = new Date(normalized).getTime();
  if (Number.isNaN(then)) return t('common.unknown');

  const diffSeconds = Math.round((Date.now() - then) / 1000);
  if (diffSeconds < 10) return t('time.just_now');
  if (diffSeconds < 60) return t('time.seconds_ago', { count: diffSeconds });
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return t('time.minutes_ago', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hours_ago', { count: hours });
  const days = Math.floor(hours / 24);
  return t('time.days_ago', { count: days });
}

/** Absolute local timestamp, for tooltips and table cells. */
export function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return '—';
  const normalized = /[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export function formatGb(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 10) / 10} GB`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Human-readable byte count ("512 KB", "1.3 GB") for the P2P upload volume
 * column -- base-1024, one decimal place from MB up. */
export function formatBytes(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 B';
  const exponent = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** exponent;
  const rounded = exponent === 0 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${rounded} ${BYTE_UNITS[exponent]}`;
}

/** First 8 characters of an id, for dense tables. */
export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}
