import type { Types } from 'mongoose';
import { ComplianceDocument } from '../models/Document';
import type { IDriver } from '../models/Driver';
import type { AppSettings } from '../models/SystemSetting';
import { diffDaysYmd, ymdInTz } from '../lib/time';

export type ExpiryState = 'no_expiry' | 'valid' | 'expiring' | 'expired';
export const EXPIRING_WINDOW_DAYS = 30;

export function expiryState(expiry: Date | null | undefined, timeZone: string, now = new Date()): { state: ExpiryState; daysLeft: number | null } {
  if (!expiry) return { state: 'no_expiry', daysLeft: null };
  const daysLeft = diffDaysYmd(ymdInTz(now, timeZone), ymdInTz(expiry, timeZone));
  if (daysLeft < 0) return { state: 'expired', daysLeft };
  if (daysLeft <= EXPIRING_WINDOW_DAYS) return { state: 'expiring', daysLeft };
  return { state: 'valid', daysLeft };
}

/**
 * Which mandatory documents block dispatch is a business decision (manual 13);
 * the list comes from settings.compliance.blockingVehicleDocTypes.
 * A document counts as valid when it is active and expires on/after the trip end date.
 */
export async function vehicleComplianceIssues(vehicleId: Types.ObjectId | string, until: Date, settings: AppSettings): Promise<string[]> {
  return (await vehicleComplianceIssuesBulk([vehicleId], until, settings)).get(String(vehicleId)) ?? [];
}

/** Same rule for many vehicles with ONE query, used by the trip planner's availability list. */
export async function vehicleComplianceIssuesBulk(vehicleIds: (Types.ObjectId | string)[], until: Date, settings: AppSettings): Promise<Map<string, string[]>> {
  const types = settings.compliance.blockingVehicleDocTypes;
  const out = new Map<string, string[]>();
  if (!types.length || !vehicleIds.length) return out;
  const docs = await ComplianceDocument.find({ ownerType: 'vehicle', ownerId: { $in: vehicleIds }, status: 'active', documentType: { $in: types } })
    .select('ownerId documentType expiryDate')
    .lean();
  const tz = settings.timezone;
  const untilYmd = ymdInTz(until, tz);
  for (const id of vehicleIds) {
    const own = docs.filter((d) => String(d.ownerId) === String(id));
    const issues: string[] = [];
    for (const type of types) {
      const candidates = own.filter((d) => d.documentType === type);
      if (!candidates.length) {
        issues.push(`${type} document is missing`);
        continue;
      }
      const valid = candidates.some((d) => !d.expiryDate || diffDaysYmd(untilYmd, ymdInTz(d.expiryDate, tz)) >= 0);
      if (!valid) {
        const latest = candidates.map((d) => d.expiryDate!).sort((a, b) => b.getTime() - a.getTime())[0];
        issues.push(`${type} expires/expired on ${ymdInTz(latest, tz)}`);
      }
    }
    out.set(String(id), issues);
  }
  return out;
}

export function driverComplianceIssues(
  driver: Pick<IDriver, 'licenceExpiry' | 'hazardousEndorsement' | 'hazchemTrainingExpiry' | 'status' | 'name'>,
  until: Date,
  settings: AppSettings,
): string[] {
  const tz = settings.timezone;
  const untilYmd = ymdInTz(until, tz);
  const issues: string[] = [];
  if (settings.compliance.blockOnDriverLicenceExpiry && diffDaysYmd(untilYmd, ymdInTz(driver.licenceExpiry, tz)) < 0) {
    issues.push(`Driver licence expires/expired on ${ymdInTz(driver.licenceExpiry, tz)}`);
  }
  if (settings.compliance.requireHazchemTraining) {
    if (!driver.hazardousEndorsement) issues.push('Driver has no hazardous-goods endorsement');
    if (!driver.hazchemTrainingExpiry) issues.push('Driver Hazchem training record is missing');
    else if (diffDaysYmd(untilYmd, ymdInTz(driver.hazchemTrainingExpiry, tz)) < 0) {
      issues.push(`Driver Hazchem training expires/expired on ${ymdInTz(driver.hazchemTrainingExpiry, tz)}`);
    }
  }
  return issues;
}
