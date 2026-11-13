/**
 * Spreadsheet export safety (manual 4.7): values starting with = + - @ tab or CR
 * are prefixed with an apostrophe so Excel/Sheets never evaluate them as formulas.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function safeCell(value: unknown): string | number {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  return FORMULA_START.test(s) ? `'${s}` : s;
}

export function toCsvLine(values: unknown[]): string {
  return values
    .map((v) => {
      const s = String(safeCell(v));
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}
