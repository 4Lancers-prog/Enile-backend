import { Schema, model, type Types } from 'mongoose';

/**
 * Section 13 open decisions live here as configurable settings with sensible
 * defaults, so Enile can change them without a code release. Changes are audited.
 */
export interface AppSettings {
  timezone: string;
  business: {
    name: string;
    gstin: string;
    homeStateCode: string; // decides CGST+SGST vs IGST
    address: string;
    phone: string;
    email: string;
  };
  tax: {
    defaultRateBps: number;
    allowedRatesBps: number[];
    roundOffTotal: boolean;
    configVersion: number;
  };
  quotation: {
    numberPrefix: string;
    validityDays: number;
    defaultTerms: string;
  };
  trip: {
    numberPrefix: string;
    driverOverlapCheck: boolean;
    maxDurationHours: number;
    shortageTolerancePercent: number;
    requireSealsOnDispatch: boolean;
    requireProofOfDelivery: boolean;
  };
  compliance: {
    blockingVehicleDocTypes: string[];
    blockOnDriverLicenceExpiry: boolean;
    requireHazchemTraining: boolean;
    allowOverride: boolean;
  };
  reminders: {
    windowsDays: number[];
    overdueRepeatDays: number;
    recipientRoles: string[];
    channels: ('email' | 'in_app')[];
    maxAttempts: number;
  };
  reports: { maxRangeDays: number };
}

export const DEFAULT_SETTINGS: AppSettings = {
  timezone: 'Asia/Kolkata',
  business: {
    name: 'Enile Petroleum Transport',
    gstin: '',
    homeStateCode: '27',
    address: '',
    phone: '',
    email: '',
  },
  tax: { defaultRateBps: 1200, allowedRatesBps: [0, 500, 1200, 1800], roundOffTotal: true, configVersion: 1 },
  quotation: {
    numberPrefix: 'ENL/QT',
    validityDays: 15,
    defaultTerms:
      'Rates are per the scope above. Detention beyond 24 hours is charged extra. GST as applicable. Subject to confirmation by Enile.',
  },
  trip: {
    numberPrefix: 'ENL/TRP',
    driverOverlapCheck: true,
    maxDurationHours: 168,
    shortageTolerancePercent: 0.5,
    requireSealsOnDispatch: true,
    requireProofOfDelivery: false,
  },
  compliance: {
    blockingVehicleDocTypes: ['RC', 'INSURANCE', 'FITNESS', 'PUC', 'PESO_LICENCE', 'CALIBRATION_CERT'],
    blockOnDriverLicenceExpiry: true,
    requireHazchemTraining: true,
    allowOverride: true,
  },
  reminders: {
    windowsDays: [30, 15, 7, 1, 0],
    overdueRepeatDays: 7,
    recipientRoles: ['admin', 'manager', 'operations'],
    channels: ['email', 'in_app'],
    maxAttempts: 5,
  },
  reports: { maxRangeDays: 92 },
};

interface ISystemSetting {
  _id: string;
  value: AppSettings;
  updatedBy?: Types.ObjectId;
  updatedAt: Date;
}

const SystemSettingSchema = new Schema<ISystemSetting>(
  {
    _id: { type: String, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: false, updatedAt: true }, optimisticConcurrency: true },
);

export const SystemSetting = model<ISystemSetting>('SystemSetting', SystemSettingSchema);
