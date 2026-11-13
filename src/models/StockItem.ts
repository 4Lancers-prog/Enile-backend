import { Schema, model, type Types } from 'mongoose';
import { ITEM_STATUS, STOCK_CATEGORIES, STOCK_UNITS } from '../config/constants';

/**
 * A stores item (spares, tyres, lubricants, seals). `onHandQty` and
 * `avgCostPaise` are only changed by stock movements, with atomic updates,
 * so concurrent issues can never take stock below zero.
 */
export interface IStockItem {
  _id: Types.ObjectId;
  itemCode: string;
  name: string;
  normalizedName: string;
  category: (typeof STOCK_CATEGORIES)[number];
  unit: (typeof STOCK_UNITS)[number];
  hsnSac?: string;
  reorderLevel: number;
  onHandQty: number;
  avgCostPaise: number;
  lastPurchaseRatePaise?: number | null;
  lastSupplierId?: Types.ObjectId | null;
  location?: string;
  status: (typeof ITEM_STATUS)[number];
  notes?: string;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const StockItemSchema = new Schema<IStockItem>(
  {
    itemCode: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    normalizedName: { type: String, required: true },
    category: { type: String, enum: STOCK_CATEGORIES, required: true },
    unit: { type: String, enum: STOCK_UNITS, required: true },
    hsnSac: { type: String, trim: true, maxlength: 10 },
    reorderLevel: { type: Number, default: 0, min: 0 },
    onHandQty: { type: Number, default: 0, min: 0 },
    avgCostPaise: { type: Number, default: 0, min: 0 },
    lastPurchaseRatePaise: { type: Number, default: null },
    lastSupplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', default: null },
    location: { type: String, trim: true, maxlength: 60 },
    status: { type: String, enum: ITEM_STATUS, default: 'active' },
    notes: { type: String, trim: true, maxlength: 1000 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, optimisticConcurrency: true },
);
StockItemSchema.index({ itemCode: 1 }, { unique: true });
StockItemSchema.index({ normalizedName: 1 }, { unique: true });
StockItemSchema.index({ status: 1, category: 1, normalizedName: 1 });

export const StockItem = model<IStockItem>('StockItem', StockItemSchema);
