import { addDaysYmd, startOfDayInTz, todayYmd } from '../../lib/time';
import { ComplianceDocument } from '../../models/Document';
import { Driver } from '../../models/Driver';
import { Lead } from '../../models/Lead';
import { Quotation } from '../../models/Quotation';
import { Trip } from '../../models/Trip';
import { Vehicle } from '../../models/Vehicle';
import { PurchaseOrder } from '../../models/PurchaseOrder';
import { StockItem } from '../../models/StockItem';
import { TripExpense } from '../../models/TripExpense';
import { getSettings } from '../../services/settings.service';
import { expiryState } from '../../services/compliance.service';

const CACHE_MS = 15_000;
/** Daily trend length; the UI can show the last 7, 14 or 30 days of it. */
const SERIES_DAYS = 30;
let cache: { at: number; data: unknown } | null = null;

/**
 * Everything the dashboard needs in ONE response, built from parallel indexed
 * queries and cached briefly per instance (the data is not user-specific).
 */
export async function getDashboard() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const { timezone: tz } = await getSettings();
  const today = todayYmd(tz);
  const todayStart = startOfDayInTz(today, tz);
  const monthStart = startOfDayInTz(`${today.slice(0, 8)}01`, tz);
  const in30 = startOfDayInTz(addDaysYmd(today, 31), tz);
  const seriesStart = startOfDayInTz(addDaysYmd(today, -(SERIES_DAYS - 1)), tz);
  const tomorrow = startOfDayInTz(addDaysYmd(today, 1), tz);
  const dayOf = (f: string) => ({ $dateToString: { format: '%Y-%m-%d', date: f, timezone: tz } });

  const [
    activeTrips,
    monthDelivered,
    pipeline,
    pipelineCards,
    fleet,
    docsExpired,
    docsExpiring,
    driversExpiring,
    newLeads,
    plannedSeries,
    deliveredSeries,
    byProduct,
    upcomingRenewals,
    recentTrips,
  ] = await Promise.all([
    Trip.countDocuments({ status: { $in: ['planned', 'in_transit'] } }),
    Trip.aggregate([
      { $match: { status: 'delivered', 'delivery.deliveredAt': { $gte: monthStart } } },
      { $group: { _id: null, trips: { $sum: 1 }, litres: { $sum: '$delivery.receivedQuantityLitres' }, shortage: { $sum: '$delivery.shortageLitres' } } },
    ]),
    Quotation.aggregate([
      { $match: { status: { $in: ['draft', 'issued', 'accepted', 'rejected'] }, updatedAt: { $gte: startOfDayInTz(addDaysYmd(today, -90), tz) } } },
      { $group: { _id: '$status', count: { $sum: 1 }, valuePaise: { $sum: '$totalPaise' } } },
    ]),
    Quotation.aggregate([
      { $match: { status: { $in: ['draft', 'issued', 'accepted', 'rejected'] } } },
      { $sort: { updatedAt: -1 } },
      { $group: { _id: '$status', items: { $push: { _id: '$_id', quotationNumber: '$quotationNumber', companyId: '$companyId', totalPaise: '$totalPaise', validUntil: '$validUntil', subject: '$subject', updatedAt: '$updatedAt' } } } },
      { $project: { items: { $slice: ['$items', 5] } } },
      { $unwind: '$items' },
      { $lookup: { from: 'companies', localField: 'items.companyId', foreignField: '_id', as: 'company', pipeline: [{ $project: { legalName: 1 } }] } },
      { $project: { status: '$_id', item: '$items', companyName: { $first: '$company.legalName' } } },
    ]),
    Vehicle.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ComplianceDocument.countDocuments({ status: 'active', expiryDate: { $lt: todayStart } }),
    ComplianceDocument.countDocuments({ status: 'active', expiryDate: { $gte: todayStart, $lt: in30 } }),
    Driver.countDocuments({ status: 'active', licenceExpiry: { $lt: in30 } }),
    Lead.countDocuments({ status: { $in: ['new', 'contacted', 'qualified'] } }),
    Trip.aggregate([{ $match: { plannedStart: { $gte: seriesStart, $lt: tomorrow } } }, { $group: { _id: dayOf('$plannedStart'), n: { $sum: 1 } } }]),
    Trip.aggregate([
      { $match: { status: 'delivered', 'delivery.deliveredAt': { $gte: seriesStart, $lt: tomorrow } } },
      { $group: { _id: dayOf('$delivery.deliveredAt'), n: { $sum: 1 }, litres: { $sum: '$delivery.receivedQuantityLitres' } } },
    ]),
    Trip.aggregate([
      { $match: { status: 'delivered', 'delivery.deliveredAt': { $gte: monthStart } } },
      { $group: { _id: '$product', litres: { $sum: '$delivery.receivedQuantityLitres' } } },
      { $sort: { litres: -1 } },
    ]),
    ComplianceDocument.aggregate([
      { $match: { status: 'active', expiryDate: { $ne: null, $lt: in30 } } },
      { $sort: { expiryDate: 1 } },
      { $limit: 8 },
      { $lookup: { from: 'vehicles', localField: 'ownerId', foreignField: '_id', as: 'v', pipeline: [{ $project: { registrationNumber: 1 } }] } },
      { $lookup: { from: 'drivers', localField: 'ownerId', foreignField: '_id', as: 'd', pipeline: [{ $project: { name: 1 } }] } },
      { $project: { documentType: 1, expiryDate: 1, ownerType: 1, ownerId: 1, ownerLabel: { $ifNull: [{ $first: '$v.registrationNumber' }, { $first: '$d.name' }] } } },
    ]),
    Trip.find({})
      .sort({ plannedStart: -1 })
      .limit(8)
      .select('tripNumber status product plannedQuantityLitres plannedStart companyId vehicleId')
      .populate([
        { path: 'companyId', select: 'legalName' },
        { path: 'vehicleId', select: 'registrationNumber' },
      ])
      .lean(),
  ]);

  const [lowStockItems, pendingExpenses, openPurchaseOrders, monthExpenses] = await Promise.all([
    StockItem.countDocuments({ status: 'active', $expr: { $lte: ['$onHandQty', '$reorderLevel'] } }),
    TripExpense.countDocuments({ status: 'pending' }),
    PurchaseOrder.countDocuments({ status: { $in: ['issued', 'partially_received'] } }),
    TripExpense.aggregate<{ amount: number }>([{ $match: { status: { $ne: 'rejected' }, expenseDate: { $gte: monthStart } } }, { $group: { _id: null, amount: { $sum: '$amountPaise' } } }]),
  ]);

  const planned = new Map((plannedSeries as { _id: string; n: number }[]).map((r) => [r._id, r.n]));
  const delivered = new Map((deliveredSeries as { _id: string; n: number; litres: number }[]).map((r) => [r._id, r]));
  const series = Array.from({ length: SERIES_DAYS }, (_, i) => {
    const d = addDaysYmd(today, i - (SERIES_DAYS - 1));
    return { date: d, planned: planned.get(d) ?? 0, delivered: delivered.get(d)?.n ?? 0, litres: delivered.get(d)?.litres ?? 0 };
  });
  const fleetMap = Object.fromEntries((fleet as { _id: string; count: number }[]).map((f) => [f._id, f.count]));
  const p = Object.fromEntries((pipeline as { _id: string; count: number; valuePaise: number }[]).map((r) => [r._id, { count: r.count, valuePaise: r.valuePaise }]));
  const md = (monthDelivered as { trips: number; litres: number; shortage: number }[])[0] ?? { trips: 0, litres: 0, shortage: 0 };

  const data = {
    generatedAt: new Date(),
    metrics: {
      activeTrips,
      deliveredThisMonth: md.trips,
      litresThisMonth: md.litres,
      shortageThisMonth: md.shortage,
      openQuotationValuePaise: p.issued?.valuePaise ?? 0,
      openQuotations: p.issued?.count ?? 0,
      wonValuePaise: p.accepted?.valuePaise ?? 0,
      docsExpired,
      docsExpiring,
      driversExpiring,
      openLeads: newLeads,
      lowStockItems,
      pendingExpenses,
      openPurchaseOrders,
      expensesThisMonthPaise: monthExpenses[0]?.amount ?? 0,
      fleet: { total: Object.values(fleetMap).reduce((a, b) => a + b, 0), ...fleetMap },
    },
    pipeline: {
      summary: p,
      cards: pipelineCards,
    },
    series,
    byProduct,
    upcomingRenewals: (upcomingRenewals as { expiryDate: Date }[]).map((r) => ({ ...r, expiry: expiryState(r.expiryDate, tz) })),
    recentTrips,
  };
  cache = { at: Date.now(), data };
  return data;
}

export function invalidateDashboard() {
  cache = null;
}
