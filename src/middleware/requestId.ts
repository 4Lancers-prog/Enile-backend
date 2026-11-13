import crypto from 'crypto';
import type { RequestHandler } from 'express';

/** Every request gets a correlation id, echoed in the X-Request-Id header and in errors. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : `req_${crypto.randomUUID().replace(/-/g, '')}`;
  res.setHeader('X-Request-Id', req.id);
  next();
};
