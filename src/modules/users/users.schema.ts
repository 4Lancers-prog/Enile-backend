import { z } from 'zod';
import { ROLES, USER_STATUS } from '../../config/constants';
import { paginationQuery } from '../../lib/pagination';
import { email, optionalText, phone, requiredText, searchQ, version } from '../../lib/schemas';
import { passwordPolicy } from '../auth/auth.schema';

export const listUsersQuery = z.object({ ...paginationQuery, q: searchQ, role: z.enum(ROLES).optional(), status: z.enum(USER_STATUS).optional() });

export const createUserBody = z
  .object({
    name: requiredText(100, 'Name'),
    email,
    phone: phone.optional(),
    role: z.enum(ROLES),
    password: passwordPolicy,
  })
  .strict();

export const updateUserBody = z
  .object({
    version,
    name: requiredText(100, 'Name').optional(),
    phone: phone.optional().or(z.literal('')),
    role: z.enum(ROLES).optional(),
    status: z.enum(USER_STATUS).optional(),
  })
  .strict();

export const resetPasswordBody = z.object({ password: passwordPolicy }).strict();
export { optionalText };
