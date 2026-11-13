import { Schema, model, type Types } from 'mongoose';
import { PRODUCTS, TRIP_STATUS, type TripStatus } from '../config/constants';

export interface Seal {
  compartment: number;
  sealNumber: string;
}

export interface ITrip {
  _id: Types.ObjectId;
  tripNumber: string;
  companyId: Types.ObjectId;
  quotationId?: Types.ObjectId | null; // gap 4: quoted vs delivered reporting
  vehicleId: Types.ObjectId;
  driverId: Types.ObjectId;
  product: (typeof PRODUCTS)[number];
  plannedQuantityLitres: number;
  loadingPoint: string; // depot / terminal
  unloadingPoint: string; // customer site / outlet
  plannedStart: Date;
  plannedEnd: Date; // gap 5: makes overlap checks computable
  status: TripStatus;
  freightPaise?: number;
  dispatch?: {
    dispatchedAt: Date;
    dispatchedBy: Types.ObjectId;
    invoiceNumber: string; // invoice / challan reference
    dispatchedQuantityLitres: number;
    seals: Seal[];
    densityKgM3?: number;
    temperatureC?: number;
    odometerStart?: number;
  } | null;
  delivery?: {
    deliveredAt: Date;
    deliveredBy: Types.ObjectId;
    receivedQuantityLitres: number;
    shortageLitres: number;
    shortagePercent: number;
    withinTolerance: boolean;
    receiverName?: string;
    sealsIntact: boolean;
    proofStorageKey?: string | null;
    proofFileName?: string | null;
    odometerEnd?: number;
    remarks?: string;
  } | null;
  cancellation?: { cancelledAt: Date; cancelledBy: Types.ObjectId; reason: string } | null;
  complianceOverride?: { by: Types.ObjectId; at: Date; reason: string; issues: string[] } | null;
  corrections: { at: Date; by: Types.ObjectId; reason: string; changes: Record<string, unknown> }[];
  notes?: string;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const TripSchema = new Schema<ITrip>(
  {
    tripNumber: { type: String, required: true },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    quotationId: { type: Schema.Types.ObjectId, ref: 'Quotation', default: null },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    product: { type: String, enum: PRODUCTS, required: true },
    plannedQuantityLitres: { type: Number, required: true, min: 1, max: 80_000 },
    loadingPoint: { type: String, required: true, trim: true, maxlength: 200 },
    unloadingPoint: { type: String, required: true, trim: true, maxlength: 200 },
    plannedStart: { type: Date, required: true },
    plannedEnd: { type: Date, required: true },
    status: { type: String, enum: TRIP_STATUS, default: 'planned' },
    freightPaise: { type: Number, min: 0 },
    dispatch: {
      type: new Schema(
        {
          dispatchedAt: Date,
          dispatchedBy: { type: Schema.Types.ObjectId, ref: 'User' },
          invoiceNumber: { type: String, trim: true, maxlength: 60 },
          dispatchedQuantityLitres: Number,
          seals: [{ _id: false, compartment: Number, sealNumber: { type: String, trim: true, maxlength: 40 } }],
          densityKgM3: Number,
          temperatureC: Number,
          odometerStart: Number,
        },
        { _id: false },
      ),
      default: null,
    },
    delivery: {
      type: new Schema(
        {
          deliveredAt: Date,
          deliveredBy: { type: Schema.Types.ObjectId, ref: 'User' },
          receivedQuantityLitres: Number,
          shortageLitres: Number,
          shortagePercent: Number,
          withinTolerance: Boolean,
          receiverName: { type: String, trim: true, maxlength: 100 },
          sealsIntact: Boolean,
          proofStorageKey: { type: String, default: null, select: false },
          proofFileName: { type: String, default: null },
          odometerEnd: Number,
          remarks: { type: String, trim: true, maxlength: 1000 },
        },
        { _id: false },
      ),
      default: null,
    },
    cancellation: {
      type: new Schema({ cancelledAt: Date, cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' }, reason: String }, { _id: false }),
      default: null,
    },
    complianceOverride: {
      type: new Schema({ by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, reason: String, issues: [String] }, { _id: false }),
      default: null,
    },
    corrections: [{ _id: false, at: Date, by: { type: Schema.Types.ObjectId, ref: 'User' }, reason: String, changes: Schema.Types.Mixed }],
    notes: { type: String, trim: true, maxlength: 2000 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, optimisticConcurrency: true },
);
TripSchema.index({ tripNumber: 1 }, { unique: true });
TripSchema.index({ vehicleId: 1, status: 1, plannedStart: 1 });
TripSchema.index({ driverId: 1, status: 1, plannedStart: 1 });
TripSchema.index({ status: 1, plannedStart: -1 });
TripSchema.index({ plannedStart: -1 });
TripSchema.index({ companyId: 1, createdAt: -1 });
TripSchema.index({ quotationId: 1 });
TripSchema.index({ 'delivery.deliveredAt': -1 });

export const Trip = model<ITrip>('Trip', TripSchema);
