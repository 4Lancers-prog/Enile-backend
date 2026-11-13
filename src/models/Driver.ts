import { Schema, model, type Types } from 'mongoose';
import { DRIVER_STATUS } from '../config/constants';

export interface IDriver {
  _id: Types.ObjectId;
  name: string;
  normalizedName: string;
  phone: string;
  normalizedPhone: string;
  licenceNumber: string;
  normalizedLicence: string;
  licenceClass?: string;
  licenceExpiry: Date; // gap 2: now feeds the renewal scheduler
  hazardousEndorsement: boolean;
  hazchemTrainingExpiry?: Date | null;
  status: (typeof DRIVER_STATUS)[number];
  emergencyContact?: { name?: string; phone?: string };
  notes?: string;
  /** Employment and payroll details (driver payments module). */
  employeeCode?: string;
  joiningDate?: Date | null;
  monthlySalaryPaise?: number;
  tripAllowancePaise?: number; // paid per delivered trip, added to salary
  salaryDay?: number; // day of the month salary falls due (1-28)
  advanceRecoveryPaise?: number; // default monthly recovery from salary while an advance is outstanding
  bank?: { accountName?: string; accountNumber?: string; ifsc?: string; bankName?: string };
  upiId?: string;
  pan?: string;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DriverSchema = new Schema<IDriver>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    normalizedName: { type: String, required: true },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    normalizedPhone: { type: String, required: true },
    licenceNumber: { type: String, required: true, trim: true, maxlength: 30 },
    normalizedLicence: { type: String, required: true },
    licenceClass: { type: String, trim: true, maxlength: 30 },
    licenceExpiry: { type: Date, required: true },
    hazardousEndorsement: { type: Boolean, default: false },
    hazchemTrainingExpiry: { type: Date, default: null },
    status: { type: String, enum: DRIVER_STATUS, default: 'active' },
    emergencyContact: {
      name: { type: String, trim: true, maxlength: 100 },
      phone: { type: String, trim: true, maxlength: 20 },
    },
    notes: { type: String, trim: true, maxlength: 1000 },
    employeeCode: { type: String, trim: true, maxlength: 20 },
    joiningDate: { type: Date, default: null },
    monthlySalaryPaise: { type: Number, default: 0, min: 0 },
    tripAllowancePaise: { type: Number, default: 0, min: 0 },
    salaryDay: { type: Number, default: 7, min: 1, max: 28 },
    advanceRecoveryPaise: { type: Number, default: 0, min: 0 },
    bank: {
      accountName: { type: String, trim: true, maxlength: 100 },
      accountNumber: { type: String, trim: true, maxlength: 20 },
      ifsc: { type: String, trim: true, uppercase: true, maxlength: 11 },
      bankName: { type: String, trim: true, maxlength: 80 },
    },
    upiId: { type: String, trim: true, maxlength: 60 },
    pan: { type: String, trim: true, uppercase: true, maxlength: 10 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, optimisticConcurrency: true },
);
DriverSchema.index({ normalizedLicence: 1 }, { unique: true });
DriverSchema.index({ normalizedPhone: 1 });
DriverSchema.index({ employeeCode: 1 }, { unique: true, partialFilterExpression: { employeeCode: { $type: 'string' } } });
DriverSchema.index({ status: 1, normalizedName: 1 });
DriverSchema.index({ licenceExpiry: 1, status: 1 });
DriverSchema.index({ hazchemTrainingExpiry: 1, status: 1 });

export const Driver = model<IDriver>('Driver', DriverSchema);
