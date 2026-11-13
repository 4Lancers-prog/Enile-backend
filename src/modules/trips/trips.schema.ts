import { z } from 'zod';
import { PRODUCTS, TRIP_STATUS } from '../../config/constants';
import { paginationQuery } from '../../lib/pagination';
import { isoDateTime, objectId, optionalText, requiredText, searchQ, version, ymd } from '../../lib/schemas';

const litres = z.coerce.number().positive('Quantity must be positive.').max(80_000, 'Quantity looks too large (max 80,000 L).');

const tripFields = {
  companyId: objectId,
  quotationId: objectId.nullable().optional(),
  vehicleId: objectId,
  driverId: objectId,
  product: z.enum(PRODUCTS),
  plannedQuantityLitres: litres,
  loadingPoint: requiredText(200, 'Loading point'),
  unloadingPoint: requiredText(200, 'Unloading point'),
  plannedStart: isoDateTime,
  plannedEnd: isoDateTime,
  freightPaise: z.number().int().min(0).max(10_000_000_000).optional(),
  notes: optionalText(2000),
  complianceOverrideReason: optionalText(500),
};

const endAfterStart = (v: { plannedStart?: Date; plannedEnd?: Date }) => !v.plannedStart || !v.plannedEnd || v.plannedEnd > v.plannedStart;
const endMsg = { message: 'Planned end must be after planned start.', path: ['plannedEnd'] };

export const createTripBody = z.object(tripFields).strict().refine(endAfterStart, endMsg);
export type CreateTripInput = z.infer<typeof createTripBody>;
export const updateTripBody = z.object(tripFields).partial().extend({ version }).strict().refine(endAfterStart, endMsg);

export const dispatchBody = z
  .object({
    version,
    invoiceNumber: requiredText(60, 'Invoice / challan number'),
    dispatchedQuantityLitres: litres,
    seals: z
      .array(z.object({ compartment: z.coerce.number().int().min(1).max(12), sealNumber: requiredText(40, 'Seal number') }).strict())
      .max(24)
      .default([]),
    densityKgM3: z.coerce.number().min(600).max(1100).optional(),
    temperatureC: z.coerce.number().min(-20).max(80).optional(),
    odometerStart: z.coerce.number().int().min(0).max(9_999_999).optional(),
    complianceOverrideReason: optionalText(500),
  })
  .strict();

/** Multipart fields (proof file optional) arrive as strings. */
export const deliverBody = z
  .object({
    version: z.coerce.number().int().min(0),
    receivedQuantityLitres: litres,
    receiverName: optionalText(100),
    sealsIntact: z.enum(['true', 'false']).transform((v) => v === 'true'),
    odometerEnd: z.coerce.number().int().min(0).max(9_999_999).optional(),
    remarks: optionalText(1000),
  })
  .strict();

export const cancelBody = z.object({ version, reason: requiredText(500, 'Reason') }).strict();

export const correctBody = z
  .object({
    version,
    reason: requiredText(500, 'Reason for correction'),
    receivedQuantityLitres: litres.optional(),
    receiverName: optionalText(100),
    sealsIntact: z.boolean().optional(),
    remarks: optionalText(1000),
    revertToInTransit: z.boolean().optional(),
  })
  .strict();

export const listTripsQuery = z.object({
  ...paginationQuery,
  q: searchQ,
  status: z.enum(TRIP_STATUS).optional(),
  vehicleId: objectId.optional(),
  driverId: objectId.optional(),
  companyId: objectId.optional(),
  from: ymd.optional(),
  to: ymd.optional(),
});

export const prefillQuery = z
  .object({ companyId: objectId.optional(), quotationId: objectId.optional(), vehicleId: objectId.optional() })
  .strict();

export const planningOptionsQuery = z
  .object({ start: z.coerce.date(), end: z.coerce.date(), excludeTripId: objectId.optional() })
  .strict()
  .refine((v) => v.end > v.start, { message: 'End must be after start.', path: ['end'] });
