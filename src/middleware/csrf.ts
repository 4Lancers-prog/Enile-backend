import type { RequestHandler } from 'express';
import { AppError, ErrorCodes } from '../lib/errors';
import { timingSafeEqualStr } from '../lib/tokens';
import { CSRF_COOKIE } from './auth';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT = new Set(['/api/v1/auth/login']);

/**
 * Double-submit CSRF protection for cookie-authenticated requests: the SPA
 * echoes the readable csrf cookie in the X-CSRF-Token header on every unsafe
 * request. Combined with SameSite=Strict cookies and an Origin allow-list.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  // originalUrl, not req.path: this middleware is mounted under /api, so req.path is relative.
  if (SAFE.has(req.method) || EXEMPT.has(req.originalUrl.split('?')[0])) return next();
  const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const header = req.header('x-csrf-token');
  if (!cookie || !header || !timingSafeEqualStr(cookie, header)) {
    return next(new AppError(403, ErrorCodes.AUTH_CSRF_INVALID, 'Your session security token is missing or expired. Refresh the page and try again.'));
  }
  return next();
};
