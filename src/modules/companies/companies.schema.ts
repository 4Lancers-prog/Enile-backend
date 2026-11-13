import { z } from 'zod';
import { COMPANY_STATUS, CUSTOMER_TYPES } from '../../config/constants';
import { paginationQuery } from '../../lib/pagination';
import { email, objectId, optionalText, phone, requiredText, searchQ, version } from '../../lib/schemas';

export const addressBody = z
  .object({
    line1: optionalText(200),
    line2: optionalText(200),
    city: optionalText(80),
    state: optionalText(80),
    stateCode: z.string().regex(/^\d{2}$/, 'Use the 2-digit GST state code.').optional().or(z.literal('').transform(() => undefined)),
    pincode: z.string().regex(/^\d{6}$/, 'Enter a 6-digit PIN code.').optional().or(z.literal('').transform(() => undefined)),
  })
  .strict();

export const contactBody = z
  .object({
    name: requiredText(100, 'Contact name'),
    designation: optionalText(80),
    phone: phone.optional().or(z.literal('').transform(() => undefined)),
    email: email.optional().or(z.literal('').transform(() => undefined)),
    isPrimary: z.boolean().optional(),
  })
  .strict();

const companyFields = {
  legalName: requiredText(160, 'Company name'),
  tradeName: optionalText(160),
  customerType: z.enum(CUSTOMER_TYPES).default('other'),
  gstin: z.string().trim().max(15).optional().or(z.literal('').transform(() => undefined)),
  billingAddress: addressBody.default({}),
  contacts: z.array(contactBody).max(10).default([]),
  creditDays: z.coerce.number().int().min(0).max(365).optional(),
  notes: optionalText(2000),
};

export const createCompanyBody = z
  .object({ ...companyFields, confirmDuplicate: z.boolean().optional() })
  .strict()
  .superRefine((v, ctx) => {
    // Business customers must have a billing city/state; GST customers need the full address.
    if (v.customerType !== 'other' && !v.billingAddress.city) {
      ctx.addIssue({ code: 'custom', path: ['billingAddress', 'city'], message: 'Billing city is required for business customers.' });
    }
    if (v.gstin && !v.billingAddress.line1) {
      ctx.addIssue({ code: 'custom', path: ['billingAddress', 'line1'], message: 'Billing address is required when GSTIN is provided.' });
    }
  });
export type CreateCompanyInput = z.infer<typeof createCompanyBody>;

export const updateCompanyBody = z
  .object({
    version,
    legalName: companyFields.legalName.optional(),
    tradeName: companyFields.tradeName,
    customerType: z.enum(CUSTOMER_TYPES).optional(),
    gstin: companyFields.gstin.nullable(),
    billingAddress: addressBody.optional(),
    contacts: z.array(contactBody).max(10).optional(),
    creditDays: companyFields.creditDays,
    notes: companyFields.notes,
    status: z.enum(COMPANY_STATUS).optional(),
  })
  .strict();

export const lookupQuery = z.object({ q: searchQ, id: objectId.optional() }).strict();

export const listCompaniesQuery = z.object({
  ...paginationQuery,
  q: searchQ,
  status: z.enum(COMPANY_STATUS).optional(),
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  lite: z.enum(['true', 'false']).optional(),
});

export const duplicatesQuery = z.object({
  name: z.string().trim().max(160).optional(),
  gstin: z.string().trim().max(15).optional(),
  phone: z.string().trim().max(20).optional(),
  excludeId: z.string().optional(),
});
