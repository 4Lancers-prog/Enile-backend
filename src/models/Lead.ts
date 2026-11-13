import { Schema, model, type Types } from 'mongoose';
import { LEAD_SOURCES, LEAD_STATUS, PRODUCTS } from '../config/constants';

/** Referral leads (gap 1: in scope but missing from the manual's data model). */
export interface ILead {
  _id: Types.ObjectId;
  name: string;
  normalizedName: string;
  contactPerson?: string;
  phone?: string;
  normalizedPhone?: string;
  email?: string;
  source: (typeof LEAD_SOURCES)[number];
  referredBy?: string;
  products: (typeof PRODUCTS)[number][];
  estimatedMonthlyKl?: number;
  route?: string;
  status: (typeof LEAD_STATUS)[number];
  lostReason?: string;
  followUpAt?: Date | null;
  assignedTo?: Types.ObjectId | null;
  convertedCompanyId?: Types.ObjectId | null;
  convertedAt?: Date | null;
  notes?: string;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const LeadSchema = new Schema<ILead>(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    normalizedName: { type: String, required: true },
    contactPerson: { type: String, trim: true, maxlength: 100 },
    phone: { type: String, trim: true, maxlength: 20 },
    normalizedPhone: { type: String },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    source: { type: String, enum: LEAD_SOURCES, default: 'referral' },
    referredBy: { type: String, trim: true, maxlength: 160 },
    products: [{ type: String, enum: PRODUCTS }],
    estimatedMonthlyKl: { type: Number, min: 0, max: 1_000_000 },
    route: { type: String, trim: true, maxlength: 200 },
    status: { type: String, enum: LEAD_STATUS, default: 'new' },
    lostReason: { type: String, trim: true, maxlength: 300 },
    followUpAt: { type: Date, default: null },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    convertedCompanyId: { type: Schema.Types.ObjectId, ref: 'Company', default: null },
    convertedAt: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 2000 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, optimisticConcurrency: true },
);
LeadSchema.index({ status: 1, createdAt: -1 });
LeadSchema.index({ normalizedName: 1 });
LeadSchema.index({ normalizedPhone: 1 }, { sparse: true });
LeadSchema.index({ assignedTo: 1, followUpAt: 1 });

export const Lead = model<ILead>('Lead', LeadSchema);
