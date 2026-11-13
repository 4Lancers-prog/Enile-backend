import type { RequestHandler } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError, type FieldError } from '../lib/errors';

export function zodToFieldErrors(err: ZodError): FieldError[] {
  return err.issues.map((i) => ({ field: i.path.join('.') || '(root)', code: i.code.toUpperCase(), message: i.message }));
}

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validates and replaces body/query/params with the parsed (typed, stripped)
 * result. Schemas use .strict() where unknown fields must be rejected.
 */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, _res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(AppError.badRequest('Please correct the highlighted fields.', zodToFieldErrors(err)));
      } else next(err);
    }
  };

/** Typed accessor for validated query objects. */
export const q = <S extends ZodTypeAny>(_schema: S, query: unknown) => query as z.infer<S>;
