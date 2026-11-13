import { Schema, model, type Types } from 'mongoose';
import { SUPPLIER_STATUS } from '../config/constants';
import { AddressSchema, type Address } from './shared';

export interface ISupplier {
  _id: Types.ObjectId;
  supplierCode: string;
  name: string;
  normalizedName: string;
  gstin?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  address?: Address;
  paymentTermsDays?: number;
  status: (typeof SUPPLIER_STATUS)[number];
  notes?: string;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const SupplierSchema = new Schema<ISupplier>(
  {
    supplierCode: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    normalizedName: { type: String, required: true },
    gstin: { type: String, trim: true, uppercase: true, maxlength: 15 },
    contactName: { type: String, trim: true, maxlength: 100 },
    phone: { type: String, trim: true, maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    address: { type: AddressSchema, default: undefined },
    paymentTermsDays: { type: Number, min: 0, max: 365 },
    status: { type: String, enum: SUPPLIER_STATUS, default: 'active' },
    notes: { type: String, trim: true, maxlength: 1000 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, optimisticConcurrency: true },
);
SupplierSchema.index({ supplierCode: 1 }, { unique: true });
SupplierSchema.index({ normalizedName: 1 }, { unique: true });
SupplierSchema.index({ gstin: 1 }, { unique: true, partialFilterExpression: { gstin: { $type: 'string' } } });
SupplierSchema.index({ status: 1, normalizedName: 1 });

export const Supplier = model<ISupplier>('Supplier', SupplierSchema);
