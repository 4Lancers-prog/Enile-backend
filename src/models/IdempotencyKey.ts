import { Schema, model, type Types } from 'mongoose';

/** Stored responses for retryable operations (manual 5.1, 4.6 offline retry). */
export interface IIdempotencyKey {
  _id: string; // `${actorId}:${route}:${clientKey}`
  actorId: Types.ObjectId;
  route: string;
  requestHash: string;
  state: 'in_progress' | 'completed';
  statusCode?: number;
  responseBody?: unknown;
  createdAt: Date;
  expiresAt: Date;
}
const IdempotencyKeySchema = new Schema<IIdempotencyKey>(
  {
    _id: { type: String, required: true },
    actorId: { type: Schema.Types.ObjectId, required: true },
    route: { type: String, required: true },
    requestHash: { type: String, required: true },
    state: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
    statusCode: Number,
    responseBody: Schema.Types.Mixed,
    createdAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);
// 24h retry window; the audit log keeps the permanent record of the action itself.
IdempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const IdempotencyKey = model<IIdempotencyKey>('IdempotencyKey', IdempotencyKeySchema);
