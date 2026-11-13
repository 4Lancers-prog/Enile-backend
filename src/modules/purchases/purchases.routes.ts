import { Router } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';
import { PO_PREFIX } from '../../config/constants';
import { asyncHandler } from '../../lib/asyncHandler';
import { loadForUpdate, withVersion } from '../../lib/crud';
import { AppError, ErrorCodes } from '../../lib/errors';
import { withLocks } from '../../lib/locks';
import { escapeRegex } from '../../lib/normalize';
import { paginate } from '../../lib/pagination';
import { idParams } from '../../lib/schemas';
import { financialYear, startOfDayInTz, todayYmd } from '../../lib/time';
import { authorize } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { nextSequence } from '../../models/Counter';
import { PurchaseOrder } from '../../models/PurchaseOrder';
import { StockItem } from '../../models/StockItem';
import { Supplier } from '../../models/Supplier';
import { audit } from '../../services/audit.service';
import { getSettings } from '../../services/settings.service';
import { applyMovement } from '../inventory/inventory.service';
import { createPoBody, listPoQuery, prefillQuery, reasonBody, receiveBody, updatePoBody, versionBody } from './purchases.schema';
import { priceLines, receivedValue, unitCost, type LineIn } from './purchases.service';

export const purchasesRouter = Router();

const statusError = (from: string, action: string) =>
  AppError.unprocessable(ErrorCodes.PO_INVALID_STATUS_TRANSITION, `A ${from.replace('_', ' ')} purchase order cannot be ${action}.`);

async function activeSupplier(id: string) {
  const s = await Supplier.findById(id).select('name gstin status').lean();
  if (!s) throw AppError.badRequest('Supplier not found.', [{ field: 'supplierId', code: 'NOT_FOUND' }]);
  if (s.status !== 'active') throw AppError.badRequest(`${s.name} is inactive. Reactivate the supplier first.`, [{ field: 'supplierId', code: 'INACTIVE' }]);
  return s;
}

async function loadItems(lines: LineIn[]) {
  const items = await StockItem.find({ _id: { $in: lines.map((l) => l.itemId) } }).select('name unit status').lean();
  const map = new Map(items.map((i) => [String(i._id), i]));
  lines.forEach((l, i) => {
    const item = map.get(l.itemId);
    if (!item) throw AppError.badRequest('An item on this order no longer exists.', [{ field: `lines.${i}.itemId`, code: 'NOT_FOUND' }]);
    if (item.status !== 'active') throw AppError.badRequest(`${item.name} is inactive.`, [{ field: `lines.${i}.itemId`, code: 'INACTIVE' }]);
  });
  return map;
}

purchasesRouter.get(
  '/',
  authorize('purchases.view'),
  validate({ query: listPoQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, status, supplierId, itemId } = req.query as unknown as z.infer<typeof listPoQuery>;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (supplierId) filter.supplierId = supplierId;
    if (itemId) filter['lines.itemId'] = itemId;
    if (q) filter.$or = [{ poNumber: new RegExp(escapeRegex(q.toUpperCase())) }, { 'supplierSnapshot.name': new RegExp(escapeRegex(q), 'i') }];
    const result = await paginate(PurchaseOrder, { filter, page, limit, sort: { orderDate: -1, _id: -1 }, projection: '-receipts -notes' });
    res.json({ ...result, items: (result.items as { __v?: number }[]).map(withVersion) });
  }),
);

/**
 * What the "New purchase order" form can fill in by itself: the supplier's
 * last order (items, rates, GST), last rates for every item, and items at or
 * below their reorder level with a suggested quantity that tops them back up
 * to twice the reorder level after counting stock already on order.
 */
purchasesRouter.get(
  '/prefill',
  authorize('purchases.view'),
  validate({ query: prefillQuery }),
  asyncHandler(async (req, res) => {
    const { supplierId } = req.query as unknown as z.infer<typeof prefillQuery>;
    const [last, low, onOrder] = await Promise.all([
      supplierId ? PurchaseOrder.findOne({ supplierId, status: { $ne: 'cancelled' } }).sort({ orderDate: -1 }).select('poNumber orderDate lines deliverTo').lean() : null,
      StockItem.find({ status: 'active', $expr: { $lte: ['$onHandQty', '$reorderLevel'] }, reorderLevel: { $gt: 0 } })
        .select('itemCode name unit onHandQty reorderLevel lastPurchaseRatePaise lastSupplierId')
        .limit(50)
        .lean(),
      PurchaseOrder.aggregate<{ _id: Types.ObjectId; qty: number }>([
        { $match: { status: { $in: ['draft', 'issued', 'partially_received'] } } },
        { $unwind: '$lines' },
        { $group: { _id: '$lines.itemId', qty: { $sum: { $subtract: ['$lines.quantity', '$lines.receivedQty'] } } } },
      ]),
    ]);
    const ordered = new Map(onOrder.map((o) => [String(o._id), o.qty]));
    const supplier = supplierId ? await Supplier.findById(supplierId).select('name gstin paymentTermsDays address status').lean() : null;
    res.json({
      supplier,
      lastOrder: last,
      reorder: low
        .map((i) => ({ ...i, onOrderQty: ordered.get(String(i._id)) ?? 0, suggestedQty: Math.max(0, i.reorderLevel * 2 - i.onHandQty - (ordered.get(String(i._id)) ?? 0)) }))
        .filter((i) => i.suggestedQty > 0)
        .sort((a, b) => Number(!!supplierId && String(b.lastSupplierId) === supplierId) - Number(!!supplierId && String(a.lastSupplierId) === supplierId)),
    });
  }),
);

purchasesRouter.get(
  '/:id',
  authorize('purchases.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const po = await PurchaseOrder.findById(req.params.id).populate('receipts.receivedBy', 'name').populate('createdBy', 'name').lean();
    if (!po) throw AppError.notFound('Purchase order');
    const stock = await StockItem.find({ _id: { $in: po.lines.map((l) => l.itemId) } }).select('onHandQty').lean();
    const onHand = new Map(stock.map((s) => [String(s._id), s.onHandQty]));
    res.json({ ...withVersion(po), lines: po.lines.map((l) => ({ ...l, onHandQty: onHand.get(String(l.itemId)) ?? 0 })) });
  }),
);

purchasesRouter.post(
  '/',
  authorize('purchases.manage'),
  validate({ body: createPoBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createPoBody>;
    const { timezone } = await getSettings();
    const [supplier, items] = await Promise.all([activeSupplier(body.supplierId), loadItems(body.lines)]);
    const priced = priceLines(body.lines, items);
    const orderDate = startOfDayInTz(body.orderDate, timezone);
    const seq = await nextSequence(`po:${financialYear(orderDate, timezone)}`);
    const po = await PurchaseOrder.create({
      poNumber: `${PO_PREFIX}/${financialYear(orderDate, timezone)}/${String(seq).padStart(4, '0')}`,
      supplierId: supplier._id,
      supplierSnapshot: { name: supplier.name, gstin: supplier.gstin },
      orderDate,
      expectedDate: body.expectedDate ? startOfDayInTz(body.expectedDate, timezone) : null,
      deliverTo: body.deliverTo,
      notes: body.notes,
      ...priced,
      status: body.issue ? 'issued' : 'draft',
      issuedAt: body.issue ? new Date() : null,
      issuedBy: body.issue ? req.user!.id : null,
      createdBy: req.user!.id,
    });
    await audit(req, { action: body.issue ? 'po.create_issue' : 'po.create', entityType: 'purchase_order', entityId: String(po._id) });
    res.status(201).json(withVersion(po.toObject()));
  }),
);

purchasesRouter.patch(
  '/:id',
  authorize('purchases.manage'),
  validate({ params: idParams, body: updatePoBody }),
  asyncHandler(async (req, res) => {
    const { version, ...body } = req.body as z.infer<typeof updatePoBody>;
    const po = await loadForUpdate(PurchaseOrder, req.params.id, version, 'Purchase order');
    if (po.status !== 'draft') throw statusError(po.status, 'edited (only drafts can change)');
    const { timezone } = await getSettings();
    if (body.supplierId) {
      const s = await activeSupplier(body.supplierId);
      po.set({ supplierId: s._id, supplierSnapshot: { name: s.name, gstin: s.gstin } });
    }
    if (body.lines) po.set(priceLines(body.lines, await loadItems(body.lines)));
    if (body.orderDate) po.orderDate = startOfDayInTz(body.orderDate, timezone);
    if (body.expectedDate !== undefined) po.expectedDate = body.expectedDate ? startOfDayInTz(body.expectedDate, timezone) : null;
    if (body.deliverTo !== undefined) po.deliverTo = body.deliverTo;
    if (body.notes !== undefined) po.notes = body.notes;
    po.updatedBy = req.user!.id as never;
    await po.save();
    await audit(req, { action: 'po.update', entityType: 'purchase_order', entityId: String(po._id), changedFields: Object.keys(body) });
    res.json(withVersion(po.toObject()));
  }),
);

purchasesRouter.post(
  '/:id/issue',
  authorize('purchases.manage'),
  validate({ params: idParams, body: versionBody }),
  asyncHandler(async (req, res) => {
    const po = await loadForUpdate(PurchaseOrder, req.params.id, req.body.version, 'Purchase order');
    if (po.status !== 'draft') throw statusError(po.status, 'issued');
    await activeSupplier(String(po.supplierId));
    await loadItems(po.lines.map((l) => ({ itemId: String(l.itemId), quantity: l.quantity, ratePaise: l.ratePaise, taxRateBps: l.taxRateBps })));
    po.set({ status: 'issued', issuedAt: new Date(), issuedBy: req.user!.id, updatedBy: req.user!.id });
    await po.save();
    await audit(req, { action: 'po.issue', entityType: 'purchase_order', entityId: String(po._id) });
    res.json(withVersion(po.toObject()));
  }),
);

/**
 * Goods received note. Locked per order so two people cannot book the same
 * delivery twice; each line is capped at what is still outstanding. Stock and
 * average cost update immediately.
 */
purchasesRouter.post(
  '/:id/receive',
  authorize('purchases.manage'),
  validate({ params: idParams, body: receiveBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof receiveBody>;
    const { timezone } = await getSettings();
    if (body.receivedAt > todayYmd(timezone)) throw AppError.badRequest('The receipt date cannot be in the future.', [{ field: 'receivedAt', code: 'FUTURE' }]);
    const result = await withLocks([`po:${req.params.id}`], async () => {
      const po = await loadForUpdate(PurchaseOrder, req.params.id, body.version, 'Purchase order');
      if (!['issued', 'partially_received'].includes(po.status)) throw statusError(po.status, 'received against');
      const receivedAt = startOfDayInTz(body.receivedAt, timezone);
      if (receivedAt < po.orderDate) {
        throw AppError.badRequest('Goods cannot be received before the order date.', [{ field: 'receivedAt', code: 'BEFORE_ORDER' }]);
      }
      const byItem = new Map(po.lines.map((l) => [String(l.itemId), l]));
      const take = body.lines.filter((l) => l.quantity > 0);
      take.forEach((l, i) => {
        const line = byItem.get(l.itemId);
        if (!line) throw AppError.badRequest('That item is not on this purchase order.', [{ field: `lines.${i}.itemId`, code: 'NOT_ON_ORDER' }]);
        const left = +(line.quantity - line.receivedQty).toFixed(3);
        if (l.quantity > left) {
          throw AppError.unprocessable(ErrorCodes.PO_OVER_RECEIPT, `Only ${left} ${line.unit} of ${line.itemName} is still due on this order.`, [{ field: `lines.${i}.quantity`, code: 'OVER_RECEIPT' }]);
        }
      });
      const receiptId = new Types.ObjectId();
      let value = 0;
      for (const l of take) {
        const line = byItem.get(l.itemId)!;
        await applyMovement({ itemId: line.itemId, type: 'purchase_receipt', quantity: l.quantity, unitCostPaise: unitCost(line), date: receivedAt, purchaseOrderId: po._id, poNumber: po.poNumber, reference: body.invoiceNumber, userId: req.user!.id });
        line.receivedQty = +(line.receivedQty + l.quantity).toFixed(3);
        value += receivedValue(line, l.quantity);
      }
      await StockItem.updateMany({ _id: { $in: take.map((l) => l.itemId) } }, { $set: { lastSupplierId: po.supplierId } });
      po.receipts.push({ _id: receiptId, receivedAt, receivedBy: req.user!.id as never, invoiceNumber: body.invoiceNumber, note: body.note, lines: take.map((l) => ({ itemId: new Types.ObjectId(l.itemId), quantity: l.quantity })) });
      po.receivedValuePaise += value;
      po.status = po.lines.every((l) => l.receivedQty >= l.quantity) ? 'received' : 'partially_received';
      po.markModified('lines');
      po.updatedBy = req.user!.id as never;
      await po.save();
      return po;
    });
    await audit(req, { action: 'po.receive', entityType: 'purchase_order', entityId: String(result._id), meta: { invoiceNumber: body.invoiceNumber, lines: body.lines } });
    res.json(withVersion(result.toObject()));
  }),
);

purchasesRouter.post(
  '/:id/cancel',
  authorize('purchases.manage'),
  validate({ params: idParams, body: reasonBody }),
  asyncHandler(async (req, res) => {
    const po = await loadForUpdate(PurchaseOrder, req.params.id, req.body.version, 'Purchase order');
    if (!['draft', 'issued'].includes(po.status) || po.receipts.length) throw statusError(po.status, 'cancelled once goods are received; close it short instead');
    po.set({ status: 'cancelled', closeReason: req.body.reason, updatedBy: req.user!.id });
    await po.save();
    await audit(req, { action: 'po.cancel', entityType: 'purchase_order', entityId: String(po._id), meta: { reason: req.body.reason } });
    res.json(withVersion(po.toObject()));
  }),
);

/** Short-close a partly received order: the rest will not be delivered. */
purchasesRouter.post(
  '/:id/close',
  authorize('purchases.manage'),
  validate({ params: idParams, body: reasonBody }),
  asyncHandler(async (req, res) => {
    const po = await loadForUpdate(PurchaseOrder, req.params.id, req.body.version, 'Purchase order');
    if (po.status !== 'partially_received') throw statusError(po.status, 'closed short');
    po.set({ status: 'closed', closeReason: req.body.reason, updatedBy: req.user!.id });
    await po.save();
    await audit(req, { action: 'po.close', entityType: 'purchase_order', entityId: String(po._id), meta: { reason: req.body.reason } });
    res.json(withVersion(po.toObject()));
  }),
);
