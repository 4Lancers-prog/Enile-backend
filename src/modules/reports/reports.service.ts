import { AppError, ErrorCodes } from '../../lib/errors';
import { addDaysYmd, diffDaysYmd, startOfDayInTz } from '../../lib/time';
import { Quotation } from '../../models/Quotation';
import { Trip } from '../../models/Trip';
import { getSettings } from '../../services/settings.service';

export async function resolveRange(from: string, to: string) {
  const settings = await getSettings();
  const days = diffDaysYmd(from, to) + 1;
  if (days > settings.reports.maxRangeDays) {
    throw AppError.unprocessable(ErrorCodes.REPORT_RANGE_TOO_LARGE, `Choose a range of ${settings.reports.maxRangeDays} days or less, or use Export for longer periods.`, [
      { field: 'to', code: 'RANGE_TOO_LARGE' },
    ]);
  }
  const tz = settings.timezone;
  return { tz, start: startOfDayInTz(from, tz), end: startOfDayInTz(addDaysYmd(to, 1), tz), days };
}

/**
 * Daily operations report grouped by business-timezone day (manual 4.7).
 * Definitions: "planned" = trips by planned start; "delivered" = trips by
 * server delivery time; quotations by issue date (issued or later states).
 */
export async function dailyReport(from: string, to: string) {
  const { tz, start, end } = await resolveRange(from, to);
  const dayOf = (field: string) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: tz } });

  const [planned, delivered, quotations] = await Promise.all([
    Trip.aggregate([
      { $match: { plannedStart: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: dayOf('$plannedStart'),
          planned: { $sum: 1 },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          plannedLitres: { $sum: '$plannedQuantityLitres' },
        },
      },
    ]),
    Trip.aggregate([
      { $match: { status: 'delivered', 'delivery.deliveredAt': { $gte: start, $lt: end } } },
      {
        $group: {
          _id: dayOf('$delivery.deliveredAt'),
          delivered: { $sum: 1 },
          deliveredLitres: { $sum: '$delivery.receivedQuantityLitres' },
          shortageLitres: { $sum: '$delivery.shortageLitres' },
          outOfTolerance: { $sum: { $cond: ['$delivery.withinTolerance', 0, 1] } },
        },
      },
    ]),
    Quotation.aggregate([
      { $match: { issueDate: { $gte: start, $lt: end } } },
      { $group: { _id: dayOf('$issueDate'), issued: { $sum: 1 }, issuedValuePaise: { $sum: '$totalPaise' } } },
    ]),
  ]);

  const rows = new Map<string, Record<string, number | string>>();
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) {
    rows.set(d, { date: d, planned: 0, cancelled: 0, plannedLitres: 0, delivered: 0, deliveredLitres: 0, shortageLitres: 0, outOfTolerance: 0, issued: 0, issuedValuePaise: 0 });
  }
  for (const set of [planned, delivered, quotations]) {
    for (const r of set as { _id: string }[]) {
      const row = rows.get(r._id);
      if (row) Object.assign(row, { ...r, _id: undefined, date: r._id });
    }
  }
  const items = [...rows.values()].map(({ _id, ...r }) => r);
  const totals = items.reduce<Record<string, number>>((acc, r) => {
    for (const [k, v] of Object.entries(r)) if (typeof v === 'number') acc[k] = Math.round(((acc[k] ?? 0) + v) * 1000) / 1000;
    return acc;
  }, {});
  return { from, to, timezone: tz, items, totals };
}

/** Quoted vs won vs delivered (enabled by the trip → quotation link). */
export async function conversionReport(from: string, to: string) {
  const { start, end } = await resolveRange(from, to);
  const [byStatus, delivered] = await Promise.all([
    Quotation.aggregate([
      { $match: { issueDate: { $gte: start, $lt: end } } },
      { $group: { _id: '$status', count: { $sum: 1 }, valuePaise: { $sum: '$totalPaise' } } },
      { $sort: { _id: 1 } },
    ]),
    Trip.aggregate([
      { $match: { quotationId: { $ne: null }, status: 'delivered', 'delivery.deliveredAt': { $gte: start, $lt: end } } },
      { $group: { _id: null, trips: { $sum: 1 }, litres: { $sum: '$delivery.receivedQuantityLitres' }, quotations: { $addToSet: '$quotationId' } } },
      { $project: { _id: 0, trips: 1, litres: 1, quotations: { $size: '$quotations' } } },
    ]),
  ]);
  return { from, to, byStatus, delivered: delivered[0] ?? { trips: 0, litres: 0, quotations: 0 } };
}
