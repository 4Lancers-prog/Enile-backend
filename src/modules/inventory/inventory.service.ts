import type { Types } from 'mongoose';
import { AppError, ErrorCodes } from '../../lib/errors';
import { StockItem } from '../../models/StockItem';
import { StockMovement, type IStockMovement } from '../../models/StockMovement';

type MovementInput = Pick<IStockMovement, 'type' | 'quantity' | 'date'> &
  Partial<Pick<IStockMovement, 'unitCostPaise' | 'purchaseOrderId' | 'poNumber' | 'vehicleId' | 'tripId' | 'reference' | 'reason'>> & {
    itemId: Types.ObjectId | string;
    userId: string;
  };

/**
 * Moves stock in or out with one atomic update on the item, then writes the
 * ledger row. A removal only matches while enough stock is on hand, so two
 * people issuing the last unit at once cannot both succeed. Receipts with a
 * cost update the weighted average cost in the same update.
 */
export async function applyMovement(m: MovementInput) {
  const q = m.quantity;
  const cost = m.unitCostPaise ?? 0;
  const item =
    q < 0
      ? await StockItem.findOneAndUpdate({ _id: m.itemId, onHandQty: { $gte: -q } }, { $inc: { onHandQty: q } }, { new: true }).lean()
      : await StockItem.findOneAndUpdate(
          { _id: m.itemId },
          [
            {
              $set: {
                avgCostPaise:
                  cost > 0
                    ? { $round: [{ $divide: [{ $add: [{ $multiply: ['$onHandQty', '$avgCostPaise'] }, q * cost] }, { $add: ['$onHandQty', q] }] }, 0] }
                    : '$avgCostPaise',
                onHandQty: { $add: ['$onHandQty', q] },
                ...(m.type === 'purchase_receipt' && cost > 0 ? { lastPurchaseRatePaise: cost } : {}),
              },
            },
          ],
          { new: true },
        ).lean();
  if (!item) {
    const current = await StockItem.findById(m.itemId).select('name onHandQty unit').lean();
    if (!current) throw AppError.notFound('Stock item');
    throw AppError.unprocessable(ErrorCodes.STOCK_INSUFFICIENT, `Only ${current.onHandQty} ${current.unit} of ${current.name} in stock.`, [{ field: 'quantity', code: 'STOCK_INSUFFICIENT' }], {
      onHandQty: current.onHandQty,
    });
  }
  try {
    return await StockMovement.create({
      itemId: item._id,
      type: m.type,
      quantity: q,
      balanceAfter: item.onHandQty,
      unitCostPaise: cost || item.avgCostPaise,
      date: m.date,
      purchaseOrderId: m.purchaseOrderId ?? null,
      poNumber: m.poNumber,
      vehicleId: m.vehicleId ?? null,
      tripId: m.tripId ?? null,
      reference: m.reference,
      reason: m.reason,
      createdBy: m.userId,
    });
  } catch (err) {
    // Keep the balance and the ledger in step if the ledger write fails.
    await StockItem.updateOne({ _id: item._id }, { $inc: { onHandQty: -q } }).catch(() => undefined);
    throw err;
  }
}
