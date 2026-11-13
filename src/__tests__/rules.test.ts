import { describe, expect, it } from 'vitest';
import { QUOTATION_TRANSITIONS, TRIP_TRANSITIONS } from '../config/constants';
import { can } from '../config/permissions';
import { safeCell, toCsvLine } from '../lib/csv';
import { gstinChecksumChar, isValidGstin } from '../lib/gstin';
import { normalizeRegistration } from '../lib/normalize';
import { diffDaysYmd, financialYear, startOfDayInTz, ymdInTz } from '../lib/time';
import { reminderTypeFor } from '../jobs/scheduler';
import { computeShortage, rangesOverlap } from '../modules/trips/trips.service';

describe('GSTIN', () => {
  it('accepts a valid checksum and rejects a bad one', () => {
    const base = '27AAACB1234C1Z';
    const good = base + gstinChecksumChar(base);
    expect(isValidGstin(good)).toBe(true);
    expect(isValidGstin(base + (good[14] === 'A' ? 'B' : 'A'))).toBe(false);
    expect(isValidGstin('99AAACB1234C1Z5')).toBe(false);
  });
});

describe('business timezone', () => {
  it('maps a calendar day in Asia/Kolkata to the right UTC instant', () => {
    expect(startOfDayInTz('2026-10-11', 'Asia/Kolkata').toISOString()).toBe('2026-10-10T18:30:00.000Z');
    expect(ymdInTz(new Date('2026-10-10T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-11');
    expect(diffDaysYmd('2026-10-11', '2026-10-18')).toBe(7);
  });
  it('labels Indian financial years', () => {
    expect(financialYear(new Date('2026-03-31T12:00:00Z'), 'Asia/Kolkata')).toBe('2025-26');
    expect(financialYear(new Date('2026-04-01T00:00:00Z'), 'Asia/Kolkata')).toBe('2026-27');
  });
});

describe('status transitions', () => {
  it('never allows delivered back to planned without correction', () => {
    expect(TRIP_TRANSITIONS.delivered).toEqual([]);
    expect(TRIP_TRANSITIONS.planned).toContain('in_transit');
  });
  it('issued quotations cannot go back to draft', () => {
    expect(QUOTATION_TRANSITIONS.issued).not.toContain('draft');
  });
});

describe('trip rules', () => {
  it('detects overlapping windows', () => {
    const d = (h: number) => new Date(Date.UTC(2026, 9, 11, h));
    expect(rangesOverlap(d(1), d(5), d(4), d(8))).toBe(true);
    expect(rangesOverlap(d(1), d(5), d(5), d(8))).toBe(false);
  });
  it('computes shortage and tolerance', () => {
    expect(computeShortage(12000, 11950, 0.5)).toEqual({ shortageLitres: 50, shortagePercent: 0.417, withinTolerance: true });
    expect(computeShortage(12000, 11900, 0.5).withinTolerance).toBe(false);
  });
});

describe('renewal reminders', () => {
  const w = [30, 15, 7, 1, 0];
  it('picks the tightest reached window', () => {
    expect(reminderTypeFor(40, w, 7)).toBeNull();
    expect(reminderTypeFor(12, w, 7)).toBe('D15');
    expect(reminderTypeFor(0, w, 7)).toBe('D0');
    expect(reminderTypeFor(-1, w, 7)).toBe('OVERDUE0');
    expect(reminderTypeFor(-8, w, 7)).toBe('OVERDUE1');
  });
});

describe('security helpers', () => {
  it('escapes spreadsheet formulas', () => {
    expect(safeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(toCsvLine(['+1', 'a,b'])).toBe(`'+1,"a,b"`);
  });
  it('normalizes plates', () => expect(normalizeRegistration('mh 12-ab 1234')).toBe('MH12AB1234'));
  it('enforces the role matrix', () => {
    expect(can('accounts', 'trips.manage')).toBe(false);
    expect(can('operations', 'trips.dispatch')).toBe(true);
    expect(can('sales', 'users.manage')).toBe(false);
    expect(can('admin', 'settings.manage')).toBe(true);
  });
});
