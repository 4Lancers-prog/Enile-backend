import ExcelJS from 'exceljs';
import { safeCell, toCsvLine } from '../../lib/csv';
import { ymdInTz } from '../../lib/time';

/** Columns shared by the instant download and the background export. */
export const PAYMENT_HEADERS = [
  'Payment no',
  'Payment date',
  'Employee code',
  'Driver',
  'Type',
  'Salary month',
  'Mode',
  'Reference',
  'Amount (INR)',
  'Advance recovered (INR)',
  'Gross salary (INR)',
  'Payable days',
  'Trips',
  'Paid by',
  'Status',
  'Void reason',
  'Notes',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function paymentRow(p: any, tz: string): unknown[] {
  const r = (v?: number | null) => (typeof v === 'number' ? v / 100 : '');
  return [
    p.paymentNumber,
    ymdInTz(p.paymentDate, tz),
    p.driverId?.employeeCode ?? '',
    p.driverName,
    String(p.type).replace(/_/g, ' '),
    p.salaryMonth ?? '',
    String(p.paymentMode).replace(/_/g, ' '),
    p.reference ?? '',
    r(p.amountPaise),
    r(p.advanceRecoveryPaise),
    p.salary ? r(p.salary.grossPaise) : '',
    p.salary?.payableDays ?? '',
    p.salary?.deliveredTrips ?? '',
    p.paidByName,
    p.status,
    p.voidReason ?? '',
    p.notes ?? '',
  ];
}

export async function renderTable(headers: string[], rows: unknown[][], format: 'csv' | 'xlsx', sheet: string): Promise<Buffer> {
  if (format === 'csv') return Buffer.from('﻿' + [toCsvLine(headers), ...rows.map(toCsvLine)].join('\r\n'), 'utf8');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(headers).font = { bold: true };
  rows.forEach((row) => ws.addRow(row.map(safeCell)));
  ws.columns.forEach((c) => (c.width = 16));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
