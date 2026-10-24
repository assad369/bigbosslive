import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

const nf = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const num = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : nf.format(n);
export const short = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : compact.format(n);
export const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : usd.format(n);
export const pct = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined ? '—' : `${(n * 100).toFixed(digits)}%`;

export const dateTime = (d: string | Date | null | undefined) =>
  d ? dayjs(d).format('YYYY-MM-DD HH:mm') : '—';
export const ago = (d: string | Date | null | undefined) => (d ? dayjs(d).fromNow() : '—');

export function duration(seconds: number | null | undefined): string {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Download rows as CSV (client-side export of the current page/selection). */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]!);
  const escape = (v: unknown) => {
    const s =
      v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
