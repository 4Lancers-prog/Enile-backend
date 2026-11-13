import type { AnyBulkWriteOperation } from 'mongoose';
import { logger } from '../lib/logger';
import { addDaysYmd, diffDaysYmd, startOfDayInTz, todayYmd, ymdInTz } from '../lib/time';
import { ComplianceDocument } from '../models/Document';
import { Driver } from '../models/Driver';
import { RenewalJob, type IRenewalJob } from '../models/Jobs';
import { Quotation } from '../models/Quotation';
import { Vehicle } from '../models/Vehicle';
import { getSettings } from '../services/settings.service';

/** Picks the reminder bucket for a subject; null when no reminder is due yet. */
export function reminderTypeFor(daysLeft: number, windows: number[], overdueRepeatDays: number): string | null {
  if (daysLeft < 0) return `OVERDUE${Math.floor((-daysLeft - 1) / overdueRepeatDays)}`;
  const reached = [...windows].sort((a, b) => a - b).find((w) => daysLeft <= w);
  return reached === undefined ? null : `D${reached}`;
}

interface Subject {
  subjectType: IRenewalJob['subjectType'];
  subjectId: IRenewalJob['subjectId'];
  ownerLabel: string;
  expiry: Date;
}

/**
 * Finds upcoming/overdue expiries (vehicle documents, driver documents, driver
 * licence and Hazchem training) and creates one reminder job per window. The
 * deterministic idempotency key means re-running never creates duplicates.
 */
export async function scanRenewals(): Promise<number> {
  const settings = await getSettings();
  const tz = settings.timezone;
  const today = todayYmd(tz);
  const horizon = startOfDayInTz(addDaysYmd(today, Math.max(...settings.reminders.windowsDays) + 1), tz);

  const [docs, drivers] = await Promise.all([
    ComplianceDocument.find({ status: 'active', expiryDate: { $ne: null, $lt: horizon } }).select('ownerType ownerId documentType expiryDate').lean(),
    Driver.find({ status: 'active', $or: [{ licenceExpiry: { $lt: horizon } }, { hazchemTrainingExpiry: { $ne: null, $lt: horizon } }] })
      .select('name licenceExpiry hazchemTrainingExpiry')
      .lean(),
  ]);
  const vehicleIds = docs.filter((d) => d.ownerType === 'vehicle').map((d) => d.ownerId);
  const driverIds = docs.filter((d) => d.ownerType === 'driver').map((d) => d.ownerId);
  const [vehicles, docDrivers] = await Promise.all([
    Vehicle.find({ _id: { $in: vehicleIds }, status: { $ne: 'retired' } }).select('registrationNumber').lean(),
    Driver.find({ _id: { $in: driverIds }, status: { $ne: 'inactive' } }).select('name').lean(),
  ]);
  const labels = new Map<string, string>([
    ...vehicles.map((v) => [String(v._id), v.registrationNumber] as [string, string]),
    ...docDrivers.map((d) => [String(d._id), d.name] as [string, string]),
  ]);

  const subjects: Subject[] = [];
  for (const d of docs) {
    const owner = labels.get(String(d.ownerId));
    if (owner && d.expiryDate) subjects.push({ subjectType: 'document', subjectId: d._id, ownerLabel: `${owner} · ${d.documentType}`, expiry: d.expiryDate });
  }
  for (const dr of drivers) {
    if (dr.licenceExpiry < horizon) subjects.push({ subjectType: 'driver_licence', subjectId: dr._id, ownerLabel: `${dr.name} · Driving licence`, expiry: dr.licenceExpiry });
    if (dr.hazchemTrainingExpiry && dr.hazchemTrainingExpiry < horizon) {
      subjects.push({ subjectType: 'driver_hazchem', subjectId: dr._id, ownerLabel: `${dr.name} · Hazchem training`, expiry: dr.hazchemTrainingExpiry });
    }
  }

  const ops: AnyBulkWriteOperation<IRenewalJob>[] = [];
  for (const s of subjects) {
    const expiryYmd = ymdInTz(s.expiry, tz);
    const type = reminderTypeFor(diffDaysYmd(today, expiryYmd), settings.reminders.windowsDays, settings.reminders.overdueRepeatDays);
    if (!type) continue;
    const idempotencyKey = `${s.subjectType}:${s.subjectId}:${expiryYmd}:${type}`;
    ops.push({
      updateOne: {
        filter: { idempotencyKey },
        update: {
          $setOnInsert: {
            subjectType: s.subjectType,
            subjectId: s.subjectId,
            ownerLabel: s.ownerLabel,
            dueDate: s.expiry,
            reminderType: type,
            scheduledAt: new Date(),
            status: 'queued',
            attempts: 0,
            idempotencyKey,
          },
        },
        upsert: true,
      },
    });
  }
  if (!ops.length) return 0;
  const res = await RenewalJob.bulkWrite(ops, { ordered: false });
  logger.info({ subjects: subjects.length, created: res.upsertedCount }, 'renewal scan complete');
  return res.upsertedCount;
}

/** Marks issued quotations past their validity as expired. */
export async function expireQuotations(): Promise<number> {
  const res = await Quotation.updateMany({ status: 'issued', validUntil: { $lt: new Date() } }, { $set: { status: 'expired' }, $inc: { __v: 1 } });
  if (res.modifiedCount) logger.info({ count: res.modifiedCount }, 'quotations expired');
  return res.modifiedCount;
}
