import { Router } from 'express';
import type { Model } from 'mongoose';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import type { Permission } from '../../config/permissions';
import { Company } from '../../models/Company';
import { Driver } from '../../models/Driver';
import { Lead } from '../../models/Lead';
import { Quotation } from '../../models/Quotation';
import { Trip } from '../../models/Trip';
import { Vehicle } from '../../models/Vehicle';
import { PurchaseOrder } from '../../models/PurchaseOrder';
import { StockItem } from '../../models/StockItem';
import { Supplier } from '../../models/Supplier';
import { TripExpense } from '../../models/TripExpense';

/** Resources whose list pages show status counts; each is backed by an index that leads with `status`. */
const RESOURCES: Record<string, { model: Model<any>; permission: Permission }> = { // eslint-disable-line @typescript-eslint/no-explicit-any
  companies: { model: Company, permission: 'companies.view' },
  leads: { model: Lead, permission: 'leads.view' },
  quotations: { model: Quotation, permission: 'quotations.view' },
  trips: { model: Trip, permission: 'trips.view' },
  vehicles: { model: Vehicle, permission: 'vehicles.view' },
  drivers: { model: Driver, permission: 'drivers.view' },
  purchase_orders: { model: PurchaseOrder, permission: 'purchases.view' },
  trip_expenses: { model: TripExpense, permission: 'expenses.view' },
  stock_items: { model: StockItem, permission: 'inventory.view' },
  suppliers: { model: Supplier, permission: 'purchases.view' },
};

export const statsRouter = Router();

/** Counts per status for one list page's filter tabs: one grouped query over the status index, uncached so counts move right after a write. */
statsRouter.get(
  '/:resource/status-counts',
  validate({ params: z.object({ resource: z.enum(Object.keys(RESOURCES) as [string, ...string[]]) }).strict() }),
  asyncHandler(async (req, res) => {
    const { model, permission } = RESOURCES[req.params.resource];
    if (!req.user!.permissions.includes(permission)) throw AppError.forbidden();
    const rows: { _id: string; count: number }[] = await model.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    const counts = Object.fromEntries(rows.map((r) => [r._id, r.count]));
    const data = { counts, total: rows.reduce((s, r) => s + r.count, 0) };
    res.json(data);
  }),
);
