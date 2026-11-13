import { Schema, model, type Types } from 'mongoose';
import { ROLES, USER_STATUS, type Role } from '../config/constants';

export interface IUser {
  _id: Types.ObjectId;
  name: string;
  email: string; // normalized lower-case
  phone?: string;
  passwordHash: string;
  role: Role;
  status: (typeof USER_STATUS)[number];
  tokenVersion: number;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 20 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: USER_STATUS, default: 'active' },
    tokenVersion: { type: Number, default: 0 },
    mustChangePassword: { type: Boolean, default: false },
    failedLoginCount: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, default: null, select: false },
    lastLoginAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, optimisticConcurrency: true },
);
UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ role: 1, status: 1 });

export const User = model<IUser>('User', UserSchema);
