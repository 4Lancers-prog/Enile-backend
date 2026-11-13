import ExcelJS from 'exceljs';
import type { Model } from 'mongoose';
import { PassThrough } from 'stream';
import { safeCell, toCsvLine } from '../lib/csv';
import { addDaysYmd, startOfDayInTz, ymdInTz } from '../lib/time';
import { Company } from '../models/Company';
import { ComplianceDocument } from '../models/Document';
import { Lead } from '../models/Lead';
import { Quotation } from '../models/Quotation';
import { Trip } from '../models/Trip';
import { Vehicle } from '../models/Vehicle';
import { DriverPayment } from '../models/DriverPayment';
import { PurchaseOrder } from '../models/PurchaseOrder';
import { StockMovement } from '../models/StockMovement';
import { TripExpense } from '../models/TripExpense';
import { PAYMENT_HEADERS, paymentRow } from '../modules/payroll/payroll.export';

type Row = unknown[];
interface ExportDef {
  headers: string[];
  model: Model<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  dateField?: string;
  sort: Record<string, 1 | -1>;
  populate?: { path: string; select: string }[];
  map: (doc: any, tz: string) => Row; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const d = (v: Date | null | undefined, tz: string) => (v ? ymdInTz(v, tz) : '');
const rupees = (p?: number) => (typeof p === 'number' ? p / 100 : '');

const DEFS: Record<string, ExportDef> = {
  trips: {
    headers: ['Trip number', 'Status', 'Company', 'Vehicle', 'Driver', 'Product', 'Planned L', 'Dispatched L', 'Received L', 'Shortage L', 'Within tolerance', 'Loading point', 'Unloading point', 'Planned start', 'Delivered on', 'Invoice/Challan'],
    model: Trip,
    dateField: 'plannedStart',
    sort: { plannedStart: 1 },
    populate: [
      { path: 'companyId', select: 'legalName' },
      { path: 'vehicleId', select: 'registrationNumber' },
      { path: 'driverId', select: 'name' },
    ],
    map: (t, tz) => [t.tripNumber, t.status, t.companyId?.legalName, t.vehicleId?.registrationNumber, t.driverId?.name, t.product, t.plannedQuantityLitres, t.dispatch?.dispatchedQuantityLitres, t.delivery?.receivedQuantityLitres, t.delivery?.shortageLitres, t.delivery ? (t.delivery.withinTolerance ? 'Yes' : 'No') : '', t.loadingPoint, t.unloadingPoint, d(t.plannedStart, tz), d(t.delivery?.deliveredAt, tz), t.dispatch?.invoiceNumber],
  },
  quotations: {
    headers: ['Quotation number', 'Revision', 'Status', 'Company', 'GSTIN', 'Issue date', 'Valid until', 'Taxable (INR)', 'Tax (INR)', 'Total (INR)', 'Tax config'],
    model: Quotation,
    dateField: 'issueDate',
    sort: { issueDate: 1 },
    map: (q, tz) => [q.quotationNumber ?? '(draft)', q.revision, q.status, q.companySnapshot?.legalName, q.companySnapshot?.gstin, d(q.issueDate, tz), d(q.validUntil, tz), rupees(q.taxablePaise), rupees(q.taxTotalPaise), rupees(q.totalPaise), q.taxConfigVersion],
  },
  companies: {
    headers: ['Code', 'Legal name', 'Type', 'GSTIN', 'City', 'State', 'Primary contact', 'Phone', 'Status', 'Created'],
    model: Company,
    dateField: 'createdAt',
    sort: { createdAt: 1 },
    map: (c, tz) => {
      const p = c.contacts?.find((x: { isPrimary?: boolean }) => x.isPrimary) ?? c.contacts?.[0];
      return [c.companyCode, c.legalName, c.customerType, c.gstin, c.billingAddress?.city, c.billingAddress?.state, p?.name, p?.phone, c.status, d(c.createdAt, tz)];
    },
  },
  vehicles: {
    headers: ['Registration', 'Type', 'Capacity L', 'Compartments', 'Ownership', 'Status', 'Make', 'Model', 'Year'],
    model: Vehicle,
    sort: { normalizedRegistration: 1 },
    map: (v) => [v.registrationNumber, v.vehicleType, v.capacityLitres, v.compartments?.length ?? 0, v.ownership, v.status, v.make, v.model, v.manufactureYear],
  },
  renewals: {
    headers: ['Owner type', 'Owner id', 'Document type', 'Number', 'Issue date', 'Expiry date', 'Status'],
    model: ComplianceDocument,
    dateField: 'expiryDate',
    sort: { expiryDate: 1 },
    map: (x, tz) => [x.ownerType, String(x.ownerId), x.documentType, x.documentNumber, d(x.issueDate, tz), d(x.expiryDate, tz), x.status],
  },
  leads: {
    headers: ['Name', 'Contact', 'Phone', 'Email', 'Source', 'Referred by', 'Products', 'Est. KL/month', 'Status', 'Created'],
    model: Lead,
    dateField: 'createdAt',
    sort: { createdAt: 1 },
    map: (l, tz) => [l.name, l.contactPerson, l.phone, l.email, l.source, l.referredBy, (l.products ?? []).join(' '), l.estimatedMonthlyKl, l.status, d(l.createdAt, tz)],
  },
  driver_payments: {
    headers: PAYMENT_HEADERS,
    model: DriverPayment,
    dateField: 'paymentDate',
    sort: { paymentDate: 1 },
    populate: [{ path: 'driverId', select: 'employeeCode' }],
    map: (p, tz) => paymentRow(p, tz),
  },
  trip_expenses: {
    headers: ['Date', 'Trip', 'Vehicle', 'Driver', 'Category', 'Amount (INR)', 'Litres', 'Rate (INR/L)', 'Paid by', 'Mode', 'Vendor', 'Bill no', 'Receipt', 'Status', 'Reimbursed'],
    model: TripExpense,
    dateField: 'expenseDate',
    sort: { expenseDate: 1 },
    populate: [
      { path: 'vehicleId', select: 'registrationNumber' },
      { path: 'driverId', select: 'name' },
    ],
    map: (e, tz) => [d(e.expenseDate, tz), e.tripNumber, e.vehicleId?.registrationNumber, e.driverId?.name, e.category, rupees(e.amountPaise), e.litres ?? '', rupees(e.ratePaise ?? undefined), e.paidBy, e.paymentMode, e.vendor, e.billNumber, e.receipt ? 'Yes' : 'No', e.status, e.reimbursedPaymentId ? 'Yes' : e.paidBy === 'driver' ? 'No' : ''],
  },
  stock_movements: {
    headers: ['Date', 'Item code', 'Item', 'Type', 'Quantity', 'Unit', 'Balance after', 'Unit cost (INR)', 'PO', 'Vehicle', 'Reference', 'Reason'],
    model: StockMovement,
    dateField: 'date',
    sort: { date: 1 },
    populate: [
      { path: 'itemId', select: 'itemCode name unit' },
      { path: 'vehicleId', select: 'registrationNumber' },
    ],
    map: (m, tz) => [d(m.date, tz), m.itemId?.itemCode, m.itemId?.name, m.type, m.quantity, m.itemId?.unit, m.balanceAfter, rupees(m.unitCostPaise), m.poNumber, m.vehicleId?.registrationNumber, m.reference, m.reason],
  },
  purchase_orders: {
    headers: ['PO number', 'Order date', 'Supplier', 'GSTIN', 'Status', 'Lines', 'Subtotal (INR)', 'GST (INR)', 'Total (INR)', 'Received value (INR)', 'Expected'],
    model: PurchaseOrder,
    dateField: 'orderDate',
    sort: { orderDate: 1 },
    map: (p, tz) => [p.poNumber, d(p.orderDate, tz), p.supplierSnapshot?.name, p.supplierSnapshot?.gstin, p.status, p.lines?.length ?? 0, rupees(p.subtotalPaise), rupees(p.taxTotalPaise), rupees(p.totalPaise), rupees(p.receivedValuePaise), d(p.expectedDate, tz)],
  },
};

export const MAX_EXPORT_ROWS = 100_000;

/**
 * Streams rows from a cursor (constant memory) into CSV or XLSX. Every text cell
 * is passed through safeCell() to neutralize spreadsheet formula injection.
 */
export async function buildExport(params: { type: string; format: 'csv' | 'xlsx'; from?: string; to?: string }, tz: string): Promise<{ buffer: Buffer; rows: number }> {
  const def = DEFS[params.type];
  if (!def) throw new Error(`Unknown export type ${params.type}`);
  const filter: Record<string, unknown> = {};
  if (def.dateField && (params.from || params.to)) {
    filter[def.dateField] = {
      ...(params.from ? { $gte: startOfDayInTz(params.from, tz) } : {}),
      ...(params.to ? { $lt: startOfDayInTz(addDaysYmd(params.to, 1), tz) } : {}),
    };
  }
  let query = def.model.find(filter).sort(def.sort).limit(MAX_EXPORT_ROWS).lean();
  for (const p of def.populate ?? []) query = query.populate(p.path, p.select);
  const cursor = query.cursor({ batchSize: 500 });
  let rows = 0;

  if (params.format === 'csv') {
    const parts: string[] = ['﻿' + toCsvLine(def.headers)];
    for await (const doc of cursor) {
      parts.push(toCsvLine(def.map(doc, tz)));
      rows++;
    }
    return { buffer: Buffer.from(parts.join('\r\n'), 'utf8'), rows };
  }

  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true });
  const ws = wb.addWorksheet(params.type);
  ws.addRow(def.headers).font = { bold: true };
  for await (const doc of cursor) {
    ws.addRow(def.map(doc, tz).map(safeCell)).commit();
    rows++;
  }
  ws.commit();
  await wb.commit();
  return { buffer: Buffer.concat(chunks), rows };
}
