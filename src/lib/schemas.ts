import { isValidObjectId } from 'mongoose';
import { z } from 'zod';

/** Shared zod building blocks used by every module's request schemas. */
export const objectId = z.string().refine((v) => isValidObjectId(v) && /^[a-f\d]{24}$/i.test(v), 'Invalid id');
export const idParams = z.object({ id: objectId });
export const trimmed = (max: number) => z.string().trim().max(max);
export const requiredText = (max: number, label = 'This field') =>
  z.string({ required_error: `${label} is required.` }).trim().min(1, `${label} is required.`).max(max, `${label} is too long.`);
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));
export const phone = z
  .string()
  .trim()
  .regex(/^[+\d][\d\s-]{6,18}$/, 'Enter a valid phone number.');
export const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
export const isoDateTime = z.coerce.date({ invalid_type_error: 'Enter a valid date/time.' });
export const version = z.coerce.number().int().min(0);
export const searchQ = z.string().trim().max(80).optional();
export const boolQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

/** Money in integer paise, up to ₹1 crore. */
export const paise = z.coerce.number().int('Amount must be in whole paise.').min(0, 'Amount cannot be negative.').max(1_000_000_000, 'Amount is too large.');
export const positivePaise = paise.refine((v) => v > 0, 'Enter an amount above zero.');
export const ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.');
/** Quantity with up to 3 decimals. */
export const qty = z.coerce.number().positive('Enter a quantity above zero.').max(1_000_000).refine((v) => Math.round(v * 1000) === v * 1000, 'Use at most 3 decimals.');
