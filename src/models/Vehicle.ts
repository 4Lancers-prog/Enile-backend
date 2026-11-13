import { Schema, model, type Types } from 'mongoose';
import { OWNERSHIP, VEHICLE_STATUS, VEHICLE_TYPES } from '../config/constants';

export interface Compartment {
  number: number;
  capacityLitres: number;
}

export interface IVehicle {
  _id: Types.ObjectId;
  registrationNumber: string;
  normalizedRegistration: string;
  vehicleType: (typeof VEHICLE_TYPES)[number];
  make?: string;
  model?: string;
  manufactureYear?: number;
  capacityLitres: number;
  compartments: Compartment[];
  ownership: (typeof OWNERSHIP)[number];
  status: (typeof VEHICLE_STATUS)[number];
  assignedDriverId?: Types.ObjectId | null;
  notes?: string;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const CompartmentSchema = new Schema<Compartment>(
  { number: { type: Number, required: true, min: 1, max: 12 }, capacityLitres: { type: Number, required: true, min: 1, max: 60_000 } },
  { _id: false },
);

const VehicleSchema = new Schema<IVehicle>(
  {
    registrationNumber: { type: String, required: true, trim: true, maxlength: 20 },
    normalizedRegistration: { type: String, required: true },
    vehicleType: { type: String, enum: VEHICLE_TYPES, default: 'tanker_truck' },
    make: { type: String, trim: true, maxlength: 60 },
    model: { type: String, trim: true, maxlength: 60 },
    manufactureYear: { type: Number, min: 1980, max: 2100 },
    capacityLitres: { type: Number, required: true, min: 1, max: 80_000 },
    compartments: { type: [CompartmentSchema], default: [] },
    ownership: { type: String, enum: OWNERSHIP, default: 'owned' },
    status: { type: String, enum: VEHICLE_STATUS, default: 'active' },
    assignedDriverId: { type: Schema.Types.ObjectId, ref: 'Driver', default: null },
    notes: { type: String, trim: true, maxlength: 2000 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, optimisticConcurrency: true },
);
VehicleSchema.index({ normalizedRegistration: 1 }, { unique: true });
VehicleSchema.index({ status: 1, normalizedRegistration: 1 });
VehicleSchema.index({ assignedDriverId: 1 });

export const Vehicle = model<IVehicle>('Vehicle', VehicleSchema);
