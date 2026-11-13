import rateLimit, { type Options } from 'express-rate-limit';
import { ErrorCodes } from '../lib/errors';

const handler: Options['handler'] = (req, res) => {
  res.status(429).json({
    error: { code: ErrorCodes.RATE_LIMITED, message: 'Too many requests. Please wait a moment and try again.', requestId: req.id },
  });
};

/** General API limit per IP (stateless; use a shared store such as Redis when running many instances). */
export const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false, handler });

/** Login throttling per IP + email (manual 4.1). Account lockout is enforced separately. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${String(req.body?.email ?? '').toLowerCase().slice(0, 254)}`,
  handler,
});

export const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, handler });
export const exportLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, handler });
