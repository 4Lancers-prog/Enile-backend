/**
 * Business-timezone helpers. Instants are stored in UTC; daily grouping, expiry
 * dates and financial years use the configured timezone (default Asia/Kolkata).
 */
export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number;
}

export function partsInTz(date: Date, timeZone: string): DateParts & { hour: number; minute: number; second: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

/** Offset of the timezone from UTC at the given instant, in milliseconds. */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = partsInTz(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant for 00:00 of a YYYY-MM-DD calendar date in the business timezone. */
export function startOfDayInTz(ymd: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const offset = tzOffsetMs(guess, timeZone);
  const result = new Date(guess.getTime() - offset);
  // Re-check once in case the offset differs across the boundary (DST zones).
  const offset2 = tzOffsetMs(result, timeZone);
  return offset2 === offset ? result : new Date(guess.getTime() - offset2);
}

export function ymdInTz(date: Date, timeZone: string): string {
  const p = partsInTz(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function todayYmd(timeZone: string): string {
  return ymdInTz(new Date(), timeZone);
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

const ymdToUtc = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** Whole calendar days from `fromYmd` to `toYmd` (negative when in the past). */
export function diffDaysYmd(fromYmd: string, toYmd: string): number {
  return Math.round((ymdToUtc(toYmd) - ymdToUtc(fromYmd)) / 86_400_000);
}

/** Indian financial year label, e.g. "2026-27" for dates from 1 April 2026. */
export function financialYear(date: Date, timeZone: string): string {
  const { year, month } = partsInTz(date, timeZone);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
