import { Schema, model, type Types } from 'mongoose';
import { PO_STATUS, STOCK_UNITS, type PoStatus } from '../config/constants';

export interface PoLine {
  itemId: Types.ObjectId;
  itemName: string;
  unit: (typeof STOCK_UNITS)[number];
  quantity: number;
  receivedQty: number;
  ratePaise: number;
  taxRateBps: number;
  amountPaise: number; // quantity × rate, before tax
  taxPaise: number;
}

export interface PoReceipt {
  _id: Types.ObjectId;
  receivedAt: Date;
  receivedBy: Types.ObjectId;
  invoiceNumber?: string;
  note?: string;
  lines: { itemId: Types.ObjectId; quantity: number }[];
}

export interface IPurchaseOrder {
  _id: Types.ObjectId;
  poNumber: string;
  supplierId: Types.ObjectId;
  supplierSnapshot: { name: string; gstin?: string };
  orderDate: Date;
  expectedDate?: Date | null;
  status: PoStatus;
  lines: PoLine[];
  subtotalPaise: number;
  taxTotalPaise: number;
  totalPaise: number;
  receivedValuePaise: number;
  receipts: PoReceipt[];
  deliverTo?: string;
  notes?: string;
  closeReason?: string;
  issuedAt?: Date | null;
  issuedBy?: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const LineSchema = new Schema<PoLine>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'StockItem', required: true },
    itemName: { type: String, required: true },
    unit: { type: String, enum: STOCK_UNITS, required: true },
    quantity: { type: Number, required: true, min: 0.001 },
    receivedQty: { type: Number, default: 0, min: 0 },
    ratePaise: { type: Number, required: true, min: 0 },
    taxRateBps: { type: Number, default: 0, min: 0, max: 2800 },
    amountPaise: { type: Number, required: true },
    taxPaise: { type: Number, required: true },
  },
  { _id: false },
);

const ReceiptSchema = new Schema<PoReceipt>({
  receivedAt: { type: Date, required: true },
  receivedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  invoiceNumber: { type: String, trim: true, maxlength: 60 },
  note: { type: String, trim: true, maxlength: 300 },
  lines: [{ _id: false, itemId: { type: Schema.Types.ObjectId, required: true }, quantity: { type: Number, required: true } }],
});

const PurchaseOrderSchema = new Schema<IPurchaseOrder>(
  {
    poNumber: { type: String, required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierSnapshot: { name: { type: String, required: true }, gstin: String },
    orderDate: { type: Date, required: true },
    expectedDate: { type: Date, default: null },
    status: { type: String, enum: PO_STATUS, default: 'draft' },
    lines: { type: [LineSchema], validate: [(v: unknown[]) => v.length > 0 && v.length <= 50, 'A purchase order needs 1 to 50 lines.'] },
    subtotalPaise: { type: Number, required: true },
    taxTotalPaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
    receivedValuePaise: { type: Number, default: 0 },
    receipts: { type: [ReceiptSchema], default: [] },
    deliverTo: { type: String, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 1000 },
    closeReason: { type: String, trim: true, maxlength: 300 },
    issuedAt: { type: Date, default: null },
    issuedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, optimisticConcurrency: true },
);
PurchaseOrderSchema.index({ poNumber: 1 }, { unique: true });
PurchaseOrderSchema.index({ status: 1, orderDate: -1 });
PurchaseOrderSchema.index({ supplierId: 1, orderDate: -1 });
PurchaseOrderSchema.index({ 'lines.itemId': 1, status: 1 });

export const PurchaseOrder = model<IPurchaseOrder>('PurchaseOrder', PurchaseOrderSchema);
