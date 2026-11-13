import { Schema, model } from 'mongoose';

/**
 * Short-lived resource locks. Used to serialize vehicle/driver assignment so two
 * concurrent trip requests can never both pass the overlap check (manual 4.6, 11).
 * The TTL index cleans up locks left behind by a crashed process.
 */
interface ILock {
  _id: string;
  owner: string;
  expiresAt: Date;
}
const LockSchema = new Schema<ILock>({
  _id: { type: String, required: true },
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });
LockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Lock = model<ILock>('Lock', LockSchema);
