import { Schema, model, type Types } from 'mongoose';
import { COMPANY_STATUS, CUSTOMER_TYPES } from '../config/constants';
import { AddressSchema, type Address } from './shared';

export interface Contact {
  name: string;
  designation?: string;
  phone?: string;
  normalizedPhone?: string;
  email?: string;
  isPrimary?: boolean;
}

export interface ICompany {
  _id: Types.ObjectId;
  companyCode: string;
  legalName: string;
  tradeName?: string;
  normalizedName: string;
  customerType: (typeof CUSTOMER_TYPES)[number];
  gstin?: string | null;
  pan?: string;
  billingAddress: Address;
  contacts: Contact[];
  phones: string[]; // normalized phones of all contacts, for the duplicate/search index
  creditDays?: number;
  notes?: string;
  status: (typeof COMPANY_STATUS)[number];
  leadId?: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ContactSchema = new Schema<Contact>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    designation: { type: String, trim: true, maxlength: 80 },
    phone: { type: String, trim: true, maxlength: 20 },
    normalizedPhone: String,
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: false },
);

const CompanySchema = new Schema<ICompany>(
  {
    companyCode: { type: String, required: true },
    legalName: { type: String, required: true, trim: true, maxlength: 160 },
    tradeName: { type: String, trim: true, maxlength: 160 },
    normalizedName: { type: String, required: true },
    customerType: { type: String, enum: CUSTOMER_TYPES, default: 'other' },
    gstin: { type: String, uppercase: true, trim: true, default: null },
    pan: { type: String, uppercase: true, trim: true },
    billingAddress: { type: AddressSchema, default: {} },
    contacts: { type: [ContactSchema], validate: [(v: Contact[]) => v.length <= 10, 'At most 10 contacts'] },
    phones: [{ type: String }],
    creditDays: { type: Number, min: 0, max: 365 },
    notes: { type: String, trim: true, maxlength: 2000 },
    status: { type: String, enum: COMPANY_STATUS, default: 'active' },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, optimisticConcurrency: true },
);
CompanySchema.index({ companyCode: 1 }, { unique: true });
// Policy: one GSTIN = one billing entity. Branches of the same entity are contacts/addresses.
CompanySchema.index({ gstin: 1 }, { unique: true, partialFilterExpression: { gstin: { $type: 'string' } } });
CompanySchema.index({ normalizedName: 1 });
CompanySchema.index({ phones: 1 });
CompanySchema.index({ status: 1, createdAt: -1 });

export const Company = model<ICompany>('Company', CompanySchema);
