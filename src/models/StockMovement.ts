import { Schema, model, type Types } from 'mongoose';
import { STOCK_MOVEMENT_TYPES } from '../config/constants';

/** Append-only stock ledger. `quantity` is signed: receipts and returns add, issues subtract. */
export interface IStockMovement {
  _id: Types.ObjectId;
  itemId: Types.ObjectId;
  type: (typeof STOCK_MOVEMENT_TYPES)[number];
  quantity: number;
  balanceAfter: number;
  unitCostPaise: number;
  date: Date;
  purchaseOrderId?: Types.ObjectId | null;
  poNumber?: string;
  vehicleId?: Types.ObjectId | null;
  tripId?: Types.ObjectId | null;
  reference?: string;
  reason?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const StockMovementSchema = new Schema<IStockMovement>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'StockItem', required: true },
    type: { type: String, enum: STOCK_MOVEMENT_TYPES, required: true },
    quantity: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    unitCostPaise: { type: Number, default: 0 },
    date: { type: Date, required: true },
    purchaseOrderId: { type: Schema.Types.ObjectId, ref: 'PurchaseOrder', default: null },
    poNumber: String,
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', default: null },
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', default: null },
    reference: { type: String, trim: true, maxlength: 60 },
    reason: { type: String, trim: true, maxlength: 300 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
StockMovementSchema.index({ itemId: 1, date: -1 });
StockMovementSchema.index({ date: -1 });
StockMovementSchema.index({ vehicleId: 1, date: -1 }, { partialFilterExpression: { vehicleId: { $type: 'objectId' } } });

export const StockMovement = model<IStockMovement>('StockMovement', StockMovementSchema);
