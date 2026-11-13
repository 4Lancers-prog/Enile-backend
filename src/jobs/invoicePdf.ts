import PDFDocument from 'pdfkit';

/** Who issues the invoice (letterhead, bank, statutory details). Stored in settings. */
export interface InvoiceIssuer {
  name: string;
  address: string;
  phone?: string;
  email?: string;
  gstin: string;
  pan: string;
  state: string;
  stateCode: string;
  sac: string;
  bank: { accountTitle: string; accountNumber: string; bankName: string; branch: string; ifsc: string; micr?: string };
  jurisdiction: string;
  correctionDays: number;
  lateInterestPercent: number;
  signatory?: string;
  /** PNG or JPEG shown at the top left of the letterhead. */
  logo?: Buffer | string;
}

export interface InvoiceParty {
  name: string;
  address: string;
  gstin?: string;
  pan?: string;
  state: string;
  stateCode: string;
}

/** One trip on the invoice. Quantities in KL (or MT for bitumen), money in paise. */
export interface InvoiceTripLine {
  date: string; // dd/mm/yy
  vehicleNumber: string;
  lrNumber?: string;
  from: string;
  to: string;
  cargo: string;
  unit: string; // KL or MT
  loadedQty: number;
  unloadedQty?: number;
  billedQty: number;
  ratePaise: number; // per unit
  deductionPaise?: number; // shortage etc.
  customerInvoiceNo?: string;
  customerInvoiceDate?: string;
  reportingDate?: string;
  unloadingDate?: string;
  shipToName?: string;
  shipToAddress?: string;
}

export interface InvoiceDoc {
  number: string;
  date: string;
  dueDate?: string;
  billedTo: InvoiceParty;
  lines: InvoiceTripLine[];
  advancePaise: number;
  gstRatePercent: number;
  /** true: GST paid by the recipient (RCM, usually 5%); false: added to the bill (forward charge). */
  reverseCharge: boolean;
}

/** Up to this many trips print as blocks with ship-to addresses; more print as one row per trip in columns. */
export const BLOCK_LAYOUT_MAX_TRIPS = 3;

const ORANGE = '#e8730c';
const RED = '#e11d1d';
const BLUE = '#1aa3e8';
const INK = '#111827';
const MUTED = '#4b5563';

/** 200000 → "2,00,000.00" (Indian grouping, no symbol: the built-in PDF fonts have no ₹ glyph). */
export const inr = (paise: number, decimals = 2) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(paise / 100);
const qty = (n: number) => n.toFixed(3);

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const twoDigits = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const threeDigits = (n: number) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', twoDigits(n % 100)].filter(Boolean).join(' & ');

/** Indian-system words: 2,03,904 → "Rupees Two Lakh Three Thousand Nine Hundred & Four Only". */
export function amountInWords(paise: number): string {
  let r = Math.floor(paise / 100);
  const p = paise % 100;
  const parts: string[] = [];
  const crore = Math.floor(r / 1e7);
  r %= 1e7;
  const lakh = Math.floor(r / 1e5);
  r %= 1e5;
  const thousand = Math.floor(r / 1000);
  r %= 1000;
  if (crore) parts.push(`${crore >= 100 ? threeDigits(crore) : twoDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (r) parts.push(threeDigits(r));
  return `Rupees ${parts.join(' ') || 'Zero'}${p ? ` and ${twoDigits(p)} Paise` : ''} Only.`;
}

export function invoiceTotals(inv: InvoiceDoc, issuerStateCode: string) {
  const lines = inv.lines.map((l) => {
    const amountPaise = Math.round(l.billedQty * l.ratePaise);
    return { ...l, amountPaise, netPaise: amountPaise - (l.deductionPaise ?? 0) };
  });
  const totalPaise = lines.reduce((s, l) => s + l.netPaise, 0);
  const taxPaise = Math.round((totalPaise * inv.gstRatePercent) / 100);
  const sameState = inv.billedTo.stateCode === issuerStateCode;
  const taxSplit = sameState
    ? [
        { label: `CGST@${inv.gstRatePercent / 2}%`, paise: Math.floor(taxPaise / 2) },
        { label: `SGST@${inv.gstRatePercent / 2}%`, paise: taxPaise - Math.floor(taxPaise / 2) },
      ]
    : [{ label: `IGST@${inv.gstRatePercent}%`, paise: taxPaise }];
  const netPaise = totalPaise - inv.advancePaise + (inv.reverseCharge ? 0 : taxPaise);
  return { lines, totalPaise, taxPaise, taxSplit, netPaise };
}

type Align = 'left' | 'right' | 'center';
type Col = [string, number, Align];

/**
 * GTA invoice in VIP Transport's own layout (invoices 095 and 097/VIPT/2026-27).
 * Up to 3 trips: portrait, one block per trip with the customer's invoice number, ship-to
 * name and address, reporting and unloading dates. More trips: landscape, every detail in its
 * own column, one row per trip, continuing on further pages. Totals, bank, notes and
 * signature follow the sample in both.
 */
export function renderInvoicePdf(inv: InvoiceDoc, issuer: InvoiceIssuer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const blocks = inv.lines.length <= BLOCK_LAYOUT_MAX_TRIPS;
    const doc = new PDFDocument({ size: 'A4', layout: blocks ? 'portrait' : 'landscape', margin: 0, info: { Title: `Invoice ${inv.number}`, Author: issuer.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PW = doc.page.width;
    const PH = doc.page.height;
    const X0 = 30;
    const X1 = PW - 30;
    const W = X1 - X0;
    const { lines, totalPaise, taxPaise, taxSplit, netPaise } = invoiceTotals(inv, issuer.stateCode);
    /** No trips: a blank form with only the fixed company details, for printing or preview. */
    const blank = lines.length === 0;
    const money = (paise: number) => (blank ? '' : inr(paise));

    const line = (x1: number, y1: number, x2: number, y2: number, color = INK, w = 0.6) => doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(w).strokeColor(color).stroke();
    const box = (x: number, y: number, w: number, h: number, color = INK) => doc.rect(x, y, w, h).lineWidth(0.6).strokeColor(color).stroke();
    const band = (y: number, h: number, x = X0, w = W) => doc.rect(x, y, w, h).fill(BLUE);
    const font = (bold = false, italic = false) => (bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica');
    type TextOpts = PDFKit.Mixins.TextOptions & { size?: number; bold?: boolean; italic?: boolean; color?: string };
    const text = (s: string, x: number, y: number, opts: TextOpts = {}) => {
      const { size = 8, bold = false, italic = false, color = INK, ...rest } = opts;
      doc.font(font(bold, italic)).fontSize(size).fillColor(color).text(s, x, y, { lineBreak: rest.width !== undefined, ...rest });
    };
    const height = (s: string, width: number, size: number, bold = false) => doc.font(font(bold)).fontSize(size).heightOfString(s, { width });
    const frame = () => doc.rect(24, 22, PW - 48, PH - 44).lineWidth(1.2).strokeColor(ORANGE).stroke();

    /* ------------------------------ Letterhead ------------------------------ */
    frame();
    if (issuer.logo) {
      try {
        doc.image(issuer.logo, X0 + 4, 26, { fit: [80, 56] });
      } catch {
        /* a bad logo file must not stop the invoice */
      }
    }
    text(issuer.name.toUpperCase(), X0, 30, { size: 24, bold: true, color: RED, width: W, align: 'center' });
    const addrX = issuer.logo ? X0 + 90 : X0;
    const addrW = issuer.logo ? W - 180 : W;
    const addr = issuer.address.toUpperCase();
    text(addr, addrX, 57, { size: 7.5, width: addrW, align: 'center' });
    const contactY = Math.max(68, 57 + height(addr, addrW, 7.5) + 1);
    text([issuer.phone && `MOB: ${issuer.phone}`, issuer.email && `E-MAIL: ${issuer.email}`].filter(Boolean).join('  |  '), X0, contactY, { size: 7.5, width: W, align: 'center' });
    band(82, 14);
    text('INVOICE', X0, 85.5, { size: 9, bold: true, color: '#ffffff', width: W, align: 'center' });

    // Billed to / invoice number box
    const top = 96;
    const boxH = 78;
    const metaX = X1 - 180;
    box(X0, top, W, boxH);
    line(metaX, top, metaX, top + boxH);
    const leftW = metaX - X0 - 12;
    text('Billed To', X0 + 6, top + 5, { size: 7.5, color: MUTED });
    text(`M/S ${inv.billedTo.name.toUpperCase()}`, X0 + 6, top + 16, { size: 8.5, bold: true, width: leftW });
    text(inv.billedTo.address.toUpperCase(), X0 + 6, top + 28, { size: 7.5, width: leftW });
    const half = X0 + 6 + leftW / 2;
    text(`GSTIN   : ${inv.billedTo.gstin ?? ''}`, X0 + 6, top + 52, { size: 7.5 });
    text(`PAN NO : ${inv.billedTo.pan ?? ''}`, half, top + 52, { size: 7.5 });
    text(`STATE   : ${inv.billedTo.state.toUpperCase()}`, X0 + 6, top + 64, { size: 7.5 });
    text(`STATE CODE : ${inv.billedTo.stateCode}`, half, top + 64, { size: 7.5 });
    [
      ['Invoice No.', inv.number],
      ['Date', inv.date],
      ['Due Date', inv.dueDate ?? ''],
    ].forEach(([k, v], i) => {
      text(k, metaX + 8, top + 10 + i * 22, { size: 8, color: MUTED });
      text(`: ${v}`, metaX + 72, top + 10 + i * 22, { size: 8, bold: i === 0 });
    });
    text('Transportation Charges for the following trips are as under :', X0 + 6, top + boxH + 4, { size: 7.5 });
    const tableTop = top + boxH + 15;

    /* -------------------------------- Footer -------------------------------- */
    // Height is known up front so the trip area can stop exactly above it.
    const rightX = X0 + W * (blocks ? 0.56 : 0.6);
    const valueX = X1 - (blocks ? 72 : 90);
    const RCM_NOTE = 'NOTE - AS PER NOTIFICATION NO. 13/2017 Central Tax - Rate, Date : 28/06/2017. GST PAYABLE UNDER REVERSE CHARGE BASIS BY RECIPIENT OF THE SERVICES.';
    const CORRECTION_NOTE = `Note : If any correction in this bill, please inform us at ${issuer.email ?? 'our office'} within ${issuer.correctionDays} days from receiving the bill copy. Thereafter we do not accept any correction nor any kind of GST debit note [like rate difference / detention charges / shortage] etc.`;
    const noteW = X1 - rightX - 12;
    const notesH = (inv.reverseCharge ? height(RCM_NOTE, noteW, 6.2, true) + 1 : 0) + height(CORRECTION_NOTE, noteW, 5.8);
    const fBoxH = Math.max(100, 69 + notesH + 4);
    const lowerH = blocks ? (inv.reverseCharge ? 128 : 106) : 82;
    const footerH = fBoxH + 6 + lowerH;
    const footerTop = PH - 28 - footerH;

    const footer = (fy: number) => {
      box(X0, fy, W, fBoxH);
      line(rightX, fy, rightX, fy + fBoxH);
      line(valueX, fy, valueX, fy + 66);
      // Amount in words
      text('Amount In Words :', X0 + 6, fy + 5, { size: 7.5, bold: true });
      line(X0 + 6, fy + 13.5, X0 + 6 + doc.font('Helvetica-Bold').fontSize(7.5).widthOfString('Amount In Words'), fy + 13.5, INK, 0.5);
      text(blank ? '' : amountInWords(netPaise), X0 + 6, fy + 16, { size: 8, bold: true, italic: true, width: rightX - X0 - 12 });
      // Bank details
      const by = fy + 36;
      line(X0, by - 4, rightX, by - 4);
      [
        ['Account Title in Bank', issuer.bank.accountTitle],
        ['Account No.', issuer.bank.accountNumber],
        ['Bank Name', issuer.bank.bankName],
        ['Branch Name', issuer.bank.branch],
      ].forEach(([k, v], i) => {
        text(k, X0 + 6, by + i * 9.5, { size: 7.2, bold: true });
        text(`: ${v}`, X0 + 100, by + i * 9.5, { size: 7.2, bold: true });
      });
      const ry = by + 39;
      const rw = Math.min(280, rightX - X0 - 12);
      box(X0 + 6, ry, rw, 19);
      line(X0 + 6, ry + 9, X0 + 6 + rw, ry + 9);
      [['RTGS', issuer.bank.ifsc], ['NEFT', issuer.bank.ifsc], ['MICR', issuer.bank.micr ?? '']].forEach(([k, v], i) => {
        const cx = X0 + 6 + (i * rw) / 3;
        if (i) line(cx, ry, cx, ry + 19);
        text(k, cx, ry + 1.5, { size: 6.8, bold: true, width: rw / 3, align: 'center' });
        text(v, cx, ry + 11, { size: 6.8, bold: true, width: rw / 3, align: 'center' });
      });
      // Totals
      const tot = (label: string, v: string, yy: number, bold = false) => {
        text(label, rightX + 6, yy, { size: 7.8, bold: true, width: valueX - rightX - 12, align: 'right' });
        text(v, valueX + 2, yy, { size: bold ? 8.5 : 7.8, bold, width: X1 - valueX - 6, align: 'right' });
      };
      tot('Total...', money(totalPaise), fy + 5, true);
      tot('Advance...', money(inv.advancePaise), fy + 17);
      if (!inv.reverseCharge) taxSplit.forEach((t, i) => tot(blank ? 'IGST / CGST+SGST' : t.label, money(t.paise), fy + 29 + i * 11));
      line(rightX, fy + 52, X1, fy + 52);
      tot('Net Amount...', money(netPaise), fy + 47 + 8, true);
      line(rightX, fy + 66, X1, fy + 66);
      let ny = fy + 69;
      if (inv.reverseCharge) {
        text(RCM_NOTE, rightX + 6, ny, { size: 6.2, bold: true, width: noteW });
        ny += height(RCM_NOTE, noteW, 6.2, true) + 1;
      }
      text(CORRECTION_NOTE, rightX + 6, ny, { size: 5.8, color: RED, width: noteW });

      // Lower part: tax calculation (reverse charge), notes, statutory details, signature
      const ly = fy + fBoxH + 6;
      const noteLines = [
        `1. Subject to ${issuer.jurisdiction} Jurisdiction.`,
        `2. Payment to be made in favour of ${issuer.name.toUpperCase()} by A/C payee cheque / D.D. / RTGS / NEFT only.`,
        `3. Payment within due date, otherwise ${issuer.lateInterestPercent}% p.a. interest will be charged.`,
      ];
      const colW = blocks ? rightX - X0 - 16 : W * 0.32;
      let y = ly;
      if (inv.reverseCharge) {
        text('Tax Calculation', X0 + 6, y, { size: 7.5, bold: true });
        text(taxSplit.map((t) => `${t.label.replace('@', ' @ ')} = ${inr(t.paise)}`).join('    ') + '  (payable by recipient)', X0 + 6, y + 10, { size: 7.2, bold: true });
        y += 24;
      }
      text('Notes :', X0 + 6, y, { size: 7.5, bold: true });
      y += 10;
      for (const n of noteLines) {
        text(n, X0 + 6, y, { size: 6.8, width: colW });
        y += height(n, colW, 6.8) + 1;
      }
      const sx = blocks ? X0 + 6 : X0 + W * 0.345;
      const sw = blocks ? rightX - X0 - 16 : rightX - sx - 10;
      let sy = blocks ? y + 4 : ly;
      const rcLine = `Whether the tax is payable on reverse charge basis :- ${blank ? '' : inv.reverseCharge ? 'YES' : 'NO'}`;
      text(rcLine, sx, sy, { size: 7.2, bold: true, width: sw });
      sy += height(rcLine, sw, 7.2, true) + 3;
      const col2 = sx + (blocks ? 170 : 112);
      text(`PAN No. : ${issuer.pan}`, sx, sy, { size: 7.2 });
      text(`GSTIN   : ${issuer.gstin}`, sx, sy + 10, { size: 7.2 });
      text(`HSN / SAC : ${issuer.sac}`, col2, sy + 10, { size: 7.2 });
      text(`STATE   : ${issuer.state.toUpperCase()}`, sx, sy + 20, { size: 7.2 });
      text(`STATE CODE : ${issuer.stateCode}`, col2, sy + 20, { size: 7.2 });
      // Signature
      const sigX = rightX + 4;
      const sigW = X1 - sigX;
      const sigBottom = fy + fBoxH + 6 + lowerH - 12;
      band(ly + 2, 12, sigX, sigW);
      text(`For ${issuer.name.toUpperCase()}`, sigX + 5, ly + 5, { size: 7.5, bold: true, color: '#ffffff' });
      if (issuer.signatory) text(issuer.signatory.toUpperCase(), sigX + 5, ly + 22, { size: 10 });
      band(sigBottom, 11, sigX, sigW);
      text('Authorised Signatory', sigX + 5, sigBottom + 2, { size: 7, bold: true, color: '#ffffff' });
    };

    /* ------------------------------ Trip area ------------------------------ */
    let segTop = tableTop;
    const drawHeader = (cols: Col[], xs: number[], yy: number, h: number) => {
      band(yy, h);
      cols.forEach(([label, w, a], i) => text(label, xs[i] + 2, yy + 3, { size: 6.8, bold: true, color: '#ffffff', width: w - 4, align: a }));
      return yy + h;
    };
    const layout = (cols: Col[]) => {
      const xs: number[] = [];
      cols.reduce((x, [, w]) => (xs.push(x), x + w), X0);
      return xs;
    };

    if (blocks) {
      // Portrait: one block per trip, like invoice 097.
      const cols: Col[] = [
        ['Sr.', 16, 'center'],
        ['Date', 38, 'left'],
        ['Vehicle No.', 56, 'left'],
        ['L/R No.', 38, 'left'],
        ['Destination', 82, 'center'],
        ['Cargo', 50, 'center'],
        ['Qty.', 36, 'right'],
        ['U.Qty.', 34, 'right'],
        ['B.Qty.', 36, 'right'],
        ['Rate', 44, 'right'],
        ['Amount', 44, 'right'],
        ['Net', 61, 'right'],
      ];
      const xs = layout(cols);
      let y = drawHeader(cols, xs, segTop, 13) + 5;
      const bottom = footerTop - 6;
      box(X0, segTop, W, bottom - segTop);
      line(xs[11], segTop + 13, xs[11], bottom);
      line(xs[10], segTop + 13, xs[10], bottom, '#9ca3af', 0.4);
      const leftW = xs[5] - xs[2] - 12;
      lines.forEach((l, idx) => {
        const cells = [
          String(idx + 1),
          l.date,
          l.vehicleNumber,
          l.lrNumber ?? '',
          `${l.from} TO\n${l.to}`.toUpperCase(),
          l.cargo.toUpperCase(),
          qty(l.loadedQty),
          l.unloadedQty !== undefined ? qty(l.unloadedQty) : '',
          qty(l.billedQty),
          `${inr(l.ratePaise, 0)}/${l.unit}`,
          inr(l.amountPaise, 0),
          inr(l.netPaise),
        ];
        const h = Math.max(...cells.map((c, i) => height(c, cols[i][1] - 4, 7.2)));
        cells.forEach((c, i) => text(c, xs[i] + 2, y, { size: 7.2, width: cols[i][1] - 4, align: cols[i][2] }));
        y += h + 8;
        const rx = xs[5] + 4;
        text(`Your Invoice No : ${l.customerInvoiceNo ?? ''}      Date : ${l.customerInvoiceDate ?? ''}`, xs[2] - 20, y, { size: 7, width: leftW + 20 });
        text(`Reporting Date : ${l.reportingDate ?? ''}`, rx, y, { size: 7 });
        y += 12;
        doc.font('Helvetica').fontSize(7).fillColor(INK).text('Ship to. : ', xs[2] - 20, y, { continued: true, lineBreak: false }).font('Helvetica-Bold').text(`M/S ${(l.shipToName ?? '').toUpperCase()}`, { lineBreak: false });
        text(`Unloading Date : ${l.unloadingDate ?? ''}`, rx, y, { size: 7 });
        y += 12;
        if (l.shipToAddress) {
          const addr = l.shipToAddress.toUpperCase();
          text(addr, xs[3] + 6, y, { size: 7.2, width: xs[6] - xs[3] - 10 });
          y += height(addr, xs[6] - xs[3] - 10, 7.2) + 2;
        }
        if (l.deductionPaise) {
          text(`Shortage deducted : ${inr(l.deductionPaise)}`, rx, y - 12, { size: 7, color: RED });
        }
        y += 4;
        if (idx < lines.length - 1) line(X0, y - 2, xs[11], y - 2, INK, 0.5);
        y += 3;
      });
      footer(footerTop);
    } else {
      // Landscape: every detail in its own column, one row per trip.
      const cols: Col[] = [
        ['Sr.', 18, 'center'],
        ['Date', 40, 'left'],
        ['Vehicle No.', 56, 'left'],
        ['L/R No.', 36, 'left'],
        ['From', 64, 'left'],
        ['To', 64, 'left'],
        ['Cargo', 56, 'left'],
        ['Your Inv. No.', 52, 'left'],
        ['Inv. Date', 40, 'left'],
        ['Ship To', 66, 'left'],
        ['Reporting', 40, 'left'],
        ['Unloading', 40, 'left'],
        ['Qty.', 36, 'right'],
        ['U.Qty.', 36, 'right'],
        ['B.Qty.', 36, 'right'],
        ['Rate', 42, 'right'],
        ['Amount', 60, 'right'],
      ];
      const xs = layout(cols);
      const HEAD_H = 13;
      let y = drawHeader(cols, xs, segTop, HEAD_H);
      const closeSegment = (bottom: number) => {
        box(X0, segTop, W, bottom - segTop);
        cols.forEach((_, i) => i && line(xs[i], segTop + HEAD_H, xs[i], bottom, '#cbd5e1', 0.4));
      };
      const newPage = () => {
        text('Continued on next page...', X0 + 6, y + 3, { size: 7, color: MUTED });
        closeSegment(y + 14);
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
        frame();
        text(`${issuer.name.toUpperCase()}  ·  Invoice ${inv.number}  ·  ${inv.billedTo.name} (continued)`, X0, 32, { size: 9, bold: true, color: RED });
        segTop = 48;
        y = drawHeader(cols, xs, segTop, HEAD_H);
      };
      const lastLimit = footerTop - 8;
      const pageLimit = PH - 34;
      const productSet = new Set(lines.map((l) => l.cargo));
      const closingH = 18 + (productSet.size > 1 ? 14 + productSet.size * 10 : 0);
      const cellsOf = (l: (typeof lines)[number], idx: number) => [
        String(idx + 1),
        l.date,
        l.vehicleNumber,
        l.lrNumber ?? '',
        l.from.toUpperCase(),
        l.to.toUpperCase(),
        l.cargo.toUpperCase(),
        l.customerInvoiceNo ?? '',
        l.customerInvoiceDate ?? '',
        (l.shipToName ?? '').toUpperCase(),
        l.reportingDate ?? '',
        l.unloadingDate ?? '',
        qty(l.loadedQty),
        l.unloadedQty !== undefined ? qty(l.unloadedQty) : '',
        qty(l.billedQty),
        `${inr(l.ratePaise, 0)}/${l.unit}`,
        inr(l.netPaise) + (l.deductionPaise ? `\n(short ${inr(l.deductionPaise, 0)})` : ''),
      ];
      const rowHeights = lines.map((l, idx) => Math.max(...cellsOf(l, idx).map((c, i) => height(c, cols[i][1] - 4, 6.8))) + 6);
      lines.forEach((l, idx) => {
        const cells = cellsOf(l, idx);
        const h = rowHeights[idx];
        // Normal page break, plus: if the remaining rows can't share this page with the totals and
        // footer, carry the last two rows over so the final page is not just totals.
        const remaining = rowHeights.slice(idx).reduce((a, b) => a + b, 0);
        const carryAt = lines.length - Math.min(2, lines.length);
        if (y + h > pageLimit - 20 || (idx === carryAt && idx > 0 && y + remaining + closingH > lastLimit)) newPage();
        if (idx % 2) doc.rect(X0 + 0.5, y, W - 1, h).fill('#f3f6fa');
        cells.forEach((c, i) => text(c, xs[i] + 2, y + 3, { size: 6.8, width: cols[i][1] - 4, align: cols[i][2] }));
        y += h;
        line(X0, y, X1, y, '#e5e7eb', 0.4);
      });
      // Totals row and summary by product
      const units = new Set(lines.map((l) => l.unit));
      const products = new Map<string, { qty: number; unit: string; trips: number; paise: number }>();
      lines.forEach((l) => {
        const p = products.get(l.cargo) ?? { qty: 0, unit: l.unit, trips: 0, paise: 0 };
        products.set(l.cargo, { qty: p.qty + l.billedQty, unit: l.unit, trips: p.trips + 1, paise: p.paise + l.netPaise });
      });
      const summaryH = products.size > 1 ? 14 + products.size * 10 : 0;
      if (y + 18 + summaryH > lastLimit) newPage();
      doc.rect(X0 + 0.5, y, W - 1, 14).fill('#e0f2fe');
      text(`TOTAL · ${lines.length} TRIPS`, xs[1] + 2, y + 4, { size: 7, bold: true });
      if (units.size === 1) text(`${qty(lines.reduce((s, l) => s + l.billedQty, 0))}`, xs[14] + 2, y + 4, { size: 7, bold: true, width: cols[14][1] - 4, align: 'right' });
      text(inr(totalPaise), xs[16] + 2, y + 4, { size: 7, bold: true, width: cols[16][1] - 4, align: 'right' });
      y += 14;
      line(X0, y, X1, y, INK, 0.5);
      const tableEnd = y;
      if (products.size > 1) {
        y += 5;
        text('Summary by product', xs[4] + 2, y, { size: 7, bold: true });
        y += 10;
        [...products].forEach(([name, p]) => {
          text(name.toUpperCase(), xs[4] + 2, y, { size: 6.8, width: 150 });
          text(`${p.trips} trip${p.trips > 1 ? 's' : ''}`, xs[7] + 2, y, { size: 6.8 });
          text(`${qty(p.qty)} ${p.unit}`, xs[8] + 2, y, { size: 6.8, width: 70, align: 'right' });
          text(inr(p.paise), xs[9] + 2, y, { size: 6.8, width: 70, align: 'right' });
          y += 10;
        });
      }
      // Close the table box at the totals row; the summary sits under it inside the frame.
      box(X0, segTop, W, tableEnd - segTop);
      cols.forEach((_, i) => i && line(xs[i], segTop + HEAD_H, xs[i], tableEnd - 14, '#cbd5e1', 0.4));
      footer(footerTop);
    }

    doc.end();
  });
}
