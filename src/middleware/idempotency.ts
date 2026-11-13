import type { RequestHandler } from 'express';
import { AppError, ErrorCodes, isDuplicateKeyError } from '../lib/errors';
import { sha256 } from '../lib/tokens';
import { IdempotencyKey } from '../models/IdempotencyKey';

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Honors an `Idempotency-Key` header on retryable create/complete operations:
 * a repeated request with the same key and payload replays the original
 * response instead of creating a duplicate trip or a second delivery.
 */
export const idempotent: RequestHandler = async (req, res, next) => {
  const clientKey = req.header('idempotency-key');
  if (!clientKey) return next();
  if (!/^[\w-]{8,100}$/.test(clientKey)) return next(AppError.badRequest('Invalid Idempotency-Key header.'));
  if (!req.user) return next();

  const route = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
  const id = `${req.user.id}:${route}:${clientKey}`;
  const requestHash = sha256(JSON.stringify({ p: req.params, b: req.body }));

  try {
    await IdempotencyKey.create({ _id: id, actorId: req.user.id, route, requestHash, expiresAt: new Date(Date.now() + WINDOW_MS) });
  } catch (err) {
    if (!isDuplicateKeyError(err)) return next(err);
    const existing = await IdempotencyKey.findById(id).lean();
    if (!existing) return next(err);
    if (existing.requestHash !== requestHash) {
      return next(AppError.conflict(ErrorCodes.IDEMPOTENCY_KEY_REUSED, 'This request key was already used for a different request.'));
    }
    if (existing.state === 'in_progress') {
      return next(AppError.conflict(ErrorCodes.RESOURCE_BUSY, 'The same request is still being processed. Please wait.'));
    }
    res.setHeader('Idempotent-Replay', 'true');
    return res.status(existing.statusCode ?? 200).json(existing.responseBody);
  }

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    const status = res.statusCode;
    const op =
      status < 500 && status !== 409
        ? IdempotencyKey.updateOne({ _id: id }, { $set: { state: 'completed', statusCode: status, responseBody: body } })
        : IdempotencyKey.deleteOne({ _id: id }); // let the client retry after transient failures
    op.exec().catch(() => undefined);
    return originalJson(body);
  };
  return next();
};
