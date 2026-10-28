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

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Milliseconds `timeZone` is ahead of UTC at `date`. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant a wall-clock midnight (y-m-d 00:00) happens in `timeZone`. */
function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  // Two passes settle DST: the offset at the guess may differ from the offset at the answer.
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - zoneOffsetMs(new Date(first), timeZone));
}

/** "YYYY-MM-DD" for the calendar day `date` falls in, in the given IANA timezone. */
export function dayKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function startOfZonedDay(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  return zonedMidnight(p.year, p.month, p.day, timeZone);
}

export function startOfZonedMonth(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  return zonedMidnight(p.year, p.month, 1, timeZone);
}

/** Start of the zoned day after the one `date` falls in. */
export function startOfNextZonedDay(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  return zonedMidnight(p.year, p.month, p.day + 1, timeZone);
}

/**
 * Split [from, to) at zoned midnights: one `{ dayKey, seconds }` per calendar day covered.
 * Used so live time from a session that crosses midnight lands on the right days.
 */
export function splitByZonedDay(
  from: Date,
  to: Date,
  timeZone: string,
): { dayKey: string; seconds: number }[] {
  const out: { dayKey: string; seconds: number }[] = [];
  let cursor = from;
  while (cursor < to) {
    const next = startOfNextZonedDay(cursor, timeZone);
    const end = next < to ? next : to;
    const seconds = Math.round((end.getTime() - cursor.getTime()) / 1000);
    if (seconds > 0) out.push({ dayKey: dayKey(cursor, timeZone), seconds });
    cursor = end;
  }
  return out;
}
