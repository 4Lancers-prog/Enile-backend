/** Renders demo invoices: up to 3 trips (block layout) and many trips with several products (column layout). */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderInvoicePdf, type InvoiceDoc, type InvoiceIssuer, type InvoiceTripLine } from '../jobs/invoicePdf';

export const VIP_TRANSPORT: InvoiceIssuer = {
  name: 'VIP Transport',
  address: 'Office # 213, 6th Cross, Arekere MICO Layout 2nd Stage, Bannerghatta Road, Bengaluru - 560076',
  phone: '+91-9916060602 / 9966696246',
  email: 'viptransports@yahoo.com',
  gstin: '29BEFPA1200N1ZU',
  pan: 'BEFPA1200N',
  state: 'Karnataka',
  stateCode: '29',
  sac: '996511',
  bank: { accountTitle: 'VIP TRANSPORT', accountNumber: '2526 3636 3939', bankName: 'INDUSIND BANK', branch: 'JP NAGAR 7TH PHASE', ifsc: 'INDB0001543' },
  jurisdiction: 'Bengaluru',
  correctionDays: 3,
  lateInterestPercent: 24,
  signatory: 'Anvesh Raghavaraju',
};

// Up to 3 trips, one product, forward charge (IGST added to the bill) — same style as invoice 097.
const jsw = { shipToName: 'Deccan Steel Works Ballari [Sandur]', shipToAddress: 'Sy No-2365, Bhadra Iron Ore Mines, Ittanahalli Village, Sandur, Ballari, Karnataka - 583119' };
const ispat = { shipToName: 'Tungabhadra Ispat Limited [Hosapete]', shipToAddress: 'Sy No-114, Danapur Village, Mariyammanahalli Hobli, Hosapete, Ballari, Karnataka - 583222' };
const fewTrips: InvoiceDoc = {
  number: '101/VIPT/2026-27',
  date: '31/10/2026',
  dueDate: '30/11/2026',
  billedTo: { name: 'Shreeram Infra Projects', address: '#Plot No B/8, Jaitala Road, Ashtvinayak Nagar, Nagpur, Maharashtra - 440022', gstin: '27ABCPS7474N1ZY', pan: 'ABCPS7474N', state: 'Maharashtra', stateCode: '27' },
  gstRatePercent: 18,
  reverseCharge: false,
  advancePaise: 0,
  lines: [
    { date: '23/10/26', vehicleNumber: 'KA 01 AR 9339', lrNumber: 'LR-2311', from: 'Mangalore [KA]', to: 'Sandur [KA]', cargo: 'High Speed Diesel', unit: 'KL', loadedQty: 22, unloadedQty: 21.98, billedQty: 22, ratePaise: 240000, customerInvoiceNo: '3125208136', customerInvoiceDate: '23/10/2026', reportingDate: '24/10/26', unloadingDate: '24/10/26', ...jsw },
    { date: '26/10/26', vehicleNumber: 'KA 01 AR 9339', lrNumber: 'LR-2318', from: 'Mangalore [KA]', to: 'Sandur [KA]', cargo: 'High Speed Diesel', unit: 'KL', loadedQty: 22, unloadedQty: 22, billedQty: 22, ratePaise: 240000, customerInvoiceNo: '3125208157', customerInvoiceDate: '26/10/2026', reportingDate: '27/10/26', unloadingDate: '27/10/26', ...jsw },
    { date: '30/10/26', vehicleNumber: 'KA 01 AM 3906', lrNumber: 'LR-2326', from: 'Mangalore [KA]', to: 'Hospete [KA]', cargo: 'High Speed Diesel', unit: 'KL', loadedQty: 28, unloadedQty: 27.97, billedQty: 28, ratePaise: 240000, customerInvoiceNo: '3125208190', customerInvoiceDate: '30/10/2026', reportingDate: '31/10/26', unloadingDate: '31/10/26', ...ispat },
  ],
};

// Many trips, several products, reverse charge within Karnataka — every detail in columns.
const site = (n: number) => (n % 2 ? { shipToName: 'Sri Sai Fuels, Hoskote', shipToAddress: 'KIADB Industrial Area, Hoskote' } : { shipToName: 'Sri Sai Fuels, Nelamangala', shipToAddress: 'Nelamangala Industrial Area' });
const products: [string, string, number, string, string][] = [
  ['High Speed Diesel', 'KL', 95000, 'Devanagonthi [KA]', 'Hoskote [KA]'],
  ['Motor Spirit (Petrol)', 'KL', 98000, 'Devanagonthi [KA]', 'Nelamangala [KA]'],
  ['Bitumen VG-30', 'MT', 210000, 'Mangaluru [KA]', 'Hoskote [KA]'],
  ['Superior Kerosene Oil', 'KL', 92000, 'Devanagonthi [KA]', 'Nelamangala [KA]'],
];
const vehicles = ['KA 01 AT 6336', 'KA 01 AU 1182', 'KA 05 AH 7741', 'KA 01 AR 9339'];
const pattern = [0, 1, 0, 2, 0, 1, 3, 0, 2, 1];
const manyLines: InvoiceTripLine[] = pattern.map((p, i) => {
  const [cargo, unit, ratePaise, from, to] = products[p];
  const q = unit === 'MT' ? 18 : [24, 20, 24, 12][p];
  const d = String(2 + i * 3).padStart(2, '0');
  return {
    date: `${d}/10/26`,
    vehicleNumber: vehicles[(i + p) % 4],
    lrNumber: `LR-${2400 + i}`,
    from,
    to,
    cargo,
    unit,
    loadedQty: q,
    unloadedQty: +(q - (i % 3 === 1 ? 0.02 : 0)).toFixed(3),
    billedQty: q,
    ratePaise,
    deductionPaise: i === 5 ? 640000 : undefined,
    customerInvoiceNo: `SS/${4410 + i * 7}`,
    customerInvoiceDate: `${d}/10/2026`,
    reportingDate: `${d}/10/26`,
    unloadingDate: `${d}/10/26`,
    ...site(i),
  };
});
const manyTrips: InvoiceDoc = {
  number: '102/VIPT/2026-27',
  date: '31/10/2026',
  dueDate: '30/11/2026',
  billedTo: { name: 'Sri Sai Fuel Distributors', address: 'Plot 14, KIADB Industrial Area, Hoskote, Bengaluru Rural, Karnataka - 562114', gstin: '29AAKFS4521M1ZP', pan: 'AAKFS4521M', state: 'Karnataka', stateCode: '29' },
  gstRatePercent: 5,
  reverseCharge: true,
  advancePaise: 2500000,
  lines: manyLines,
};

export const DEMOS = { fewTrips, manyTrips };

if (process.argv[1]?.includes('demoInvoices'))
  (async () => {
    const out = process.argv[2] ?? '.';
    writeFileSync(join(out, 'demo-invoice-up-to-3-trips.pdf'), await renderInvoicePdf(fewTrips, VIP_TRANSPORT));
    writeFileSync(join(out, 'demo-invoice-multiple-trips-products.pdf'), await renderInvoicePdf(manyTrips, VIP_TRANSPORT));
    console.log('written to', out);
  })();
