/**
 * Seeds the first administrator (always) and, with --demo, realistic sample data
 * for local development. Idempotent: existing users/records are left alone.
 *   npm run seed            -> admin only
 *   npm run seed -- --demo  -> admin + 4 users + sample fleet, customers, quotes, trips
 */
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../config/db';
import { env } from '../config/env';
import { PAYMENT_PREFIX, PO_PREFIX, type Role } from '../config/constants';
import { gstinChecksumChar } from '../lib/gstin';
import { logger } from '../lib/logger';
import { computeQuotation } from '../lib/money';
import { normalizeLicence, normalizeName, normalizePhone, normalizeRegistration } from '../lib/normalize';
import { addDaysYmd, financialYear, startOfDayInTz, todayYmd } from '../lib/time';
import { hashPassword } from '../modules/auth/password';
import { Company } from '../models/Company';
import { nextSequence } from '../models/Counter';
import { ComplianceDocument } from '../models/Document';
import { Driver } from '../models/Driver';
import { Lead } from '../models/Lead';
import { Quotation } from '../models/Quotation';
import { Trip } from '../models/Trip';
import { User } from '../models/User';
import { Vehicle } from '../models/Vehicle';
import { DriverPayment } from '../models/DriverPayment';
import { PurchaseOrder } from '../models/PurchaseOrder';
import { StockItem } from '../models/StockItem';
import { Supplier } from '../models/Supplier';
import { TripExpense } from '../models/TripExpense';
import { applyMovement } from '../modules/inventory/inventory.service';
import { getSettings } from '../services/settings.service';

const demo = process.argv.includes('--demo');

async function ensureUser(name: string, email: string, role: Role) {
  const existing = await User.findOne({ email });
  if (existing) return existing;
  return User.create({ name, email, role, passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD), mustChangePassword: true });
}

const pick = <T>(arr: readonly T[], i: number) => arr[i % arr.length];

async function seedDemo(adminId: Types.ObjectId) {
  if (await Vehicle.exists({})) {
    logger.info('demo data already present, skipping');
    return;
  }
  const settings = await getSettings();
  const tz = settings.timezone;
  const today = todayYmd(tz);
  const day = (offset: number, hour = 6) => new Date(startOfDayInTz(addDaysYmd(today, offset), tz).getTime() + hour * 3_600_000);

  // Companies (GSTINs below pass the checksum).
  const companyRows = [
    ['Bharat Fuel Distributors', '27AAACB1234C1Z1', 'Pune', '27', 'dealer'],
    ['Sahyadri Industrial Gases', '27AAGCS5678D1Z9', 'Nashik', '27', 'industrial'],
    ['Konkan Highway Retail Outlets', '27AAFCK4321E1ZP', 'Ratnagiri', '27', 'dealer'],
    ['Deccan Aviation Services', '36AAECD8765F1Z4', 'Hyderabad', '36', 'industrial'],
    ['Narmada Agro Processing', '24AAGCN2468G1ZM', 'Vadodara', '24', 'industrial'],
  ] as const;
  const companies = [];
  for (const [name, g, city, stateCode, type] of companyRows) {
    const gstin = g.slice(0, 14) + gstinChecksumChar(g.slice(0, 14));
    const seq = await nextSequence('company');
    const phone = `98${String(20000000 + seq * 7919).slice(0, 8)}`;
    companies.push(
      await Company.create({
        companyCode: `CMP-${String(seq).padStart(5, '0')}`,
        legalName: name,
        normalizedName: normalizeName(name),
        customerType: type,
        gstin,
        pan: gstin.slice(2, 12),
        billingAddress: { line1: 'Plot 12, MIDC Area', city, stateCode, state: city === 'Hyderabad' ? 'Telangana' : city === 'Vadodara' ? 'Gujarat' : 'Maharashtra', pincode: '411001' },
        contacts: [{ name: 'Purchase Manager', phone, normalizedPhone: normalizePhone(phone), email: `purchase${seq}@example.com`, isPrimary: true }],
        phones: [normalizePhone(phone)],
        creditDays: 30,
        createdBy: adminId,
      }),
    );
  }

  // Drivers
  const driverNames = ['Ramesh Patil', 'Suresh Yadav', 'Anil Shinde', 'Vijay Kumar', 'Mahesh Jadhav', 'Prakash Singh', 'Santosh More', 'Ganesh Pawar', 'Rajesh Gupta', 'Deepak Chavan'];
  const drivers = [];
  for (let i = 0; i < driverNames.length; i++) {
    const lic = `MH12 2015${String(1000000 + i * 3571).slice(0, 7)}`;
    const phone = `97${String(30000000 + i * 1234567).slice(0, 8)}`;
    drivers.push(
      await Driver.create({
        name: driverNames[i],
        normalizedName: normalizeName(driverNames[i]),
        phone,
        normalizedPhone: normalizePhone(phone),
        licenceNumber: lic,
        normalizedLicence: normalizeLicence(lic),
        licenceClass: 'HTV',
        licenceExpiry: startOfDayInTz(addDaysYmd(today, i === 2 ? 12 : i === 5 ? -3 : 400 + i * 30), tz),
        hazardousEndorsement: i !== 7,
        hazchemTrainingExpiry: startOfDayInTz(addDaysYmd(today, i === 4 ? 20 : 200 + i * 10), tz),
        employeeCode: `EMP-${String(await nextSequence('driver-employee')).padStart(4, '0')}`,
        joiningDate: startOfDayInTz(addDaysYmd(today, i === 9 ? -20 : -400 - i * 60), tz),
        monthlySalaryPaise: (18000 + (i % 4) * 1500) * 100,
        tripAllowancePaise: 30000,
        salaryDay: 7,
        advanceRecoveryPaise: 200000,
        bank: i % 3 === 2 ? undefined : { accountName: driverNames[i], accountNumber: `3200${String(10000000 + i * 7331)}`, ifsc: 'SBIN0001234', bankName: 'State Bank of India' },
        upiId: `${driverNames[i].split(' ')[0].toLowerCase()}@okaxis`,
        createdBy: adminId,
      }),
    );
  }

  // Vehicles + compliance documents
  const vehicles = [];
  const docTypes = ['RC', 'INSURANCE', 'FITNESS', 'PUC', 'PESO_LICENCE', 'CALIBRATION_CERT', 'NATIONAL_PERMIT'] as const;
  for (let i = 0; i < 12; i++) {
    const reg = `MH 12 ${pick(['AB', 'CD', 'EF', 'GH'], i)} ${String(4100 + i * 37)}`;
    const cap = pick([12000, 20000, 24000, 12000], i);
    const comps = cap === 24000 ? 4 : cap === 20000 ? 4 : 3;
    const v = await Vehicle.create({
      registrationNumber: reg,
      normalizedRegistration: normalizeRegistration(reg),
      vehicleType: 'tanker_truck',
      make: pick(['Tata', 'Ashok Leyland', 'BharatBenz'], i),
      model: pick(['Signa 4825', 'U-3518', '2823C'], i),
      manufactureYear: 2016 + (i % 8),
      capacityLitres: cap,
      compartments: Array.from({ length: comps }, (_, c) => ({ number: c + 1, capacityLitres: cap / comps })),
      status: i === 11 ? 'in_service' : 'active',
      assignedDriverId: drivers[i % drivers.length]._id,
      createdBy: adminId,
    });
    vehicles.push(v);
    for (let t = 0; t < docTypes.length; t++) {
      const type = docTypes[t];
      const offset = type === 'RC' ? null : (i * 41 + t * 67) % 420 - (i === 3 && type === 'INSURANCE' ? 450 : 25);
      await ComplianceDocument.create({
        ownerType: 'vehicle',
        ownerId: v._id,
        documentType: type,
        documentNumber: `${type.slice(0, 3)}-${1000 + i * 10 + t}`,
        issueDate: startOfDayInTz(addDaysYmd(today, -300), tz),
        expiryDate: offset === null ? null : startOfDayInTz(addDaysYmd(today, offset), tz),
        status: 'active',
        notes: 'Demo record (no file attached)',
        uploadedBy: adminId,
      });
    }
  }

  // Leads
  const leadRows = [
    ['Shree Ganesh Petroleum', 'referral', 'Bharat Fuel Distributors', 'new'],
    ['Malwa Transport Fuels', 'referral', 'Existing driver network', 'contacted'],
    ['Godavari Sugar Mills', 'referral', 'Sahyadri Industrial Gases', 'qualified'],
    ['Western Ghats Resorts', 'phone', '', 'lost'],
  ] as const;
  for (const [name, source, referredBy, status] of leadRows) {
    await Lead.create({
      name,
      normalizedName: normalizeName(name),
      contactPerson: 'Owner',
      phone: '9822012345',
      normalizedPhone: '9822012345',
      source,
      referredBy: referredBy || undefined,
      products: ['HSD'],
      estimatedMonthlyKl: 60,
      route: 'Loni depot → site',
      status,
      lostReason: status === 'lost' ? 'Chose a local transporter' : undefined,
      assignedTo: adminId,
      createdBy: adminId,
    });
  }

  // Quotations
  const quotes = [];
  for (let i = 0; i < 8; i++) {
    const company = companies[i % companies.length];
    const lines = [
      { description: `HSD transport, Loni depot to ${company.billingAddress.city}`, product: 'HSD' as const, quantity: 20 + i * 4, unit: 'KL' as const, ratePaise: 145000 + i * 2500 },
      { description: 'Detention charges (per day)', quantity: 1, unit: 'day' as const, ratePaise: 250000, discountPaise: i % 2 ? 50000 : 0 },
    ];
    const totals = computeQuotation(lines, { taxRateBps: 1200, intraState: company.billingAddress.stateCode === settings.business.homeStateCode, roundOffTotal: true });
    const status = pick(['issued', 'accepted', 'draft', 'issued', 'accepted', 'rejected', 'issued', 'accepted'] as const, i);
    const _id = new Types.ObjectId();
    const issueDate = status === 'draft' ? null : day(-i * 3);
    let quotationNumber: string | null = null;
    if (issueDate) {
      const fy = financialYear(issueDate, tz);
      quotationNumber = `${settings.quotation.numberPrefix}/${fy}/${String(await nextSequence(`quotation:${fy}`)).padStart(4, '0')}`;
    }
    quotes.push(
      await Quotation.create({
        _id,
        rootId: _id,
        quotationNumber,
        baseNumber: quotationNumber,
        companyId: company._id,
        companySnapshot: issueDate ? { companyCode: company.companyCode, legalName: company.legalName, gstin: company.gstin, billingAddress: company.billingAddress, stateCode: company.billingAddress.stateCode } : null,
        subject: 'Bulk petroleum transport',
        issueDate,
        validUntil: issueDate ? day(15 - i * 3, 23) : null,
        ...totals,
        taxRateBps: 1200,
        taxConfigVersion: settings.tax.configVersion,
        terms: settings.quotation.defaultTerms,
        status,
        pdf: { status: 'none' },
        createdBy: adminId,
      }),
    );
  }

  // Trips spread over the last 14 days and the next 3
  const trips = [];
  const products = ['HSD', 'MS', 'HSD', 'ATF', 'FO', 'HSD', 'MS'] as const;
  for (let i = 0; i < 30; i++) {
    const offset = -13 + Math.floor(i / 2);
    const v = vehicles[i % 11];
    const drv = drivers[(i % 11) % drivers.length];
    const start = day(offset, 5 + (i % 2) * 12);
    const end = new Date(start.getTime() + 10 * 3_600_000);
    const company = companies[i % companies.length];
    const q = quotes.find((x) => String(x.companyId) === String(company._id) && x.status === 'accepted');
    const fy = financialYear(start, tz);
    const status = offset < -1 ? (i % 9 === 0 ? 'cancelled' : 'delivered') : offset <= 0 ? 'in_transit' : 'planned';
    const planned = Math.min(v.capacityLitres, 12000 + (i % 3) * 4000);
    const received = planned - ((i * 13) % 70);
    trips.push(await Trip.create({
      tripNumber: `${settings.trip.numberPrefix}/${fy}/${String(await nextSequence(`trip:${fy}`)).padStart(5, '0')}`,
      companyId: company._id,
      quotationId: q?._id ?? null,
      vehicleId: v._id,
      driverId: drv._id,
      product: pick(products, i),
      plannedQuantityLitres: planned,
      loadingPoint: pick(['IOCL Loni Terminal', 'BPCL Manmad Depot', 'HPCL Vashi Terminal'], i),
      unloadingPoint: `${company.legalName}, ${company.billingAddress.city}`,
      plannedStart: start,
      plannedEnd: end,
      status,
      dispatch:
        status === 'planned' || status === 'cancelled'
          ? null
          : { dispatchedAt: start, dispatchedBy: adminId, invoiceNumber: `INV-${5000 + i}`, dispatchedQuantityLitres: planned, seals: [{ compartment: 1, sealNumber: `S${80000 + i}` }] },
      delivery:
        status === 'delivered'
          ? {
              deliveredAt: end,
              deliveredBy: adminId,
              receivedQuantityLitres: received,
              shortageLitres: planned - received,
              shortagePercent: Math.round(((planned - received) / planned) * 100_000) / 1000,
              withinTolerance: ((planned - received) / planned) * 100 <= settings.trip.shortageTolerancePercent,
              receiverName: 'Site in-charge',
              sealsIntact: true,
            }
          : null,
      cancellation: status === 'cancelled' ? { cancelledAt: start, cancelledBy: adminId, reason: 'Customer postponed' } : null,
      freightPaise: 1450 * Math.round(planned / 1000) * 100,
      createdBy: adminId,
    }));
  }

  // Stores: suppliers, items with opening stock, purchase orders
  const suppliers = [];
  for (const [name, city] of [['Pune Auto Spares Pvt Ltd', 'Pune'], ['Shree Tyres & Retreads', 'Chakan'], ['Castrol Lubes Distributor', 'Nashik']] as const) {
    const seq = await nextSequence('supplier');
    suppliers.push(await Supplier.create({ supplierCode: `SUP-${String(seq).padStart(4, '0')}`, name, normalizedName: normalizeName(name), contactName: 'Sales desk', phone: `98${String(23000000 + seq * 5113)}`, address: { city, state: 'Maharashtra', stateCode: '27' }, paymentTermsDays: 30, createdBy: adminId }));
  }
  const itemRows = [
    ['Diesel filter element', 'spare_part', 'nos', 6, 18, 65000],
    ['Air brake chamber', 'spare_part', 'nos', 2, 1, 340000],
    ['Tyre 10.00 R20 radial', 'tyre', 'nos', 4, 3, 2150000],
    ['Engine oil 15W-40 (20 L)', 'lubricant', 'nos', 5, 9, 520000],
    ['Grease (18 kg bucket)', 'lubricant', 'nos', 2, 4, 410000],
    ['Tamper-proof seal', 'seal', 'nos', 200, 640, 1800],
    ['Fire extinguisher 9 kg DCP', 'safety', 'nos', 4, 6, 260000],
    ['Battery 12V 150Ah', 'battery', 'nos', 2, 0, 1180000],
  ] as const;
  const items: InstanceType<typeof StockItem>[] = [];
  for (const [name, category, unit, reorderLevel, opening, cost] of itemRows) {
    const it = await StockItem.create({ itemCode: `ITM-${String(await nextSequence('stock-item')).padStart(4, '0')}`, name, normalizedName: normalizeName(name), category, unit, reorderLevel, location: 'Main store, Loni yard', createdBy: adminId });
    if (opening) await applyMovement({ itemId: it._id, type: 'adjustment', quantity: opening, unitCostPaise: cost, date: day(-30, 0), reason: 'Opening stock', userId: String(adminId) });
    items.push(it);
  }
  const fyNow = financialYear(day(0), tz);
  const poLines = (picks: [number, number][]) => {
    const lines = picks.map(([i, qty]) => {
      const amount = qty * itemRows[i][5];
      return { itemId: items[i]._id, itemName: itemRows[i][0], unit: itemRows[i][2], quantity: qty, receivedQty: 0, ratePaise: itemRows[i][5], taxRateBps: 1800, amountPaise: amount, taxPaise: Math.round(amount * 0.18) };
    });
    const sub = lines.reduce((a, l) => a + l.amountPaise, 0);
    const tax = lines.reduce((a, l) => a + l.taxPaise, 0);
    return { lines, subtotalPaise: sub, taxTotalPaise: tax, totalPaise: sub + tax };
  };
  const po1 = await PurchaseOrder.create({ poNumber: `${PO_PREFIX}/${fyNow}/${String(await nextSequence(`po:${fyNow}`)).padStart(4, '0')}`, supplierId: suppliers[0]._id, supplierSnapshot: { name: suppliers[0].name }, orderDate: day(-6, 0), expectedDate: day(2, 0), status: 'issued', issuedAt: day(-6), issuedBy: adminId, ...poLines([[1, 4], [7, 3]]), createdBy: adminId });
  const po2 = await PurchaseOrder.create({ poNumber: `${PO_PREFIX}/${fyNow}/${String(await nextSequence(`po:${fyNow}`)).padStart(4, '0')}`, supplierId: suppliers[1]._id, supplierSnapshot: { name: suppliers[1].name }, orderDate: day(-10, 0), expectedDate: day(-3, 0), status: 'issued', issuedAt: day(-10), issuedBy: adminId, ...poLines([[2, 8]]), createdBy: adminId });
  await applyMovement({ itemId: items[2]._id, type: 'purchase_receipt', quantity: 4, unitCostPaise: itemRows[2][5], date: day(-4, 0), purchaseOrderId: po2._id, poNumber: po2.poNumber, reference: 'STR/2231', userId: String(adminId) });
  po2.lines[0].receivedQty = 4;
  po2.status = 'partially_received';
  po2.receivedValuePaise = Math.round(4 * itemRows[2][5] * 1.18);
  po2.receipts.push({ _id: new Types.ObjectId(), receivedAt: day(-4, 0), receivedBy: adminId, invoiceNumber: 'STR/2231', lines: [{ itemId: items[2]._id, quantity: 4 }] });
  po2.markModified('lines');
  await po2.save();
  await PurchaseOrder.create({ poNumber: `${PO_PREFIX}/${fyNow}/${String(await nextSequence(`po:${fyNow}`)).padStart(4, '0')}`, supplierId: suppliers[2]._id, supplierSnapshot: { name: suppliers[2].name }, orderDate: day(0, 0), status: 'draft', ...poLines([[3, 10], [4, 4]]), createdBy: adminId });
  void po1;
  await applyMovement({ itemId: items[0]._id, type: 'issue', quantity: -2, date: day(-2, 0), vehicleId: vehicles[0]._id, reason: 'Scheduled service', userId: String(adminId) });

  // Trip expenses on recent trips
  const recent = trips.filter((t) => t.status !== 'cancelled').slice(-14);
  for (let i = 0; i < recent.length; i++) {
    const t = recent[i];
    const litres = 120 + (i % 4) * 30;
    const rows = [
      { category: 'fuel', amountPaise: litres * 9150, litres, ratePaise: 9150, paidBy: i % 3 ? 'fuel_card' : 'driver', paymentMode: i % 3 ? 'fuel_card' : 'cash', vendor: 'HP Highway Fuels' },
      { category: 'toll', amountPaise: 48500 + (i % 3) * 12000, paidBy: 'fastag', paymentMode: 'fastag' },
      ...(i % 2 ? [{ category: 'food', amountPaise: 35000, paidBy: 'driver', paymentMode: 'cash' }] : []),
    ];
    for (const r of rows) {
      await TripExpense.create({ ...r, tripId: t._id, tripNumber: t.tripNumber, vehicleId: t.vehicleId, driverId: t.driverId, expenseDate: t.plannedStart, billNumber: r.category === 'fuel' ? `HP-${7000 + i}` : undefined, status: i < recent.length - 4 ? 'approved' : 'pending', decidedBy: i < recent.length - 4 ? adminId : null, decidedAt: i < recent.length - 4 ? new Date() : null, createdBy: adminId });
    }
  }

  // Payroll: joining advances and last month's salary for a few drivers
  const lastMonth = addDaysYmd(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  for (let i = 0; i < 4; i++) {
    const d = drivers[i];
    const fy = financialYear(day(-60), tz);
    await DriverPayment.create({ paymentNumber: `${PAYMENT_PREFIX}/${fy}/${String(await nextSequence(`payment:${fy}`)).padStart(5, '0')}`, driverId: d._id, driverName: d.name, type: 'joining_advance', amountPaise: 1000000, paymentDate: day(-60, 0), paymentMode: 'cash', paidById: adminId, paidByName: 'Accounts desk', notes: 'Joining advance' });
  }
  for (let i = 0; i < 3; i++) {
    const d = drivers[i];
    const monthly = d.monthlySalaryPaise ?? 0;
    const fy = financialYear(day(-2), tz);
    await DriverPayment.create({
      paymentNumber: `${PAYMENT_PREFIX}/${fy}/${String(await nextSequence(`payment:${fy}`)).padStart(5, '0')}`,
      driverId: d._id,
      driverName: d.name,
      type: 'salary',
      salaryMonth: lastMonth,
      amountPaise: monthly - 200000,
      advanceRecoveryPaise: 200000,
      salary: { month: lastMonth, daysInMonth: 30, payableDays: 30, leaveDays: 0, monthlySalaryPaise: monthly, basicPaise: monthly, tripAllowancePaise: 0, deliveredTrips: 0, grossPaise: monthly, advanceRecoveryPaise: 200000, otherDeductionsPaise: 0, netPaise: monthly - 200000 },
      paymentDate: day(-2, 0),
      paymentMode: 'bank_transfer',
      reference: `UTR${88120 + i}`,
      paidById: adminId,
      paidByName: 'Accounts desk',
    });
  }
  logger.info('demo data created');
}

async function main() {
  await connectDb();
  const admin = await ensureUser('Enile Administrator', env.SEED_ADMIN_EMAIL.toLowerCase(), 'admin');
  logger.info({ email: admin.email }, 'admin ready (password from SEED_ADMIN_PASSWORD; change it at first login)');
  if (demo) {
    await ensureUser('Operations Manager', 'manager@enile.local', 'manager');
    await ensureUser('Sales Executive', 'sales@enile.local', 'sales');
    await ensureUser('Dispatch Officer', 'operations@enile.local', 'operations');
    await ensureUser('Accounts Officer', 'accounts@enile.local', 'accounts');
    await seedDemo(admin._id);
  }
  await disconnectDb();
}

main().catch(async (err) => {
  logger.fatal({ err }, 'seed failed');
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
