import { Schema, model, type Types } from 'mongoose';
import { DRIVER_PAYMENT_STATUS, DRIVER_PAYMENT_TYPES, PAYMENT_MODES, type DriverPaymentType } from '../config/constants';
import { FileRefSchema, type FileRef } from './shared';

/**
 * Money paid to a driver. Payments are never edited or deleted: a mistake is
 * voided with a reason and entered again, so the ledger always adds up.
 */
export interface SalaryBreakdown {
  month: string; // YYYY-MM
  daysInMonth: number;
  payableDays: number;
  leaveDays: number;
  monthlySalaryPaise: number;
  basicPaise: number; // salary for the payable days
  tripAllowancePaise: number;
  deliveredTrips: number;
  grossPaise: number;
  advanceRecoveryPaise: number;
  otherDeductionsPaise: number;
  netPaise: number;
}

export interface IDriverPayment {
  _id: Types.ObjectId;
  paymentNumber: string;
  driverId: Types.ObjectId;
  driverName: string;
  type: DriverPaymentType;
  amountPaise: number;
  paymentDate: Date;
  paymentMode: (typeof PAYMENT_MODES)[number];
  reference?: string;
  paidById: Types.ObjectId;
  paidByName: string;
  salaryMonth?: string | null;
  salary?: SalaryBreakdown | null;
  /** Salary payments: the part of the advance balance this payment recovers (not cash). */
  advanceRecoveryPaise: number;
  expenseIds: Types.ObjectId[];
  notes?: string;
  slip?: FileRef | null;
  status: (typeof DRIVER_PAYMENT_STATUS)[number];
  voidReason?: string;
  voidedBy?: Types.ObjectId | null;
  voidedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SalarySchema = new Schema<SalaryBreakdown>(
  {
    month: String,
    daysInMonth: Number,
    payableDays: Number,
    leaveDays: Number,
    monthlySalaryPaise: Number,
    basicPaise: Number,
    tripAllowancePaise: Number,
    deliveredTrips: Number,
    grossPaise: Number,
    advanceRecoveryPaise: Number,
    otherDeductionsPaise: Number,
    netPaise: Number,
  },
  { _id: false },
);

const DriverPaymentSchema = new Schema<IDriverPayment>(
  {
    paymentNumber: { type: String, required: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    driverName: { type: String, required: true },
    type: { type: String, enum: DRIVER_PAYMENT_TYPES, required: true },
    amountPaise: { type: Number, required: true, min: 0 },
    paymentDate: { type: Date, required: true },
    paymentMode: { type: String, enum: PAYMENT_MODES, required: true },
    reference: { type: String, trim: true, maxlength: 60 },
    paidById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    paidByName: { type: String, required: true, trim: true, maxlength: 100 },
    salaryMonth: { type: String, default: null },
    salary: { type: SalarySchema, default: null },
    advanceRecoveryPaise: { type: Number, default: 0, min: 0 },
    expenseIds: { type: [Schema.Types.ObjectId], default: [] },
    notes: { type: String, trim: true, maxlength: 500 },
    slip: { type: FileRefSchema, default: null },
    status: { type: String, enum: DRIVER_PAYMENT_STATUS, default: 'paid' },
    voidReason: { type: String, trim: true, maxlength: 300 },
    voidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    voidedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
DriverPaymentSchema.index({ paymentNumber: 1 }, { unique: true });
DriverPaymentSchema.index({ driverId: 1, paymentDate: -1 });
DriverPaymentSchema.index({ driverId: 1, status: 1, type: 1, salaryMonth: 1 });
DriverPaymentSchema.index({ status: 1, paymentDate: -1 });
DriverPaymentSchema.index({ type: 1, paymentDate: -1 });

export const DriverPayment = model<IDriverPayment>('DriverPayment', DriverPaymentSchema);
