/**
 * Server-side quotation maths (manual 4.3). All money is integer paise and all
 * intermediate maths uses BigInt, so totals never suffer floating-point drift.
 * Rounding policy: half-up to the paisa per line and per tax component, with an
 * optional round-off of the grand total to the nearest rupee (configurable).
 */
export interface LineInput {
  description: string;
  hsnSac?: string;
  quantity: number; // up to 3 decimals
  unit: string;
  ratePaise: number;
  discountPaise?: number;
}

export interface TaxPolicy {
  taxRateBps: number; // 1200 = 12%
  intraState: boolean; // CGST+SGST when true, IGST otherwise
  roundOffTotal: boolean;
}

export interface ComputedLine extends LineInput {
  grossPaise: number;
  discountPaise: number;
  amountPaise: number;
}

export interface TaxLine {
  type: 'CGST' | 'SGST' | 'IGST';
  rateBps: number;
  amountPaise: number;
}

export interface QuotationTotals {
  lineItems: ComputedLine[];
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxBreakdown: TaxLine[];
  taxTotalPaise: number;
  roundOffPaise: number;
  totalPaise: number;
}

/** Half-up integer division for non-negative BigInts. */
export function divHalfUp(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error('denominator must be positive');
  if (num < 0n) return -divHalfUp(-num, den);
  return (2n * num + den) / (2n * den);
}

export function toMilli(quantity: number): bigint {
  if (!Number.isFinite(quantity)) throw new Error('quantity must be finite');
  return BigInt(Math.round(quantity * 1000));
}

export function computeQuotation(lines: LineInput[], policy: TaxPolicy): QuotationTotals {
  let subtotal = 0n;
  let discount = 0n;
  const lineItems: ComputedLine[] = lines.map((l) => {
    const gross = divHalfUp(toMilli(l.quantity) * BigInt(l.ratePaise), 1000n);
    const disc = BigInt(l.discountPaise ?? 0);
    if (disc > gross) throw new Error('discount exceeds line amount');
    subtotal += gross;
    discount += disc;
    return { ...l, grossPaise: Number(gross), discountPaise: Number(disc), amountPaise: Number(gross - disc) };
  });

  const taxable = subtotal - discount;
  const rate = BigInt(policy.taxRateBps);
  const taxBreakdown: TaxLine[] = [];
  if (rate > 0n) {
    if (policy.intraState) {
      const half = policy.taxRateBps / 2;
      const each = divHalfUp(taxable * rate, 20_000n);
      taxBreakdown.push({ type: 'CGST', rateBps: half, amountPaise: Number(each) });
      taxBreakdown.push({ type: 'SGST', rateBps: half, amountPaise: Number(each) });
    } else {
      taxBreakdown.push({ type: 'IGST', rateBps: policy.taxRateBps, amountPaise: Number(divHalfUp(taxable * rate, 10_000n)) });
    }
  }
  const taxTotal = taxBreakdown.reduce((s, t) => s + BigInt(t.amountPaise), 0n);
  const raw = taxable + taxTotal;
  const total = policy.roundOffTotal ? divHalfUp(raw, 100n) * 100n : raw;

  return {
    lineItems,
    subtotalPaise: Number(subtotal),
    discountPaise: Number(discount),
    taxablePaise: Number(taxable),
    taxBreakdown,
    taxTotalPaise: Number(taxTotal),
    roundOffPaise: Number(total - raw),
    totalPaise: Number(total),
  };
}

export const formatInr = (paise: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
