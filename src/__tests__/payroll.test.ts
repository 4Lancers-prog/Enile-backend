import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriverPayment } from '../models/DriverPayment';
import { Trip } from '../models/Trip';
import { priceLines } from '../modules/purchases/purchases.service';
import { computeSalaries, monthBounds } from '../modules/payroll/payroll.service';

const TZ = 'Asia/Kolkata';
const id = new Types.ObjectId();
const driver = { _id: id, joiningDate: new Date('2024-01-01T00:00:00+05:30'), monthlySalaryPaise: 3_000_000, tripAllowancePaise: 30_000, salaryDay: 7, advanceRecoveryPaise: 200_000 };

/**
 * computeSalaries runs four grouped queries: delivered trips, salary already
 * paid for the month, trip allowance paid in the month, and advance balances.
 */
function mockDb({ trips = 0, salaryPaid = 0, recovered = 0, allowancePaid = 0, advanced = 0, recoveredAll = 0, leaveDays }: Record<string, number | undefined> = {}) {
  vi.spyOn(Trip, 'aggregate').mockResolvedValue(trips ? ([{ _id: id, n: trips }] as never) : ([] as never));
  const pay = vi.spyOn(DriverPayment, 'aggregate');
  pay.mockResolvedValueOnce((salaryPaid || recovered ? [{ _id: id, amount: salaryPaid, recovered, n: 1, leaveDays, deductions: 0 }] : []) as never);
  pay.mockResolvedValueOnce((allowancePaid ? [{ _id: id, amount: allowancePaid }] : []) as never);
  pay.mockResolvedValueOnce((advanced ? [{ _id: id, advanced, recovered: recoveredAll }] : []) as never);
}

afterEach(() => vi.restoreAllMocks());

describe('salary calculation', () => {
  it('knows month lengths, including February in a leap year', () => {
    expect(monthBounds('2026-11', TZ).daysInMonth).toBe(30);
    expect(monthBounds('2028-02', TZ).daysInMonth).toBe(29);
    expect(monthBounds('2026-12', TZ).next).toBe('2027-01');
  });

  it('adds per-trip allowance and recovers the monthly advance instalment', async () => {
    mockDb({ trips: 10, advanced: 1_000_000 });
    const [r] = await computeSalaries([driver], '2026-10', TZ);
    expect(r.basicPaise).toBe(3_000_000);
    expect(r.tripAllowancePaise).toBe(300_000);
    expect(r.grossPaise).toBe(3_300_000);
    expect(r.advanceRecoveryPaise).toBe(200_000);
    expect(r.netPaise).toBe(3_100_000);
    expect(r.balanceDuePaise).toBe(3_100_000);
    expect(r.dueDate).toBe('2026-11-07');
  });

  it('pro-rates the month a driver joins and takes off unpaid leave', async () => {
    mockDb();
    const joined = { ...driver, joiningDate: new Date('2026-10-17T00:00:00+05:30') };
    const [r] = await computeSalaries([joined], '2026-10', TZ, { leaveDays: 2 });
    // 31-day month, joined on the 17th: 15 days, minus 2 leave days = 13
    expect(r.payableDays).toBe(13);
    expect(r.basicPaise).toBe(Math.round((3_000_000 * 13) / 31));
  });

  it('subtracts salary and allowance already paid, so a second payment only covers the balance', async () => {
    mockDb({ salaryPaid: 1_000_000, recovered: 200_000, allowancePaid: 100_000, advanced: 1_000_000, recoveredAll: 200_000 });
    const [r] = await computeSalaries([driver], '2026-10', TZ);
    expect(r.advanceRecoveryPaise).toBe(0); // this month's instalment was already taken
    expect(r.netPaise).toBe(3_000_000 - 100_000 - 200_000);
    expect(r.balanceDuePaise).toBe(3_000_000 - 100_000 - 200_000 - 1_000_000);
    expect(r.status).toBe('partial');
  });

  it('never recovers more than the advance outstanding', async () => {
    mockDb({ advanced: 50_000 });
    const [r] = await computeSalaries([driver], '2026-10', TZ, { advanceRecoveryPaise: 900_000 });
    expect(r.advanceRecoveryPaise).toBe(50_000);
    expect(r.maxRecoveryPaise).toBe(50_000);
  });

  it('shows no salary for a month before the driver joined', async () => {
    mockDb();
    const later = { ...driver, joiningDate: new Date('2026-12-01T00:00:00+05:30') };
    const [r] = await computeSalaries([later], '2026-10', TZ);
    expect(r.status).toBe('not_joined');
    expect(r.balanceDuePaise).toBe(0);
  });
});

describe('purchase order pricing', () => {
  it('prices lines in paise with GST per line', () => {
    const itemId = new Types.ObjectId();
    const items = new Map([[String(itemId), { _id: itemId, name: 'Diesel filter', unit: 'nos' as const }]]);
    const out = priceLines([{ itemId: String(itemId), quantity: 3, ratePaise: 65_050, taxRateBps: 1800 }], items);
    expect(out.subtotalPaise).toBe(195_150);
    expect(out.taxTotalPaise).toBe(35_127);
    expect(out.totalPaise).toBe(230_277);
  });
});
