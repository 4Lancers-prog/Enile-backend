import { z } from 'zod';
import { PO_STATUS } from '../../config/constants';
import { paginationQuery } from '../../lib/pagination';
import { objectId, optionalText, paise, qty, requiredText, searchQ, version, ymd } from '../../lib/schemas';

const line = z
  .object({
    itemId: objectId,
    quantity: qty,
    ratePaise: paise,
    taxRateBps: z.coerce.number().int().refine((v) => [0, 500, 1200, 1800, 2800].includes(v), 'GST must be 0, 5, 12, 18 or 28%.').default(1800),
  })
  .strict();

const poFields = {
  supplierId: objectId,
  orderDate: ymd,
  expectedDate: ymd.nullable().optional(),
  deliverTo: optionalText(200),
  notes: optionalText(1000),
  lines: z
    .array(line)
    .min(1, 'Add at least one item.')
    .max(50, 'A purchase order can have at most 50 lines.')
    .refine((ls) => new Set(ls.map((l) => l.itemId)).size === ls.length, 'Each item can appear only once. Change the quantity instead.'),
};
const dates = (v: { orderDate?: string; expectedDate?: string | null }) => !v.orderDate || !v.expectedDate || v.expectedDate >= v.orderDate;
export const createPoBody = z
  .object({ ...poFields, issue: z.boolean().default(false) })
  .strict()
  .refine(dates, { message: 'Expected delivery cannot be before the order date.', path: ['expectedDate'] });
export const updatePoBody = z
  .object(poFields)
  .partial()
  .extend({ version })
  .strict()
  .refine(dates, { message: 'Expected delivery cannot be before the order date.', path: ['expectedDate'] });
export const listPoQuery = z.object({ ...paginationQuery, q: searchQ, status: z.enum(PO_STATUS).optional(), supplierId: objectId.optional(), itemId: objectId.optional() });
export const receiveBody = z
  .object({
    receivedAt: ymd,
    invoiceNumber: optionalText(60),
    note: optionalText(300),
    lines: z.array(z.object({ itemId: objectId, quantity: z.coerce.number().min(0) }).strict()).min(1),
    version,
  })
  .strict()
  .refine((v) => v.lines.some((l) => l.quantity > 0), { message: 'Enter the quantity received for at least one item.', path: ['lines'] });
export const reasonBody = z.object({ reason: requiredText(300, 'Reason'), version }).strict();
export const versionBody = z.object({ version }).strict();
export const prefillQuery = z.object({ supplierId: objectId.optional() });
