import { Schema, model, type Types } from 'mongoose';
import { PRODUCTS, QUOTATION_STATUS, QUOTATION_UNITS, type QuotationStatus } from '../config/constants';
import { AddressSchema, type Address } from './shared';

export interface QuotationLine {
  description: string;
  hsnSac?: string;
  product?: (typeof PRODUCTS)[number];
  route?: string;
  quantity: number;
  unit: (typeof QUOTATION_UNITS)[number];
  ratePaise: number;
  grossPaise: number;
  discountPaise: number;
  amountPaise: number;
}

export interface CompanySnapshot {
  companyCode: string;
  legalName: string;
  gstin?: string | null;
  billingAddress: Address;
  stateCode?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}

export interface IQuotation {
  _id: Types.ObjectId;
  quotationNumber?: string | null; // allocated atomically at issue time
  baseNumber?: string | null;
  rootId?: Types.ObjectId | null; // first quotation in a revision chain
  revision: number; // business revision (R0, R1 ...) – not the concurrency token
  previousId?: Types.ObjectId | null;
  companyId: Types.ObjectId;
  leadId?: Types.ObjectId | null;
  companySnapshot?: CompanySnapshot | null;
  subject?: string;
  issueDate?: Date | null;
  validUntil?: Date | null;
  lineItems: QuotationLine[];
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxRateBps: number;
  taxBreakdown: { type: 'CGST' | 'SGST' | 'IGST'; rateBps: number; amountPaise: number }[];
  taxTotalPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  currency: 'INR';
  taxConfigVersion: number;
  terms?: string;
  status: QuotationStatus;
  decisionReason?: string;
  decidedAt?: Date | null;
  decidedBy?: Types.ObjectId | null;
  pdf: { status: 'none' | 'pending' | 'ready' | 'failed'; storageKey?: string | null; generatedAt?: Date | null; error?: string | null };
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const LineSchema = new Schema<QuotationLine>(
  {
    description: { type: String, required: true, trim: true, maxlength: 300 },
    hsnSac: { type: String, trim: true, maxlength: 10 },
    product: { type: String, enum: PRODUCTS },
    route: { type: String, trim: true, maxlength: 200 },
    quantity: { type: Number, required: true, min: 0.001, max: 1_000_000 },
    unit: { type: String, enum: QUOTATION_UNITS, required: true },
    ratePaise: { type: Number, required: true, min: 0, max: 10_000_000_000 },
    grossPaise: { type: Number, required: true },
    discountPaise: { type: Number, default: 0 },
    amountPaise: { type: Number, required: true },
  },
  { _id: false },
);

const SnapshotSchema = new Schema<CompanySnapshot>(
  {
    companyCode: String,
    legalName: String,
    gstin: String,
    billingAddress: AddressSchema,
    stateCode: String,
    contactName: String,
    contactPhone: String,
    contactEmail: String,
  },
  { _id: false },
);

const QuotationSchema = new Schema<IQuotation>(
  {
    quotationNumber: { type: String, default: null },
    baseNumber: { type: String, default: null },
    rootId: { type: Schema.Types.ObjectId, ref: 'Quotation', default: null },
    revision: { type: Number, default: 0 },
    previousId: { type: Schema.Types.ObjectId, ref: 'Quotation', default: null },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    companySnapshot: { type: SnapshotSchema, default: null },
    subject: { type: String, trim: true, maxlength: 200 },
    issueDate: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    lineItems: { type: [LineSchema], validate: [(v: QuotationLine[]) => v.length >= 1 && v.length <= 50, '1 to 50 line items'] },
    subtotalPaise: { type: Number, required: true },
    discountPaise: { type: Number, default: 0 },
    taxablePaise: { type: Number, required: true },
    taxRateBps: { type: Number, required: true },
    taxBreakdown: [{ _id: false, type: { type: String, enum: ['CGST', 'SGST', 'IGST'] }, rateBps: Number, amountPaise: Number }],
    taxTotalPaise: { type: Number, required: true },
    roundOffPaise: { type: Number, default: 0 },
    totalPaise: { type: Number, required: true },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    taxConfigVersion: { type: Number, required: true },
    terms: { type: String, trim: true, maxlength: 4000 },
    status: { type: String, enum: QUOTATION_STATUS, default: 'draft' },
    decisionReason: { type: String, trim: true, maxlength: 500 },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    pdf: {
      status: { type: String, enum: ['none', 'pending', 'ready', 'failed'], default: 'none' },
      storageKey: { type: String, default: null, select: false },
      generatedAt: { type: Date, default: null },
      error: { type: String, default: null },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, optimisticConcurrency: true },
);
QuotationSchema.index({ quotationNumber: 1 }, { unique: true, partialFilterExpression: { quotationNumber: { $type: 'string' } } });
QuotationSchema.index({ companyId: 1, issueDate: -1 });
QuotationSchema.index({ status: 1, issueDate: -1 });
QuotationSchema.index({ status: 1, validUntil: 1 });
QuotationSchema.index({ rootId: 1, revision: 1 });
QuotationSchema.index({ createdAt: -1 });

export const Quotation = model<IQuotation>('Quotation', QuotationSchema);
