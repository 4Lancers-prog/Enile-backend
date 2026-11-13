import { z } from 'zod';
import { PRODUCTS, QUOTATION_STATUS, QUOTATION_UNITS } from '../../config/constants';
import { paginationQuery } from '../../lib/pagination';
import { objectId, optionalText, requiredText, searchQ, version, ymd } from '../../lib/schemas';

const threeDecimals = (v: number) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6;

export const lineItemBody = z
  .object({
    description: requiredText(300, 'Description'),
    hsnSac: optionalText(10),
    product: z.enum(PRODUCTS).optional(),
    route: optionalText(200),
    quantity: z.number({ invalid_type_error: 'Quantity must be a number.' }).positive('Quantity must be positive.').max(1_000_000).refine(threeDecimals, 'Use at most 3 decimals.'),
    unit: z.enum(QUOTATION_UNITS),
    ratePaise: z.number().int('Rate must be in whole paise.').min(0, 'Rate cannot be negative.').max(10_000_000_000),
    discountPaise: z.number().int().min(0).max(10_000_000_000).default(0),
  })
  .strict();

const fields = {
  companyId: objectId,
  leadId: objectId.nullable().optional(),
  subject: optionalText(200),
  lineItems: z.array(lineItemBody).min(1, 'Add at least one line item.').max(50),
  taxRateBps: z.number().int().min(0).max(2800),
  validityDays: z.number().int().min(1).max(90).optional(),
  terms: optionalText(4000),
};

export const createQuotationBody = z.object(fields).strict();
export const updateQuotationBody = z.object(fields).partial().extend({ version }).strict();

export const decideBody = z
  .object({
    version,
    status: z.enum(['accepted', 'rejected', 'cancelled']),
    reason: optionalText(500),
  })
  .strict()
  .refine((v) => v.status === 'accepted' || v.reason, { message: 'Please give a reason.', path: ['reason'] });

export const listQuotationsQuery = z.object({
  ...paginationQuery,
  q: searchQ,
  status: z.enum(QUOTATION_STATUS).optional(),
  companyId: objectId.optional(),
  from: ymd.optional(),
  to: ymd.optional(),
});
