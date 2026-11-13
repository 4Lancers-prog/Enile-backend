import { Schema, model, type Types } from 'mongoose';

/** Append-only audit trail (manual 7). Update and delete operations are refused at the model layer. */
export interface IAuditLog {
  _id: Types.ObjectId;
  actorId?: Types.ObjectId | null;
  actorName?: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  requestId?: string;
  ip?: string;
  timestamp: Date;
  changedFields?: string[];
  meta?: Record<string, unknown>;
  outcome: 'success' | 'failure';
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: String,
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, default: null },
    requestId: String,
    ip: String,
    timestamp: { type: Date, default: () => new Date() },
    changedFields: [String],
    meta: Schema.Types.Mixed,
    outcome: { type: String, enum: ['success', 'failure'], default: 'success' },
  },
  { versionKey: false },
);
AuditLogSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
AuditLogSchema.index({ actorId: 1, timestamp: -1 });
AuditLogSchema.index({ timestamp: -1 });

const refuse = function () {
  throw new Error('Audit logs are append-only');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne'] as const) {
  AuditLogSchema.pre(op, refuse);
}

export const AuditLog = model<IAuditLog>('AuditLog', AuditLogSchema);
