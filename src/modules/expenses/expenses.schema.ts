import { z } from 'zod';
import { EXPENSE_CATEGORIES, EXPENSE_PAID_BY, EXPENSE_STATUS } from '../../config/constants';
import { paginationQuery } from '../../lib/pagination';
import { objectId, optionalText, positivePaise, requiredText, version, ymd } from '../../lib/schemas';
import { EXPENSE_PAYMENT_MODES } from '../../models/TripExpense';

const fields = {
  category: z.enum(EXPENSE_CATEGORIES),
  amountPaise: positivePaise,
  expenseDate: ymd,
  paidBy: z.enum(EXPENSE_PAID_BY),
  paymentMode: z.enum(EXPENSE_PAYMENT_MODES),
  vendor: optionalText(120),
  billNumber: optionalText(60),
  litres: z.coerce.number().positive('Enter litres above zero.').max(2000, 'Litres look too high for one fill.').nullable().optional(),
  odometerKm: z.coerce.number().int().min(0).max(5_000_000).nullable().optional(),
  notes: optionalText(500),
};
const fuelNeedsLitres = (v: { category?: string; litres?: number | null }) => v.category !== 'fuel' || !!v.litres;
export const createExpenseBody = z
  .object({ tripId: objectId, ...fields })
  .strict()
  .refine(fuelNeedsLitres, { message: 'Enter the litres filled for a fuel bill.', path: ['litres'] });
export const updateExpenseBody = z.object(fields).partial().extend({ version }).strict();
export const listExpensesQuery = z.object({
  ...paginationQuery,
  tripId: objectId.optional(),
  driverId: objectId.optional(),
  vehicleId: objectId.optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  status: z.enum(EXPENSE_STATUS).optional(),
  paidBy: z.enum(EXPENSE_PAID_BY).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
});
export const summaryQuery = z.object({ tripId: objectId.optional(), from: ymd.optional(), to: ymd.optional() });
export const rejectBody = z.object({ reason: requiredText(300, 'Reason'), version }).strict();
export const approveBody = z.object({ version }).strict();
export const bulkApproveBody = z.object({ ids: z.array(objectId).min(1).max(100) }).strict();
