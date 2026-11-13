/**
 * Domain enums. The API rejects any value outside these lists (manual 3.2).
 * Petroleum-specific values close the gaps found in the manual review.
 */
export const ROLES = ['admin', 'manager', 'sales', 'operations', 'accounts'] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUS = ['active', 'disabled'] as const;

export const LEAD_STATUS = ['new', 'contacted', 'qualified', 'converted', 'lost'] as const;
export const LEAD_SOURCES = ['referral', 'existing_customer', 'walk_in', 'phone', 'other'] as const;

export const COMPANY_STATUS = ['active', 'inactive'] as const;
export const CUSTOMER_TYPES = ['oil_marketing_company', 'dealer', 'industrial', 'transporter', 'other'] as const;

export const PRODUCTS = ['MS', 'HSD', 'ATF', 'SKO', 'LDO', 'FO', 'BITUMEN', 'ETHANOL', 'LUBES', 'OTHER'] as const;
export const PRODUCT_LABELS: Record<(typeof PRODUCTS)[number], string> = {
  MS: 'Petrol (MS)',
  HSD: 'Diesel (HSD)',
  ATF: 'Aviation Turbine Fuel',
  SKO: 'Kerosene (SKO)',
  LDO: 'Light Diesel Oil',
  FO: 'Furnace Oil',
  BITUMEN: 'Bitumen',
  ETHANOL: 'Ethanol',
  LUBES: 'Lubricants',
  OTHER: 'Other',
};

export const VEHICLE_TYPES = ['tanker_truck', 'tanker_trailer', 'bowser', 'support_vehicle'] as const;
export const VEHICLE_STATUS = ['active', 'in_service', 'unavailable', 'retired'] as const;
export const OWNERSHIP = ['owned', 'attached', 'leased'] as const;

export const DRIVER_STATUS = ['active', 'on_leave', 'inactive'] as const;

export const DOCUMENT_OWNER_TYPES = ['vehicle', 'driver'] as const;
export const VEHICLE_DOCUMENT_TYPES = [
  'RC',
  'INSURANCE',
  'FITNESS',
  'NATIONAL_PERMIT',
  'STATE_PERMIT',
  'PUC',
  'PESO_LICENCE',
  'CALIBRATION_CERT',
  'ROAD_TAX',
  'OTHER',
] as const;
export const DRIVER_DOCUMENT_TYPES = ['DRIVING_LICENCE', 'HAZCHEM_TRAINING', 'MEDICAL', 'ID_PROOF', 'OTHER'] as const;
export type DocumentType = (typeof VEHICLE_DOCUMENT_TYPES)[number] | (typeof DRIVER_DOCUMENT_TYPES)[number];
export const DOCUMENT_TYPES = [...new Set<DocumentType>([...VEHICLE_DOCUMENT_TYPES, ...DRIVER_DOCUMENT_TYPES])] as [DocumentType, ...DocumentType[]];
/** Types where "no expiry" is allowed. Every other type must carry an expiry date. */
export const NON_EXPIRING_DOCUMENT_TYPES: DocumentType[] = ['RC', 'ID_PROOF', 'OTHER'];
export const DOCUMENT_STATUS = ['active', 'superseded'] as const;

/** Quotation lifecycle (gap: statuses were never listed in the manual). */
export const QUOTATION_STATUS = ['draft', 'issued', 'accepted', 'rejected', 'expired', 'superseded', 'cancelled'] as const;
export type QuotationStatus = (typeof QUOTATION_STATUS)[number];
export const QUOTATION_TRANSITIONS: Record<QuotationStatus, QuotationStatus[]> = {
  draft: ['issued', 'cancelled'],
  issued: ['accepted', 'rejected', 'expired', 'superseded', 'cancelled'],
  accepted: ['superseded'],
  rejected: ['superseded'],
  expired: ['superseded'],
  superseded: [],
  cancelled: [],
};
export const QUOTATION_UNITS = ['trip', 'KL', 'litre', 'km', 'day', 'lumpsum'] as const;

/** Trip lifecycle including explicit cancellation and an audited correction flow. */
export const TRIP_STATUS = ['planned', 'in_transit', 'delivered', 'cancelled'] as const;
export type TripStatus = (typeof TRIP_STATUS)[number];
export const TRIP_TRANSITIONS: Record<TripStatus, TripStatus[]> = {
  planned: ['in_transit', 'cancelled'],
  in_transit: ['delivered', 'cancelled'],
  delivered: [], // only via POST /trips/:id/correct (permission trips.correct)
  cancelled: [],
};
/** Statuses that occupy a vehicle/driver for overlap checks. */
export const TRIP_ACTIVE_STATUS: TripStatus[] = ['planned', 'in_transit'];

export const JOB_STATUS = ['queued', 'processing', 'done', 'failed', 'dead'] as const;
export const JOB_TYPES = ['quotation_pdf', 'export'] as const;
export const NOTIFICATION_CHANNELS = ['email', 'in_app'] as const;
export const NOTIFICATION_STATUS = ['queued', 'processing', 'sent', 'delivered', 'failed', 'dead'] as const;
export const RENEWAL_SUBJECTS = ['document', 'driver_licence', 'driver_hazchem'] as const;
export const RENEWAL_STATUS = ['queued', 'processing', 'dispatched', 'failed', 'dead', 'skipped'] as const;

export const EXPORT_TYPES = ['trips', 'quotations', 'companies', 'vehicles', 'renewals', 'leads', 'driver_payments', 'trip_expenses', 'stock_movements', 'purchase_orders'] as const;
export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

/* ---------- Stores: stock items, suppliers, purchase orders ---------- */
export const STOCK_CATEGORIES = ['spare_part', 'tyre', 'lubricant', 'battery', 'seal', 'safety', 'consumable', 'other'] as const;
export const STOCK_UNITS = ['nos', 'set', 'litre', 'kg', 'metre', 'box'] as const;
export const ITEM_STATUS = ['active', 'inactive'] as const;
export const SUPPLIER_STATUS = ['active', 'inactive'] as const;
export const STOCK_MOVEMENT_TYPES = ['purchase_receipt', 'issue', 'return', 'adjustment'] as const;
/** Purchase order lifecycle. A partly received order can be closed short; only an order with nothing received can be cancelled. */
export const PO_STATUS = ['draft', 'issued', 'partially_received', 'received', 'closed', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUS)[number];
export const PO_OPEN_STATUS: PoStatus[] = ['draft', 'issued', 'partially_received'];

/* ---------- Trip expenses ---------- */
export const EXPENSE_CATEGORIES = ['fuel', 'toll', 'driver_allowance', 'food', 'loading_unloading', 'parking', 'repair', 'weighbridge', 'police_rto', 'other'] as const;
export const EXPENSE_STATUS = ['pending', 'approved', 'rejected'] as const;
/** Who paid the bill. Driver-paid, approved expenses are owed back to the driver. */
export const EXPENSE_PAID_BY = ['driver', 'office', 'fuel_card', 'fastag'] as const;

/* ---------- Driver payroll ---------- */
export const PAYMENT_MODES = ['cash', 'bank_transfer', 'upi', 'cheque'] as const;
/**
 * Cash paid to a driver. Advances (including the joining advance) build an
 * outstanding balance that salary payments recover; reimbursements settle
 * driver-paid trip expenses.
 */
export const DRIVER_PAYMENT_TYPES = ['salary', 'joining_advance', 'advance', 'trip_allowance', 'bonus', 'reimbursement', 'other'] as const;
export type DriverPaymentType = (typeof DRIVER_PAYMENT_TYPES)[number];
export const ADVANCE_PAYMENT_TYPES: DriverPaymentType[] = ['joining_advance', 'advance'];
export const DRIVER_PAYMENT_STATUS = ['paid', 'void'] as const;
export const PO_PREFIX = 'ENL/PO';
export const PAYMENT_PREFIX = 'ENL/PAY';
