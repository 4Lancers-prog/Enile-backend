import { Schema, model, type Types } from 'mongoose';
import {
  JOB_STATUS,
  JOB_TYPES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUS,
  RENEWAL_STATUS,
  RENEWAL_SUBJECTS,
} from '../config/constants';

/** Renewal reminder jobs: one per subject + due date + reminder window (manual 6). */
export interface IRenewalJob {
  _id: Types.ObjectId;
  subjectType: (typeof RENEWAL_SUBJECTS)[number];
  subjectId: Types.ObjectId; // documents._id or drivers._id
  ownerLabel: string; // e.g. "MH12AB1234 · INSURANCE"
  dueDate: Date;
  reminderType: string; // D30, D15, D7, D1, D0, OVERDUE
  scheduledAt: Date;
  status: (typeof RENEWAL_STATUS)[number];
  attempts: number;
  lastError?: string | null;
  idempotencyKey: string;
  leaseUntil?: Date | null;
  dispatchedAt?: Date | null;
  createdAt: Date;
}
const RenewalJobSchema = new Schema<IRenewalJob>(
  {
    subjectType: { type: String, enum: RENEWAL_SUBJECTS, required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    ownerLabel: { type: String, required: true },
    dueDate: { type: Date, required: true },
    reminderType: { type: String, required: true },
    scheduledAt: { type: Date, required: true },
    status: { type: String, enum: RENEWAL_STATUS, default: 'queued' },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    idempotencyKey: { type: String, required: true },
    leaseUntil: { type: Date, default: null },
    dispatchedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
RenewalJobSchema.index({ idempotencyKey: 1 }, { unique: true });
RenewalJobSchema.index({ status: 1, scheduledAt: 1 });
RenewalJobSchema.index({ subjectId: 1, dueDate: 1 });
RenewalJobSchema.index({ scheduledAt: -1 });
export const RenewalJob = model<IRenewalJob>('RenewalJob', RenewalJobSchema);

/** Outgoing notifications with retry / dead-letter tracking. Email is the v1 channel. */
export interface INotification {
  _id: Types.ObjectId;
  recipientId: Types.ObjectId;
  channel: (typeof NOTIFICATION_CHANNELS)[number];
  templateKey: string;
  title: string;
  body: string;
  link?: string;
  status: (typeof NOTIFICATION_STATUS)[number];
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil?: Date | null;
  providerMessageId?: string | null;
  lastError?: string | null;
  idempotencyKey: string;
  readAt?: Date | null;
  sentAt?: Date | null;
  createdAt: Date;
}
const NotificationSchema = new Schema<INotification>(
  {
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },
    templateKey: { type: String, required: true },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 2000 },
    link: { type: String, maxlength: 300 },
    status: { type: String, enum: NOTIFICATION_STATUS, default: 'queued' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    leaseUntil: { type: Date, default: null },
    providerMessageId: { type: String, default: null },
    lastError: { type: String, default: null },
    idempotencyKey: { type: String, required: true },
    readAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
NotificationSchema.index({ idempotencyKey: 1 }, { unique: true });
NotificationSchema.index({ status: 1, nextAttemptAt: 1 });
NotificationSchema.index({ recipientId: 1, channel: 1, createdAt: -1 });
export const Notification = model<INotification>('Notification', NotificationSchema);

/** Generic background jobs: quotation PDFs and exports. */
export interface IJob {
  _id: Types.ObjectId;
  type: (typeof JOB_TYPES)[number];
  payload: Record<string, unknown>;
  status: (typeof JOB_STATUS)[number];
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  leaseUntil?: Date | null;
  lastError?: string | null;
  result?: { storageKey?: string; fileName?: string; mimeType?: string; rows?: number } | null;
  requestId?: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
const JobSchema = new Schema<IJob>(
  {
    type: { type: String, enum: JOB_TYPES, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: JOB_STATUS, default: 'queued' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    leaseUntil: { type: Date, default: null },
    lastError: { type: String, default: null },
    result: { type: Schema.Types.Mixed, default: null },
    requestId: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
JobSchema.index({ status: 1, nextAttemptAt: 1 });
JobSchema.index({ type: 1, createdBy: 1, createdAt: -1 });
export const Job = model<IJob>('Job', JobSchema);
