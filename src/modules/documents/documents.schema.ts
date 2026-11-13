import { z } from 'zod';
import { DOCUMENT_OWNER_TYPES, DOCUMENT_TYPES, DRIVER_DOCUMENT_TYPES, VEHICLE_DOCUMENT_TYPES } from '../../config/constants';
import { paginationQuery } from '../../lib/pagination';
import { objectId, optionalText, ymd } from '../../lib/schemas';

const emptyToUndef = z.literal('').transform(() => undefined);

/** Multipart text fields arrive as strings. */
export const uploadFields = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES),
    documentNumber: optionalText(60),
    issueDate: ymd.optional().or(emptyToUndef),
    expiryDate: ymd.optional().or(emptyToUndef),
    notes: optionalText(1000),
    replaceReason: optionalText(300),
    confirmDuplicate: z.enum(['true', 'false']).optional(),
  })
  .strict();

export const allowedTypesFor = (ownerType: (typeof DOCUMENT_OWNER_TYPES)[number]): readonly string[] =>
  ownerType === 'vehicle' ? VEHICLE_DOCUMENT_TYPES : DRIVER_DOCUMENT_TYPES;

export const updateDocumentBody = z
  .object({
    documentNumber: optionalText(60),
    issueDate: ymd.nullable().optional(),
    expiryDate: ymd.nullable().optional(),
    notes: optionalText(1000),
  })
  .strict();

export const listDocumentsQuery = z.object({
  ...paginationQuery,
  ownerType: z.enum(DOCUMENT_OWNER_TYPES).optional(),
  ownerId: objectId.optional(),
  documentType: z.enum(DOCUMENT_TYPES).optional(),
  expiry: z.enum(['expired', 'expiring', 'valid', 'all']).default('all'),
  withinDays: z.coerce.number().int().min(1).max(365).default(30),
});
