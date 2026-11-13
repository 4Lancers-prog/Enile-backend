import type { Model } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { newStorageKey, storage } from '../lib/storage';
import { diffDaysYmd, todayYmd, ymdInTz } from '../lib/time';
import { ComplianceDocument } from '../models/Document';
import { Driver } from '../models/Driver';
import { Job, Notification, RenewalJob, type IJob, type INotification, type IRenewalJob } from '../models/Jobs';
import { Quotation } from '../models/Quotation';
import { User } from '../models/User';
import { backoffMs } from '../services/jobs.service';
import { getSettings } from '../services/settings.service';
import { buildExport } from './exporter';
import { PermanentSendError, sendEmail } from './mailer';
import { renderQuotationPdf } from './pdf';

const LEASE_MS = 2 * 60_000;

/**
 * Claims one job atomically. A job is claimable when it is queued and due, or
 * when a previous worker's lease expired (crashed mid-run).
 */
async function claim<T>(model: Model<T>, dueField: 'nextAttemptAt' | 'scheduledAt'): Promise<(T & { _id: unknown; attempts: number }) | null> {
  const now = new Date();
  return (await model
    .findOneAndUpdate(
      {
        $or: [
          { status: 'queued', [dueField]: { $lte: now } },
          { status: 'processing', leaseUntil: { $lt: now } },
        ],
      },
      { $set: { status: 'processing', leaseUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
      { sort: { [dueField]: 1 }, new: true },
    )
    .lean()) as (T & { _id: unknown; attempts: number }) | null;
}

/** Re-queue with backoff, or dead-letter after the configured attempts. */
async function fail<T>(model: Model<T>, id: unknown, attempts: number, max: number, err: unknown, dueField: 'nextAttemptAt' | 'scheduledAt', permanent = false) {
  const message = (err as Error)?.message?.slice(0, 500) ?? 'unknown error';
  const dead = permanent || attempts >= max;
  await model.updateOne(
    { _id: id },
    {
      $set: dead
        ? { status: 'dead', lastError: message, leaseUntil: null }
        : { status: 'queued', lastError: message, leaseUntil: null, [dueField]: new Date(Date.now() + backoffMs(attempts)) },
    },
  );
  logger[dead ? 'error' : 'warn']({ id, attempts, err: message }, dead ? 'job dead-lettered' : 'job will retry');
}

/** Fans a renewal reminder out into one notification per recipient and channel. */
export async function processRenewalJob(): Promise<boolean> {
  const job = await claim<IRenewalJob>(RenewalJob, 'scheduledAt');
  if (!job) return false;
  const settings = await getSettings();
  try {
    // Skip reminders whose subject was renewed/replaced since the job was created.
    const stillDue =
      job.subjectType === 'document'
        ? await ComplianceDocument.exists({ _id: job.subjectId, status: 'active', expiryDate: job.dueDate })
        : await Driver.exists({ _id: job.subjectId, status: 'active', [job.subjectType === 'driver_licence' ? 'licenceExpiry' : 'hazchemTrainingExpiry']: job.dueDate });
    if (!stillDue) {
      await RenewalJob.updateOne({ _id: job._id }, { $set: { status: 'skipped', leaseUntil: null } });
      return true;
    }
    const recipients = await User.find({ status: 'active', role: { $in: settings.reminders.recipientRoles } }).select('_id').lean();
    const tz = settings.timezone;
    const due = ymdInTz(job.dueDate, tz);
    const days = diffDaysYmd(todayYmd(tz), due);
    const title = days < 0 ? `⚠️ ${job.ownerLabel} expired on ${due}` : days === 0 ? `⏰ ${job.ownerLabel} expires today` : `🔔 ${job.ownerLabel} expires in ${days} day${days === 1 ? '' : 's'}`;
    const body = `${job.ownerLabel} ${days < 0 ? 'expired' : 'expires'} on ${due}. Please renew it and upload the new document in Enile CRM.`;
    for (const r of recipients) {
      for (const channel of settings.reminders.channels) {
        await Notification.updateOne(
          { idempotencyKey: `${job.idempotencyKey}:${r._id}:${channel}` },
          {
            $setOnInsert: {
              recipientId: r._id,
              channel,
              templateKey: 'renewal_reminder',
              title,
              body,
              link: '/renewals',
              // In-app notifications are delivered by being stored.
              status: channel === 'in_app' ? 'delivered' : 'queued',
              sentAt: channel === 'in_app' ? new Date() : null,
              nextAttemptAt: new Date(),
              attempts: 0,
            },
          },
          { upsert: true },
        );
      }
    }
    await RenewalJob.updateOne({ _id: job._id }, { $set: { status: 'dispatched', dispatchedAt: new Date(), leaseUntil: null, lastError: null } });
  } catch (err) {
    await fail(RenewalJob, job._id, job.attempts, settings.reminders.maxAttempts, err, 'scheduledAt');
  }
  return true;
}

/** Sends one email notification. "sent" = accepted by the provider, not proof of delivery. */
export async function processNotification(): Promise<boolean> {
  const n = await claim<INotification>(Notification, 'nextAttemptAt');
  if (!n) return false;
  const settings = await getSettings();
  try {
    const user = await User.findById(n.recipientId).select('email status').lean();
    if (!user || user.status !== 'active') throw new PermanentSendError('Recipient missing or disabled');
    const providerMessageId = await sendEmail(user.email, n.title, `${n.body}\n\nOpen: ${env.APP_BASE_URL}${n.link ?? ''}`);
    await Notification.updateOne({ _id: n._id }, { $set: { status: 'sent', sentAt: new Date(), providerMessageId, leaseUntil: null, lastError: null } });
  } catch (err) {
    await fail(Notification, n._id, n.attempts, settings.reminders.maxAttempts, err, 'nextAttemptAt', err instanceof PermanentSendError);
  }
  return true;
}

/** Quotation PDFs and exports. */
export async function processJob(): Promise<boolean> {
  const job = await claim<IJob>(Job, 'nextAttemptAt');
  if (!job) return false;
  const settings = await getSettings();
  try {
    if (job.type === 'quotation_pdf') {
      const q = await Quotation.findById(job.payload.quotationId).lean();
      if (!q) throw new Error('Quotation not found');
      const buffer = await renderQuotationPdf(q, settings);
      const key = newStorageKey('quotations', 'pdf');
      await storage.put(key, buffer);
      await Quotation.updateOne({ _id: q._id }, { $set: { pdf: { status: 'ready', storageKey: key, generatedAt: new Date(), error: null } } });
      await Job.updateOne({ _id: job._id }, { $set: { status: 'done', result: { storageKey: key, mimeType: 'application/pdf' }, leaseUntil: null } });
    } else if (job.type === 'export') {
      const p = job.payload as { type: string; format: 'csv' | 'xlsx'; from?: string; to?: string };
      const { buffer, rows } = await buildExport(p, settings.timezone);
      const key = newStorageKey('exports', p.format);
      await storage.put(key, buffer);
      const fileName = `enile-${p.type}-${p.from ?? 'all'}-${p.to ?? todayYmd(settings.timezone)}.${p.format}`;
      const mimeType = p.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      await Job.updateOne({ _id: job._id }, { $set: { status: 'done', result: { storageKey: key, fileName, mimeType, rows }, leaseUntil: null } });
    }
  } catch (err) {
    await fail(Job, job._id, job.attempts, job.maxAttempts, err, 'nextAttemptAt');
    if (job.type === 'quotation_pdf' && job.attempts >= job.maxAttempts) {
      await Quotation.updateOne({ _id: job.payload.quotationId }, { $set: { 'pdf.status': 'failed', 'pdf.error': (err as Error).message?.slice(0, 200) } });
    }
  }
  return true;
}
