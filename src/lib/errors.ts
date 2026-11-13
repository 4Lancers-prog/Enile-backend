/** Stable machine-readable error codes (manual 5.3 plus codes for the new gap fixes). */
export const ErrorCodes = {
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_ACCOUNT_DISABLED: 'AUTH_ACCOUNT_DISABLED',
  AUTH_ACCOUNT_LOCKED: 'AUTH_ACCOUNT_LOCKED',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
  AUTH_CSRF_INVALID: 'AUTH_CSRF_INVALID',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT_STALE_VERSION: 'CONFLICT_STALE_VERSION',
  USER_DUPLICATE: 'USER_DUPLICATE',
  LAST_ADMIN: 'LAST_ADMIN',
  LEAD_ALREADY_CONVERTED: 'LEAD_ALREADY_CONVERTED',
  COMPANY_DUPLICATE: 'COMPANY_DUPLICATE',
  COMPANY_INACTIVE: 'COMPANY_INACTIVE',
  COMPANY_IN_USE: 'COMPANY_IN_USE',
  GSTIN_FORMAT_INVALID: 'GSTIN_FORMAT_INVALID',
  VEHICLE_REGISTRATION_DUPLICATE: 'VEHICLE_REGISTRATION_DUPLICATE',
  DRIVER_LICENCE_DUPLICATE: 'DRIVER_LICENCE_DUPLICATE',
  DOCUMENT_FILE_TOO_LARGE: 'DOCUMENT_FILE_TOO_LARGE',
  DOCUMENT_TYPE_NOT_ALLOWED: 'DOCUMENT_TYPE_NOT_ALLOWED',
  DOCUMENT_DUPLICATE: 'DOCUMENT_DUPLICATE',
  DOCUMENT_STORAGE_UNAVAILABLE: 'DOCUMENT_STORAGE_UNAVAILABLE',
  FILE_LINK_EXPIRED: 'FILE_LINK_EXPIRED',
  QUOTATION_NUMBER_CONFLICT: 'QUOTATION_NUMBER_CONFLICT',
  QUOTATION_NOT_EDITABLE: 'QUOTATION_NOT_EDITABLE',
  QUOTATION_INVALID_STATUS_TRANSITION: 'QUOTATION_INVALID_STATUS_TRANSITION',
  QUOTATION_PDF_FAILED: 'QUOTATION_PDF_FAILED',
  QUOTATION_PDF_PENDING: 'QUOTATION_PDF_PENDING',
  TRIP_VEHICLE_UNAVAILABLE: 'TRIP_VEHICLE_UNAVAILABLE',
  TRIP_DRIVER_UNAVAILABLE: 'TRIP_DRIVER_UNAVAILABLE',
  TRIP_COMPLIANCE_BLOCKED: 'TRIP_COMPLIANCE_BLOCKED',
  TRIP_INVALID_STATUS_TRANSITION: 'TRIP_INVALID_STATUS_TRANSITION',
  RESOURCE_BUSY: 'RESOURCE_BUSY',
  DEPENDENT_RECORDS: 'DEPENDENT_RECORDS',
  ODOMETER_BACKWARDS: 'ODOMETER_BACKWARDS',
  STOCK_INSUFFICIENT: 'STOCK_INSUFFICIENT',
  DUPLICATE_RECORD: 'DUPLICATE_RECORD',
  PO_INVALID_STATUS_TRANSITION: 'PO_INVALID_STATUS_TRANSITION',
  PO_OVER_RECEIPT: 'PO_OVER_RECEIPT',
  EXPENSE_NOT_EDITABLE: 'EXPENSE_NOT_EDITABLE',
  PAYMENT_EXCEEDS_DUE: 'PAYMENT_EXCEEDS_DUE',
  ADVANCE_RECOVERY_TOO_HIGH: 'ADVANCE_RECOVERY_TOO_HIGH',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  REPORT_RANGE_TOO_LARGE: 'REPORT_RANGE_TOO_LARGE',
  RENEWAL_NOTIFICATION_FAILED: 'RENEWAL_NOTIFICATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  DB_TEMPORARILY_UNAVAILABLE: 'DB_TEMPORARILY_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface FieldError {
  field: string;
  code: string;
  message?: string;
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly fieldErrors?: FieldError[],
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, fieldErrors?: FieldError[]) {
    return new AppError(400, ErrorCodes.VALIDATION_FAILED, message, fieldErrors);
  }
  static unprocessable(code: ErrorCode, message: string, fieldErrors?: FieldError[], details?: Record<string, unknown>) {
    return new AppError(422, code, message, fieldErrors, details);
  }
  static notFound(entity = 'Record') {
    return new AppError(404, ErrorCodes.NOT_FOUND, `${entity} not found.`);
  }
  static forbidden(message = "You don't have permission to perform this action.") {
    return new AppError(403, ErrorCodes.AUTH_FORBIDDEN, message);
  }
  static conflict(code: ErrorCode, message: string, details?: Record<string, unknown>, fieldErrors?: FieldError[]) {
    return new AppError(409, code, message, fieldErrors, details);
  }
  static stale() {
    return new AppError(
      409,
      ErrorCodes.CONFLICT_STALE_VERSION,
      'This record was changed by someone else. Refresh to see the latest version, then try again.',
    );
  }
}

/** True for MongoDB duplicate-key errors (E11000). */
export function isDuplicateKeyError(err: unknown): err is { code: number; keyPattern?: Record<string, number> } {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
