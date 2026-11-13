import { z } from 'zod';
import { NOTIFICATION_CHANNELS, ROLES, VEHICLE_DOCUMENT_TYPES } from '../../config/constants';

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const settingsBody = z
  .object({
    version: z.number().int().min(0),
    value: z
      .object({
        timezone: z.string().refine(isTimeZone, 'Unknown timezone.'),
        business: z
          .object({
            name: z.string().trim().min(1).max(160),
            gstin: z.string().trim().max(15),
            homeStateCode: z.string().regex(/^\d{2}$/),
            address: z.string().trim().max(400),
            phone: z.string().trim().max(20),
            email: z.string().trim().max(254),
          })
          .strict(),
        tax: z
          .object({
            defaultRateBps: z.number().int().min(0).max(2800),
            allowedRatesBps: z.array(z.number().int().min(0).max(2800)).min(1).max(10),
            roundOffTotal: z.boolean(),
            configVersion: z.number().int().min(1),
          })
          .strict()
          .refine((t) => t.allowedRatesBps.includes(t.defaultRateBps), { message: 'Default rate must be one of the allowed rates.', path: ['defaultRateBps'] }),
        quotation: z
          .object({ numberPrefix: z.string().regex(/^[A-Z0-9/-]{2,20}$/), validityDays: z.number().int().min(1).max(90), defaultTerms: z.string().max(4000) })
          .strict(),
        trip: z
          .object({
            numberPrefix: z.string().regex(/^[A-Z0-9/-]{2,20}$/),
            driverOverlapCheck: z.boolean(),
            maxDurationHours: z.number().int().min(1).max(720),
            shortageTolerancePercent: z.number().min(0).max(5),
            requireSealsOnDispatch: z.boolean(),
            requireProofOfDelivery: z.boolean(),
          })
          .strict(),
        compliance: z
          .object({
            blockingVehicleDocTypes: z.array(z.enum(VEHICLE_DOCUMENT_TYPES)).max(VEHICLE_DOCUMENT_TYPES.length),
            blockOnDriverLicenceExpiry: z.boolean(),
            requireHazchemTraining: z.boolean(),
            allowOverride: z.boolean(),
          })
          .strict(),
        reminders: z
          .object({
            windowsDays: z.array(z.number().int().min(0).max(180)).min(1).max(10),
            overdueRepeatDays: z.number().int().min(1).max(60),
            recipientRoles: z.array(z.enum(ROLES)).min(1),
            channels: z.array(z.enum(NOTIFICATION_CHANNELS)).min(1),
            maxAttempts: z.number().int().min(1).max(10),
          })
          .strict(),
        reports: z.object({ maxRangeDays: z.number().int().min(1).max(366) }).strict(),
      })
      .strict(),
  })
  .strict();
