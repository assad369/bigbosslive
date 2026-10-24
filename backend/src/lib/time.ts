/** Injectable clock so time-dependent logic (PK deadlines, game rounds, VIP expiry) is testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/**
 * "YYYY-MM" for the calendar month `date` falls in, in the given IANA timezone.
 * Used as the period key for host-agency monthly accounting.
 */
export function monthKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  return `${year}-${month}`;
}

export function previousMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
