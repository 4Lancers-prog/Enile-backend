import type { RequestHandler } from 'express';

/**
 * Removes keys starting with `$` or containing `.` from body, query and params,
 * blocking MongoDB operator injection even before schema validation runs.
 * Also drops prototype-pollution keys.
 */
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function clean(value: unknown, depth = 0): unknown {
  if (depth > 20) return undefined;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.') || BAD_KEYS.has(k)) continue;
      out[k] = clean(v, depth + 1);
    }
    return out;
  }
  return value;
}

export const sanitize: RequestHandler = (req, _res, next) => {
  if (req.body) req.body = clean(req.body);
  if (req.params) req.params = clean(req.params) as typeof req.params;
  if (req.query) req.query = clean(req.query) as typeof req.query;
  next();
};
