import type { Types } from 'mongoose';
import { divHalfUp, toMilli } from '../../lib/money';
import type { PoLine } from '../../models/PurchaseOrder';

export interface LineIn {
  itemId: string;
  quantity: number;
  ratePaise: number;
  taxRateBps: number;
}

/** Line and order totals in integer paise (half-up rounding per line). */
export function priceLines(lines: LineIn[], items: Map<string, { _id: Types.ObjectId; name: string; unit: PoLine['unit'] }>, received = new Map<string, number>()) {
  let subtotal = 0;
  let tax = 0;
  const out: PoLine[] = lines.map((l) => {
    const item = items.get(l.itemId)!;
    const amount = Number(divHalfUp(toMilli(l.quantity) * BigInt(l.ratePaise), 1000n));
    const t = Number(divHalfUp(BigInt(amount) * BigInt(l.taxRateBps), 10_000n));
    subtotal += amount;
    tax += t;
    return { itemId: item._id, itemName: item.name, unit: item.unit, quantity: l.quantity, receivedQty: received.get(l.itemId) ?? 0, ratePaise: l.ratePaise, taxRateBps: l.taxRateBps, amountPaise: amount, taxPaise: t };
  });
  return { lines: out, subtotalPaise: subtotal, taxTotalPaise: tax, totalPaise: subtotal + tax };
}

/** Value (with tax) of a received quantity on a line. */
export const receivedValue = (l: PoLine, q: number) => {
  const amount = Number(divHalfUp(toMilli(q) * BigInt(l.ratePaise), 1000n));
  return amount + Number(divHalfUp(BigInt(amount) * BigInt(l.taxRateBps), 10_000n));
};

/** Unit cost used for stock valuation: the purchase rate before GST (GST is claimed back as input credit). */
export const unitCost = (l: PoLine) => l.ratePaise;
