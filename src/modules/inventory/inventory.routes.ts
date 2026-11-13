import { Router } from 'express';
import type { z } from 'zod';
import { PO_OPEN_STATUS } from '../../config/constants';
import { asyncHandler } from '../../lib/asyncHandler';
import { loadForUpdate, withVersion } from '../../lib/crud';
import { AppError, ErrorCodes, isDuplicateKeyError } from '../../lib/errors';
import { escapeRegex, normalizeName } from '../../lib/normalize';
import { paginate } from '../../lib/pagination';
import { idParams } from '../../lib/schemas';
import { addDaysYmd, startOfDayInTz, todayYmd } from '../../lib/time';
import { authorize } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { nextSequence } from '../../models/Counter';
import { PurchaseOrder } from '../../models/PurchaseOrder';
import { StockItem, type IStockItem } from '../../models/StockItem';
import { StockMovement } from '../../models/StockMovement';
import { Supplier } from '../../models/Supplier';
import { Trip } from '../../models/Trip';
import { Vehicle } from '../../models/Vehicle';
import { audit, diffFields } from '../../services/audit.service';
import { getSettings } from '../../services/settings.service';
import {
  adjustBody,
  createItemBody,
  createSupplierBody,
  issueBody,
  listItemsQuery,
  listMovementsQuery,
  listSuppliersQuery,
  updateItemBody,
  updateSupplierBody,
} from './inventory.schema';
import { applyMovement } from './inventory.service';

export const inventoryRouter = Router();

const dup = (err: unknown, what: string) => {
  if (isDuplicateKeyError(err)) throw AppError.conflict(ErrorCodes.DUPLICATE_RECORD, `${what} already exists.`, undefined, [{ field: 'name', code: 'DUPLICATE', message: `${what} already exists.` }]);
  throw err;
};

/** Quantity still to arrive on open purchase orders, per item. */
async function onOrderByItem(itemIds?: unknown[]) {
  const rows = await PurchaseOrder.aggregate<{ _id: unknown; qty: number }>([
    { $match: { status: { $in: ['issued', 'partially_received'] }, ...(itemIds ? { 'lines.itemId': { $in: itemIds } } : {}) } },
    { $unwind: '$lines' },
    ...(itemIds ? [{ $match: { 'lines.itemId': { $in: itemIds } } }] : []),
    { $group: { _id: '$lines.itemId', qty: { $sum: { $subtract: ['$lines.quantity', '$lines.receivedQty'] } } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.qty]));
}

/* ------------------------------- Summary ------------------------------- */

inventoryRouter.get(
  '/summary',
  authorize('inventory.view'),
  asyncHandler(async (_req, res) => {
    const [stock, openPos] = await Promise.all([
      StockItem.aggregate([
        { $match: { status: 'active' } },
        {
          $group: {
            _id: null,
            items: { $sum: 1 },
            valuePaise: { $sum: { $multiply: ['$onHandQty', '$avgCostPaise'] } },
            low: { $sum: { $cond: [{ $and: [{ $gt: ['$onHandQty', 0] }, { $lte: ['$onHandQty', '$reorderLevel'] }] }, 1, 0] } },
            out: { $sum: { $cond: [{ $lte: ['$onHandQty', 0] }, 1, 0] } },
          },
        },
      ]),
      PurchaseOrder.aggregate([
        { $match: { status: { $in: ['issued', 'partially_received'] } } },
        { $group: { _id: null, count: { $sum: 1 }, valuePaise: { $sum: { $subtract: ['$totalPaise', '$receivedValuePaise'] } } } },
      ]),
    ]);
    const s = stock[0] ?? { items: 0, valuePaise: 0, low: 0, out: 0 };
    res.json({ items: s.items, stockValuePaise: Math.round(s.valuePaise), lowStock: s.low, outOfStock: s.out, openPurchaseOrders: openPos[0]?.count ?? 0, openPoValuePaise: openPos[0]?.valuePaise ?? 0 });
  }),
);

/* -------------------------------- Items -------------------------------- */

inventoryRouter.get(
  '/items',
  authorize('inventory.view'),
  validate({ query: listItemsQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, category, status, stock } = req.query as unknown as z.infer<typeof listItemsQuery>;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (stock === 'out') filter.onHandQty = { $lte: 0 };
    if (stock === 'low') filter.$expr = { $and: [{ $gt: ['$onHandQty', 0] }, { $lte: ['$onHandQty', '$reorderLevel'] }] };
    if (q) filter.$or = [{ normalizedName: new RegExp(escapeRegex(normalizeName(q))) }, { itemCode: new RegExp('^' + escapeRegex(q.toUpperCase())) }];
    const result = await paginate(StockItem, { filter, page, limit, sort: { normalizedName: 1 }, projection: '-normalizedName' });
    const items = result.items as (IStockItem & { __v?: number })[];
    const onOrder = await onOrderByItem(items.map((i) => i._id));
    res.json({ ...result, items: items.map((i) => ({ ...withVersion(i), onOrderQty: onOrder.get(String(i._id)) ?? 0 })) });
  }),
);

/** Active items for pickers, with the figures forms need to fill themselves in. */
inventoryRouter.get(
  '/items/lookup',
  authorize('inventory.view'),
  asyncHandler(async (_req, res) => {
    const items = await StockItem.find({ status: 'active' })
      .select('itemCode name unit category hsnSac onHandQty reorderLevel avgCostPaise lastPurchaseRatePaise lastSupplierId')
      .sort({ normalizedName: 1 })
      .limit(2000)
      .lean();
    res.set('Cache-Control', 'private, max-age=15').json({ items });
  }),
);

inventoryRouter.get(
  '/items/:id',
  authorize('inventory.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const item = await StockItem.findById(req.params.id).select('-normalizedName').lean();
    if (!item) throw AppError.notFound('Stock item');
    const [movements, onOrder, openPos] = await Promise.all([
      StockMovement.find({ itemId: item._id }).sort({ date: -1, _id: -1 }).limit(50).populate('vehicleId', 'registrationNumber').populate('tripId', 'tripNumber').lean(),
      onOrderByItem([item._id]),
      PurchaseOrder.find({ 'lines.itemId': item._id, status: { $in: ['issued', 'partially_received'] } }).select('poNumber status expectedDate supplierSnapshot.name').sort({ orderDate: -1 }).limit(10).lean(),
    ]);
    res.json({ ...withVersion(item), onOrderQty: onOrder.get(String(item._id)) ?? 0, movements, openPurchaseOrders: openPos });
  }),
);

inventoryRouter.post(
  '/items',
  authorize('inventory.manage'),
  validate({ body: createItemBody }),
  asyncHandler(async (req, res) => {
    const { openingQty, openingRatePaise, ...body } = req.body as z.infer<typeof createItemBody>;
    const itemCode = `ITM-${String(await nextSequence('stock-item')).padStart(4, '0')}`;
    const item = await StockItem.create({ ...body, itemCode, normalizedName: normalizeName(body.name), createdBy: req.user!.id }).catch((e) => dup(e, 'An item with this name'));
    if (openingQty > 0) {
      const { timezone } = await getSettings();
      await applyMovement({ itemId: item._id, type: 'adjustment', quantity: openingQty, unitCostPaise: openingRatePaise, date: startOfDayInTz(todayYmd(timezone), timezone), reason: 'Opening stock', userId: req.user!.id });
    }
    await audit(req, { action: 'stock_item.create', entityType: 'stock_item', entityId: String(item._id) });
    res.status(201).json(withVersion((await StockItem.findById(item._id).lean())!));
  }),
);

inventoryRouter.patch(
  '/items/:id',
  authorize('inventory.manage'),
  validate({ params: idParams, body: updateItemBody }),
  asyncHandler(async (req, res) => {
    const { version, ...patch } = req.body as z.infer<typeof updateItemBody>;
    const item = await loadForUpdate(StockItem, req.params.id, version, 'Stock item');
    if (patch.unit && patch.unit !== item.unit && (await StockMovement.exists({ itemId: item._id }))) {
      throw AppError.unprocessable(ErrorCodes.DEPENDENT_RECORDS, 'The unit cannot change once stock has moved. Create a new item instead.', [{ field: 'unit', code: 'LOCKED' }]);
    }
    if (patch.status === 'inactive' && item.status === 'active') {
      const po = await PurchaseOrder.findOne({ 'lines.itemId': item._id, status: { $in: PO_OPEN_STATUS } }).select('poNumber').lean();
      if (po) throw AppError.conflict(ErrorCodes.DEPENDENT_RECORDS, `Purchase order ${po.poNumber} still includes this item. Receive, close or cancel it first.`);
    }
    const fields: Partial<IStockItem> = { ...patch };
    if (patch.name) fields.normalizedName = normalizeName(patch.name);
    const changed = diffFields(item.toObject(), fields);
    item.set({ ...fields, updatedBy: req.user!.id });
    await item.save().catch((e) => dup(e, 'An item with this name'));
    await audit(req, { action: 'stock_item.update', entityType: 'stock_item', entityId: String(item._id), changedFields: changed });
    res.json(withVersion(item.toObject()));
  }),
);

/** Issue stock to a vehicle (and optionally a trip). Blocked when stock would go below zero. */
inventoryRouter.post(
  '/items/:id/issue',
  authorize('inventory.manage'),
  validate({ params: idParams, body: issueBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof issueBody>;
    const { timezone } = await getSettings();
    if (body.date > todayYmd(timezone)) throw AppError.badRequest('The issue date cannot be in the future.', [{ field: 'date', code: 'FUTURE' }]);
    const item = await StockItem.findById(req.params.id).select('status').lean();
    if (!item) throw AppError.notFound('Stock item');
    if (item.status !== 'active') throw AppError.unprocessable(ErrorCodes.DEPENDENT_RECORDS, 'This item is inactive. Reactivate it to issue stock.');
    let vehicleId = body.vehicleId;
    if (body.tripId) {
      const trip = await Trip.findById(body.tripId).select('vehicleId status tripNumber').lean();
      if (!trip) throw AppError.badRequest('Trip not found.', [{ field: 'tripId', code: 'NOT_FOUND' }]);
      if (trip.status === 'cancelled') throw AppError.badRequest(`Trip ${trip.tripNumber} is cancelled.`, [{ field: 'tripId', code: 'CANCELLED' }]);
      if (vehicleId && vehicleId !== String(trip.vehicleId)) throw AppError.badRequest('That trip runs on a different vehicle.', [{ field: 'vehicleId', code: 'MISMATCH' }]);
      vehicleId = String(trip.vehicleId);
    }
    if (vehicleId) {
      const v = await Vehicle.findById(vehicleId).select('status').lean();
      if (!v) throw AppError.badRequest('Vehicle not found.', [{ field: 'vehicleId', code: 'NOT_FOUND' }]);
      if (v.status === 'retired') throw AppError.badRequest('That vehicle is retired.', [{ field: 'vehicleId', code: 'RETIRED' }]);
    }
    const mv = await applyMovement({
      itemId: req.params.id,
      type: 'issue',
      quantity: -body.quantity,
      date: startOfDayInTz(body.date, timezone),
      vehicleId: vehicleId as never,
      tripId: body.tripId as never,
      reference: body.reference,
      reason: body.reason,
      userId: req.user!.id,
    });
    await audit(req, { action: 'stock.issue', entityType: 'stock_item', entityId: req.params.id, meta: { quantity: body.quantity, vehicleId, tripId: body.tripId } });
    res.status(201).json(mv.toObject());
  }),
);

/** Return unused stock from a vehicle to stores at the current average cost. */
inventoryRouter.post(
  '/items/:id/return',
  authorize('inventory.manage'),
  validate({ params: idParams, body: issueBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof issueBody>;
    const { timezone } = await getSettings();
    if (body.date > todayYmd(timezone)) throw AppError.badRequest('The return date cannot be in the future.', [{ field: 'date', code: 'FUTURE' }]);
    const mv = await applyMovement({ itemId: req.params.id, type: 'return', quantity: body.quantity, date: startOfDayInTz(body.date, timezone), vehicleId: body.vehicleId as never, tripId: body.tripId as never, reference: body.reference, reason: body.reason, userId: req.user!.id });
    await audit(req, { action: 'stock.return', entityType: 'stock_item', entityId: req.params.id, meta: { quantity: body.quantity } });
    res.status(201).json(mv.toObject());
  }),
);

/** Stock-take corrections. A reason is mandatory and the change is audited. */
inventoryRouter.post(
  '/items/:id/adjust',
  authorize('inventory.manage'),
  validate({ params: idParams, body: adjustBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof adjustBody>;
    const { timezone } = await getSettings();
    if (body.date > todayYmd(timezone)) throw AppError.badRequest('The adjustment date cannot be in the future.', [{ field: 'date', code: 'FUTURE' }]);
    const mv = await applyMovement({ itemId: req.params.id, type: 'adjustment', quantity: body.quantity, date: startOfDayInTz(body.date, timezone), reason: body.reason, userId: req.user!.id });
    await audit(req, { action: 'stock.adjust', entityType: 'stock_item', entityId: req.params.id, meta: { quantity: body.quantity, reason: body.reason } });
    res.status(201).json(mv.toObject());
  }),
);

inventoryRouter.get(
  '/movements',
  authorize('inventory.view'),
  validate({ query: listMovementsQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, itemId, vehicleId, type, from, to } = req.query as unknown as z.infer<typeof listMovementsQuery>;
    const { timezone } = await getSettings();
    const filter: Record<string, unknown> = {};
    if (itemId) filter.itemId = itemId;
    if (vehicleId) filter.vehicleId = vehicleId;
    if (type) filter.type = type;
    if (from || to) filter.date = { ...(from ? { $gte: startOfDayInTz(from, timezone) } : {}), ...(to ? { $lt: startOfDayInTz(addDaysYmd(to, 1), timezone) } : {}) };
    const result = await paginate(StockMovement, {
      filter,
      page,
      limit,
      sort: { date: -1, _id: -1 },
      populate: [
        { path: 'itemId', select: 'itemCode name unit' },
        { path: 'vehicleId', select: 'registrationNumber' },
        { path: 'tripId', select: 'tripNumber' },
        { path: 'createdBy', select: 'name' },
      ],
    });
    res.json(result);
  }),
);

/* ------------------------------ Suppliers ------------------------------ */

const toSupplierFields = (b: Partial<z.infer<typeof createSupplierBody>>) => {
  const { city, state, stateCode, ...rest } = b;
  const out: Record<string, unknown> = { ...rest };
  if (b.name) out.normalizedName = normalizeName(b.name);
  if (city !== undefined || state !== undefined || stateCode !== undefined) out.address = { city, state, stateCode: stateCode ?? (b.gstin ? b.gstin.slice(0, 2) : undefined) };
  return out;
};

inventoryRouter.get(
  '/suppliers',
  authorize('purchases.view'),
  validate({ query: listSuppliersQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, status } = req.query as unknown as z.infer<typeof listSuppliersQuery>;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (q) filter.$or = [{ normalizedName: new RegExp(escapeRegex(normalizeName(q))) }, { gstin: new RegExp('^' + escapeRegex(q.toUpperCase())) }, { supplierCode: q.toUpperCase() }];
    const result = await paginate(Supplier, { filter, page, limit, sort: { normalizedName: 1 }, projection: '-normalizedName' });
    const ids = (result.items as { _id: unknown }[]).map((s) => s._id);
    const open = await PurchaseOrder.aggregate<{ _id: unknown; count: number; valuePaise: number }>([
      { $match: { supplierId: { $in: ids }, status: { $in: ['issued', 'partially_received'] } } },
      { $group: { _id: '$supplierId', count: { $sum: 1 }, valuePaise: { $sum: { $subtract: ['$totalPaise', '$receivedValuePaise'] } } } },
    ]);
    const byId = new Map(open.map((o) => [String(o._id), o]));
    res.json({
      ...result,
      items: (result.items as { _id: unknown; __v?: number }[]).map((s) => ({ ...withVersion(s), openOrders: byId.get(String(s._id))?.count ?? 0, openValuePaise: byId.get(String(s._id))?.valuePaise ?? 0 })),
    });
  }),
);

inventoryRouter.get(
  '/suppliers/lookup',
  authorize('purchases.view'),
  asyncHandler(async (_req, res) => {
    const items = await Supplier.find({ status: 'active' }).select('supplierCode name gstin paymentTermsDays address.city').sort({ normalizedName: 1 }).limit(1000).lean();
    res.set('Cache-Control', 'private, max-age=30').json({ items });
  }),
);

inventoryRouter.post(
  '/suppliers',
  authorize('purchases.manage'),
  validate({ body: createSupplierBody }),
  asyncHandler(async (req, res) => {
    const supplierCode = `SUP-${String(await nextSequence('supplier')).padStart(4, '0')}`;
    const s = await Supplier.create({ ...toSupplierFields(req.body), supplierCode, createdBy: req.user!.id }).catch((e) => dup(e, 'A supplier with this name or GSTIN'));
    await audit(req, { action: 'supplier.create', entityType: 'supplier', entityId: String(s._id) });
    res.status(201).json(withVersion(s.toObject()));
  }),
);

inventoryRouter.patch(
  '/suppliers/:id',
  authorize('purchases.manage'),
  validate({ params: idParams, body: updateSupplierBody }),
  asyncHandler(async (req, res) => {
    const { version, status, ...patch } = req.body as z.infer<typeof updateSupplierBody>;
    const s = await loadForUpdate(Supplier, req.params.id, version, 'Supplier');
    if (status === 'inactive' && s.status === 'active') {
      const po = await PurchaseOrder.findOne({ supplierId: s._id, status: { $in: PO_OPEN_STATUS } }).select('poNumber').lean();
      if (po) throw AppError.conflict(ErrorCodes.DEPENDENT_RECORDS, `Purchase order ${po.poNumber} is still open with this supplier. Receive, close or cancel it first.`);
    }
    const fields = { ...toSupplierFields(patch), ...(status ? { status } : {}) };
    const changed = diffFields(s.toObject(), fields);
    s.set({ ...fields, updatedBy: req.user!.id });
    await s.save().catch((e) => dup(e, 'A supplier with this name or GSTIN'));
    await audit(req, { action: 'supplier.update', entityType: 'supplier', entityId: String(s._id), changedFields: changed });
    res.json(withVersion(s.toObject()));
  }),
);
