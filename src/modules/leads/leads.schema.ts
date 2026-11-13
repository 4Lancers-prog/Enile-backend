import { z } from 'zod';
import { LEAD_SOURCES, LEAD_STATUS, PRODUCTS } from '../../config/constants';
import { paginationQuery } from '../../lib/pagination';
import { email, isoDateTime, objectId, optionalText, phone, requiredText, searchQ, version } from '../../lib/schemas';
import { createCompanyBody } from '../companies/companies.schema';

const leadFields = {
  name: requiredText(160, 'Lead name'),
  contactPerson: optionalText(100),
  phone: phone.optional().or(z.literal('').transform(() => undefined)),
  email: email.optional().or(z.literal('').transform(() => undefined)),
  source: z.enum(LEAD_SOURCES).default('referral'),
  referredBy: optionalText(160),
  products: z.array(z.enum(PRODUCTS)).max(PRODUCTS.length).default([]),
  estimatedMonthlyKl: z.coerce.number().min(0).max(1_000_000).optional(),
  route: optionalText(200),
  followUpAt: isoDateTime.nullable().optional(),
  assignedTo: objectId.nullable().optional(),
  notes: optionalText(2000),
};

export const createLeadBody = z
  .object(leadFields)
  .strict()
  .refine((v) => v.phone || v.email, { message: 'Add a phone number or email so the lead can be contacted.', path: ['phone'] })
  .refine((v) => v.source !== 'referral' || v.referredBy, { message: 'Who referred this lead?', path: ['referredBy'] });

export const updateLeadBody = z
  .object(leadFields)
  .partial()
  .extend({
    version,
    status: z.enum(LEAD_STATUS).exclude(['converted']).optional(),
    lostReason: optionalText(300),
  })
  .strict()
  .refine((v) => v.status !== 'lost' || v.lostReason, { message: 'Give a reason when marking a lead as lost.', path: ['lostReason'] });

export const listLeadsQuery = z.object({
  ...paginationQuery,
  q: searchQ,
  status: z.enum(LEAD_STATUS).optional(),
  mine: z.enum(['true', 'false']).optional(),
});

export const convertLeadBody = z.union([
  z.object({ existingCompanyId: objectId }).strict(),
  z.object({ company: createCompanyBody }).strict(),
]);
