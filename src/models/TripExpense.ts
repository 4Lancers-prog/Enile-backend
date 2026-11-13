import { Schema, model, type Types } from 'mongoose';
import { EXPENSE_CATEGORIES, EXPENSE_PAID_BY, EXPENSE_STATUS, PAYMENT_MODES } from '../config/constants';
import { FileRefSchema, type FileRef } from './shared';

/**
 * A cost incurred on a trip (fuel, tolls, allowances). Vehicle and driver are
 * copied from the trip, so reports can group by them without a join. A
 * driver-paid expense, once approved, is owed back to the driver until a
 * reimbursement payment settles it.
 */
export interface ITripExpense {
  _id: Types.ObjectId;
  tripId: Types.ObjectId;
  tripNumber: string;
  vehicleId: Types.ObjectId;
  driverId: Types.ObjectId;
  category: (typeof EXPENSE_CATEGORIES)[number];
  amountPaise: number;
  expenseDate: Date;
  paidBy: (typeof EXPENSE_PAID_BY)[number];
  paymentMode: (typeof PAYMENT_MODES)[number] | 'card' | 'fuel_card' | 'fastag';
  vendor?: string;
  billNumber?: string;
  litres?: number | null;
  ratePaise?: number | null;
  odometerKm?: number | null;
  notes?: string;
  receipt?: FileRef | null;
  status: (typeof EXPENSE_STATUS)[number];
  decidedBy?: Types.ObjectId | null;
  decidedAt?: Date | null;
  rejectReason?: string;
  reimbursedPaymentId?: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export const EXPENSE_PAYMENT_MODES = ['cash', 'upi', 'card', 'bank_transfer', 'fuel_card', 'fastag', 'cheque'] as const;

const TripExpenseSchema = new Schema<ITripExpense>(
  {
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true },
    tripNumber: { type: String, required: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    expenseDate: { type: Date, required: true },
    paidBy: { type: String, enum: EXPENSE_PAID_BY, required: true },
    paymentMode: { type: String, enum: EXPENSE_PAYMENT_MODES, required: true },
    vendor: { type: String, trim: true, maxlength: 120 },
    billNumber: { type: String, trim: true, maxlength: 60 },
    litres: { type: Number, default: null },
    ratePaise: { type: Number, default: null },
    odometerKm: { type: Number, default: null },
    notes: { type: String, trim: true, maxlength: 500 },
    receipt: { type: FileRefSchema, default: null },
    status: { type: String, enum: EXPENSE_STATUS, default: 'pending' },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    rejectReason: { type: String, trim: true, maxlength: 300 },
    reimbursedPaymentId: { type: Schema.Types.ObjectId, ref: 'DriverPayment', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, optimisticConcurrency: true },
);
TripExpenseSchema.index({ tripId: 1, expenseDate: 1 });
TripExpenseSchema.index({ status: 1, expenseDate: -1 });
TripExpenseSchema.index({ driverId: 1, paidBy: 1, status: 1, reimbursedPaymentId: 1 });
TripExpenseSchema.index({ vehicleId: 1, expenseDate: -1 });
TripExpenseSchema.index({ expenseDate: -1 });

export const TripExpense = model<ITripExpense>('TripExpense', TripExpenseSchema);
