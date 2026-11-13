import { z } from 'zod';
import { DRIVER_PAYMENT_STATUS, DRIVER_PAYMENT_TYPES, PAYMENT_MODES } from '../../config/constants';
import { paginationQuery } from '../../lib/pagination';
import { objectId, optionalText, paise, requiredText, ym, ymd } from '../../lib/schemas';

export const createPaymentBody = z
  .object({
    driverId: objectId,
    type: z.enum(DRIVER_PAYMENT_TYPES),
    amountPaise: paise,
    paymentDate: ymd,
    paymentMode: z.enum(PAYMENT_MODES),
    reference: optionalText(60),
    paidByName: optionalText(100),
    notes: optionalText(500),
    salaryMonth: ym.optional(),
    leaveDays: z.coerce.number().int().min(0).max(31).optional(),
    otherDeductionsPaise: paise.optional(),
    advanceRecoveryPaise: paise.optional(),
    expenseIds: z.array(objectId).max(200).optional(),
  })
  .strict()
  .refine((v) => v.type !== 'salary' || !!v.salaryMonth, { message: 'Pick the month this salary is for.', path: ['salaryMonth'] })
  .refine((v) => v.paymentMode === 'cash' || !!v.reference, { message: 'Enter the UTR, UPI or cheque reference.', path: ['reference'] })
  .refine((v) => v.type === 'salary' || v.amountPaise > 0, { message: 'Enter an amount above zero.', path: ['amountPaise'] });

const filters = {
  driverId: objectId.optional(),
  type: z.enum(DRIVER_PAYMENT_TYPES).optional(),
  paymentMode: z.enum(PAYMENT_MODES).optional(),
  status: z.enum(DRIVER_PAYMENT_STATUS).optional(),
  salaryMonth: ym.optional(),
  from: ymd.optional(),
  to: ymd.optional(),
};
export const listPaymentsQuery = z.object({ ...paginationQuery, ...filters });
export const exportPaymentsQuery = z.object({ ...filters, format: z.enum(['csv', 'xlsx']).default('csv') });
export const voidBody = z.object({ reason: requiredText(300, 'Reason') }).strict();
export const monthQuery = z.object({ month: ym.optional() });
export const previewQuery = z.object({
  month: ym,
  leaveDays: z.coerce.number().int().min(0).max(31).optional(),
  otherDeductionsPaise: paise.optional(),
  advanceRecoveryPaise: paise.optional(),
});
export const driverParams = z.object({ driverId: objectId });

/** Pay details payroll staff can change without full driver-edit rights. */
export const payDetailsBody = z
  .object({
    version: z.coerce.number().int().min(0),
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
  })
  .strict();
