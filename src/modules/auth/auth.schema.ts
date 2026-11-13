import { z } from 'zod';
import { email } from '../../lib/schemas';

export const passwordPolicy = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(128, 'Password is too long.')
  .regex(/[A-Za-z]/, 'Include at least one letter.')
  .regex(/\d/, 'Include at least one number.');

export const loginBody = z
  .object({
    email: z.string({ required_error: 'Enter your email and password.' }).trim().toLowerCase().min(1, 'Enter your email and password.').max(254),
    password: z.string({ required_error: 'Enter your email and password.' }).min(1, 'Enter your email and password.').max(128),
  })
  .strict();

export const changePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordPolicy })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'New password must differ from the current one.', path: ['newPassword'] });

export { email };
