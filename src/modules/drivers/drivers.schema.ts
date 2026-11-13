import { z } from 'zod';
import { DRIVER_STATUS } from '../../config/constants';
import { paginationQuery } from '../../lib/pagination';
import { optionalText, paise, phone, requiredText, searchQ, version, ymd } from '../../lib/schemas';

const driverFields = {
  name: requiredText(100, 'Driver name'),
  phone,
  licenceNumber: requiredText(30, 'Licence number'),
  licenceClass: optionalText(30),
  licenceExpiry: ymd,
  hazardousEndorsement: z.boolean().default(false),
  hazchemTrainingExpiry: ymd.nullable().optional(),
  emergencyContact: z.object({ name: optionalText(100), phone: phone.optional().or(z.literal('').transform(() => undefined)) }).strict().optional(),
  notes: optionalText(1000),
  joiningDate: ymd.nullable().optional(),
  monthlySalaryPaise: paise.optional(),
  tripAllowancePaise: paise.optional(),
  salaryDay: z.coerce.number().int().min(1, 'Pick a day from 1 to 28.').max(28, 'Pick a day from 1 to 28.').optional(),
  advanceRecoveryPaise: paise.optional(),
  bank: z
    .object({
      accountName: optionalText(100),
      accountNumber: z.string().trim().regex(/^\d{6,18}$/, 'Account number is 6 to 18 digits.').optional().or(z.literal('').transform(() => undefined)),
      ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC, e.g. SBIN0001234.').optional().or(z.literal('').transform(() => undefined)),
      bankName: optionalText(80),
    })
    .strict()
    .optional(),
  upiId: z.string().trim().regex(/^[\w.-]{2,}@[a-zA-Z]{2,}$/, 'Enter a valid UPI id, e.g. name@okaxis.').optional().or(z.literal('').transform(() => undefined)),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Enter a valid PAN, e.g. ABCDE1234F.').optional().or(z.literal('').transform(() => undefined)),
};

export const createDriverBody = z.object(driverFields).strict();
export const updateDriverBody = z.object(driverFields).partial().extend({ version, status: z.enum(DRIVER_STATUS).optional() }).strict();
export const listDriversQuery = z.object({ ...paginationQuery, q: searchQ, status: z.enum(DRIVER_STATUS).optional() });
