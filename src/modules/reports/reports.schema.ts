import { z } from 'zod';
import { EXPORT_FORMATS, EXPORT_TYPES } from '../../config/constants';
import { ymd } from '../../lib/schemas';

export const rangeQuery = z
  .object({ from: ymd, to: ymd })
  .refine((v) => v.from <= v.to, { message: 'Start date must be on or before the end date.', path: ['from'] });

export const exportBody = z
  .object({
    type: z.enum(EXPORT_TYPES),
    format: z.enum(EXPORT_FORMATS).default('csv'),
    from: ymd.optional(),
    to: ymd.optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'Start date must be on or before the end date.', path: ['from'] });
