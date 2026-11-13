import { z } from 'zod';
import { ITEM_STATUS, STOCK_CATEGORIES, STOCK_MOVEMENT_TYPES, STOCK_UNITS, SUPPLIER_STATUS } from '../../config/constants';
import { paginationQuery } from '../../lib/pagination';
import { email, objectId, optionalText, paise, phone, qty, requiredText, searchQ, version, ymd } from '../../lib/schemas';

const itemFields = {
  name: requiredText(120, 'Item name'),
  category: z.enum(STOCK_CATEGORIES),
  unit: z.enum(STOCK_UNITS),
  hsnSac: z.string().trim().regex(/^\d{4,8}$/, 'HSN/SAC is 4 to 8 digits.').optional().or(z.literal('').transform(() => undefined)),
  reorderLevel: z.coerce.number().min(0).max(1_000_000).default(0),
  location: optionalText(60),
  notes: optionalText(1000),
};
export const createItemBody = z
  .object({ ...itemFields, openingQty: z.coerce.number().min(0).max(1_000_000).default(0), openingRatePaise: paise.default(0) })
  .strict()
  .refine((v) => !v.openingQty || v.openingRatePaise > 0, { message: 'Enter the unit cost for the opening stock.', path: ['openingRatePaise'] });
export const updateItemBody = z.object(itemFields).partial().extend({ version, status: z.enum(ITEM_STATUS).optional() }).strict();
export const listItemsQuery = z.object({
  ...paginationQuery,
  q: searchQ,
  category: z.enum(STOCK_CATEGORIES).optional(),
  status: z.enum(ITEM_STATUS).optional(),
  stock: z.enum(['low', 'out']).optional(),
});

export const issueBody = z
  .object({
    quantity: qty,
    date: ymd,
    vehicleId: objectId.optional(),
    tripId: objectId.optional(),
    reference: optionalText(60),
    reason: optionalText(300),
  })
  .strict();
export const adjustBody = z
  .object({
    quantity: z.coerce.number().refine((v) => v !== 0, 'Enter a quantity to add (positive) or remove (negative).').refine((v) => Math.abs(v) <= 1_000_000),
    date: ymd,
    reason: requiredText(300, 'Reason'),
  })
  .strict();
export const listMovementsQuery = z.object({
  ...paginationQuery,
  itemId: objectId.optional(),
  vehicleId: objectId.optional(),
  type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
});

const supplierFields = {
  name: requiredText(160, 'Supplier name'),
  gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, 'Enter a valid 15-character GSTIN.').optional().or(z.literal('').transform(() => undefined)),
  contactName: optionalText(100),
  phone: phone.optional().or(z.literal('').transform(() => undefined)),
  email: email.optional().or(z.literal('').transform(() => undefined)),
  city: optionalText(80),
  state: optionalText(80),
  stateCode: z.string().regex(/^\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  notes: optionalText(1000),
};
export const createSupplierBody = z.object(supplierFields).strict();
export const updateSupplierBody = z.object(supplierFields).partial().extend({ version, status: z.enum(SUPPLIER_STATUS).optional() }).strict();
export const listSuppliersQuery = z.object({ ...paginationQuery, q: searchQ, status: z.enum(SUPPLIER_STATUS).optional() });
