import { z } from 'zod';
import { OWNERSHIP, VEHICLE_STATUS, VEHICLE_TYPES } from '../../config/constants';
import { paginationQuery } from '../../lib/pagination';
import { objectId, optionalText, requiredText, searchQ, version } from '../../lib/schemas';

const compartment = z.object({ number: z.coerce.number().int().min(1).max(12), capacityLitres: z.coerce.number().int().min(1).max(60_000) }).strict();

const vehicleFields = {
  registrationNumber: requiredText(20, 'Registration number').regex(/^[A-Za-z0-9 -]+$/, 'Use letters, numbers, spaces or hyphens only.'),
  vehicleType: z.enum(VEHICLE_TYPES).default('tanker_truck'),
  make: optionalText(60),
  model: optionalText(60),
  manufactureYear: z.coerce.number().int().min(1980).max(new Date().getFullYear() + 1).optional(),
  capacityLitres: z.coerce.number().int().min(1, 'Capacity must be positive.').max(80_000, 'Capacity looks too large (max 80,000 L).'),
  compartments: z.array(compartment).max(12).default([]),
  ownership: z.enum(OWNERSHIP).default('owned'),
  assignedDriverId: objectId.nullable().optional(),
  notes: optionalText(2000),
};

const compartmentsMatch = (v: { compartments?: { number: number; capacityLitres: number }[]; capacityLitres?: number }) =>
  !v.compartments?.length || v.capacityLitres === undefined || v.compartments.reduce((s, c) => s + c.capacityLitres, 0) === v.capacityLitres;
const compartmentsMsg = { message: 'Compartment capacities must add up to the total capacity.', path: ['compartments'] };

export const createVehicleBody = z.object(vehicleFields).strict().refine(compartmentsMatch, compartmentsMsg);

export const updateVehicleBody = z
  .object(vehicleFields)
  .partial()
  .extend({ version, status: z.enum(VEHICLE_STATUS).optional() })
  .strict()
  .refine(compartmentsMatch, compartmentsMsg);

export const listVehiclesQuery = z.object({
  ...paginationQuery,
  q: searchQ,
  status: z.enum(VEHICLE_STATUS).optional(),
  vehicleType: z.enum(VEHICLE_TYPES).optional(),
});
