import { describe, expect, it } from 'vitest';
import { computeQuotation, divHalfUp } from '../lib/money';

describe('quotation maths (integer paise, half-up)', () => {
  it('rounds half up', () => {
    expect(divHalfUp(5n, 10n)).toBe(1n);
    expect(divHalfUp(4n, 10n)).toBe(0n);
    expect(divHalfUp(15n, 10n)).toBe(2n);
  });

  it('splits intra-state tax into CGST + SGST', () => {
    const t = computeQuotation([{ description: 'HSD', quantity: 20, unit: 'KL', ratePaise: 150000 }], { taxRateBps: 1200, intraState: true, roundOffTotal: false });
    expect(t.subtotalPaise).toBe(3_000_000);
    expect(t.taxBreakdown.map((x) => x.type)).toEqual(['CGST', 'SGST']);
    expect(t.taxTotalPaise).toBe(360_000);
    expect(t.totalPaise).toBe(3_360_000);
  });

  it('uses IGST inter-state and rounds the total to the rupee', () => {
    const t = computeQuotation([{ description: 'x', quantity: 1.333, unit: 'KL', ratePaise: 99999 }], { taxRateBps: 500, intraState: false, roundOffTotal: true });
    expect(t.taxBreakdown).toHaveLength(1);
    expect(t.totalPaise % 100).toBe(0);
    expect(t.totalPaise - t.roundOffPaise).toBe(t.taxablePaise + t.taxTotalPaise);
  });

  it('handles zero values and discounts', () => {
    const t = computeQuotation([{ description: 'x', quantity: 2, unit: 'trip', ratePaise: 0 }], { taxRateBps: 0, intraState: true, roundOffTotal: true });
    expect(t.totalPaise).toBe(0);
    expect(() => computeQuotation([{ description: 'x', quantity: 1, unit: 'trip', ratePaise: 100, discountPaise: 101 }], { taxRateBps: 0, intraState: true, roundOffTotal: false })).toThrow();
  });
});
