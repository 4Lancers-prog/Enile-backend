import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { MulterError } from 'multer';
import { AppError, ErrorCodes, isDuplicateKeyError } from '../lib/errors';
import { logger } from '../lib/logger';

export const notFound: RequestHandler = (req, _res, next) => next(new AppError(404, ErrorCodes.NOT_FOUND, `Route ${req.method} ${req.path} not found.`));

const DUPLICATE_MESSAGES: Record<string, [string, string, string]> = {
  email: [ErrorCodes.USER_DUPLICATE, 'email', 'An account with this email already exists.'],
  normalizedRegistration: [ErrorCodes.VEHICLE_REGISTRATION_DUPLICATE, 'registrationNumber', 'This vehicle is already registered.'],
  normalizedLicence: [ErrorCodes.DRIVER_LICENCE_DUPLICATE, 'licenceNumber', 'A driver with this licence number already exists.'],
  gstin: [ErrorCodes.COMPANY_DUPLICATE, 'gstin', 'A company with this GSTIN already exists.'],
  quotationNumber: [ErrorCodes.QUOTATION_NUMBER_CONFLICT, 'quotationNumber', 'Quotation number collided. Please retry.'],
};

/**
 * Single place that turns errors into the standard JSON shape (manual 5.2).
 * Never leaks stack traces, raw DB errors or personal data.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appErr: AppError;

  if (err instanceof AppError) appErr = err;
  else if (isDuplicateKeyError(err)) {
    const key = Object.keys(err.keyPattern ?? {})[0] ?? '';
    const [code, field, message] = DUPLICATE_MESSAGES[key] ?? [ErrorCodes.VALIDATION_FAILED, key, 'This record already exists.'];
    appErr = new AppError(409, code as AppError['code'], message, [{ field, code: 'DUPLICATE' }]);
  } else if (err instanceof mongoose.Error.VersionError) appErr = AppError.stale();
  else if (err instanceof mongoose.Error.ValidationError) {
    appErr = AppError.badRequest(
      'Please correct the highlighted fields.',
      Object.entries(err.errors).map(([field, e]) => ({ field, code: 'INVALID', message: e.message })),
    );
  } else if (err instanceof mongoose.Error.CastError) appErr = AppError.badRequest(`Invalid value for ${err.path}.`);
  else if (err instanceof MulterError) {
    appErr =
      err.code === 'LIMIT_FILE_SIZE'
        ? new AppError(413, ErrorCodes.DOCUMENT_FILE_TOO_LARGE, 'File is larger than the allowed maximum. Compress or rescan it and try again.')
        : AppError.badRequest('Upload could not be processed.');
  } else if ((err as { type?: string }).type === 'entity.too.large') {
    appErr = new AppError(413, ErrorCodes.PAYLOAD_TOO_LARGE, 'Request is too large.');
  } else if ((err as { type?: string }).type === 'entity.parse.failed') {
    appErr = AppError.badRequest('Malformed JSON body.');
  } else if (
    err instanceof mongoose.mongo.MongoServerSelectionError ||
    err instanceof mongoose.mongo.MongoNetworkError ||
    (err as Error)?.name === 'MongoNotConnectedError'
  ) {
    appErr = new AppError(503, ErrorCodes.DB_TEMPORARILY_UNAVAILABLE, 'The database is temporarily unavailable. Please retry shortly.');
  } else {
    appErr = new AppError(500, ErrorCodes.INTERNAL_ERROR, `Something went wrong. Reference: ${req.id}. Please share this with support.`);
  }

  const level = appErr.status >= 500 ? 'error' : appErr.status === 401 || appErr.status === 404 ? 'debug' : 'warn';
  logger[level](
    { requestId: req.id, route: `${req.method} ${req.originalUrl.split('?')[0]}`, status: appErr.status, code: appErr.code, actor: req.user?.id, err: appErr.status >= 500 ? err : undefined },
    appErr.message,
  );

  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      requestId: req.id,
      ...(appErr.fieldErrors?.length ? { fieldErrors: appErr.fieldErrors } : {}),
      ...(appErr.details && appErr.status < 500 ? { details: appErr.details } : {}),
    },
  });
};
