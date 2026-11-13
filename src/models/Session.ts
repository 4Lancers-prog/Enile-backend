import { Schema, model, type Types } from 'mongoose';

/**
 * Refresh-token sessions. Only a SHA-256 hash of the token is stored. Tokens rotate
 * on every refresh; presenting an already-rotated token revokes the whole family
 * (refresh-token reuse detection).
 */
export interface ISession {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  family: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  replacedByHash?: string | null;
  userAgent?: string;
  ip?: string;
  createdAt: Date;
}
const SessionSchema = new Schema<ISession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    family: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: null },
    userAgent: { type: String, maxlength: 300 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
SessionSchema.index({ tokenHash: 1 }, { unique: true });
SessionSchema.index({ userId: 1, revokedAt: 1 });
SessionSchema.index({ family: 1 });
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Session = model<ISession>('Session', SessionSchema);
