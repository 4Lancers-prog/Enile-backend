import PDFDocument from 'pdfkit';
import { formatInr } from '../lib/money';
import { ymdInTz } from '../lib/time';
import type { IQuotation } from '../models/Quotation';
import type { AppSettings } from '../models/SystemSetting';

/** Renders an issued quotation from its snapshot (never from live company data). */
export function renderQuotationPdf(q: IQuotation, settings: AppSettings): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: q.quotationNumber ?? 'Quotation', Author: settings.business.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const tz = settings.timezone;
    const snap = q.companySnapshot;

    doc.fontSize(18).fillColor('#0f172a').text(settings.business.name, { continued: false });
    doc.fontSize(9).fillColor('#475569').text([settings.business.address, settings.business.phone, settings.business.email].filter(Boolean).join(' · '));
    if (settings.business.gstin) doc.text(`GSTIN: ${settings.business.gstin}`);
    doc.moveDown();
    doc.fontSize(14).fillColor('#1d4ed8').text('QUOTATION');
    doc.fontSize(10).fillColor('#0f172a');
    doc.text(`Number: ${q.quotationNumber}`);
    doc.text(`Date: ${q.issueDate ? ymdInTz(q.issueDate, tz) : '-'}    Valid until: ${q.validUntil ? ymdInTz(q.validUntil, tz) : '-'}`);
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').text('To:');
    doc.font('Helvetica').text(snap?.legalName ?? '');
    const a = snap?.billingAddress;
    if (a) doc.text([a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).join(', '));
    if (snap?.gstin) doc.text(`GSTIN: ${snap.gstin}`);
    if (snap?.contactName) doc.text(`Attn: ${snap.contactName}${snap.contactPhone ? ` (${snap.contactPhone})` : ''}`);
    if (q.subject) doc.moveDown(0.5).text(`Subject: ${q.subject}`);
    doc.moveDown();

    const cols = [40, 70, 300, 360, 410, 480];
    const header = ['#', 'Description', 'Qty', 'Unit', 'Rate', 'Amount'];
    let y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9);
    header.forEach((h, i) => doc.text(h, cols[i], y, { width: (cols[i + 1] ?? 555) - cols[i] - 4, align: i >= 2 ? 'right' : 'left' }));
    doc.moveTo(40, y + 14).lineTo(555, y + 14).strokeColor('#cbd5e1').stroke();
    y += 20;
    doc.font('Helvetica');
    q.lineItems.forEach((l, idx) => {
      const desc = [l.description, l.product, l.route].filter(Boolean).join(' · ');
      const h = Math.max(14, doc.heightOfString(desc, { width: 226 }));
      if (y + h > 760) {
        doc.addPage();
        y = 40;
      }
      const row = [String(idx + 1), desc, String(l.quantity), l.unit, formatInr(l.ratePaise), formatInr(l.amountPaise)];
      row.forEach((v, i) => doc.text(v, cols[i], y, { width: (cols[i + 1] ?? 555) - cols[i] - 4, align: i >= 2 ? 'right' : 'left' }));
      y += h + 6;
    });
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#cbd5e1').stroke();
    y += 8;
    const totalRow = (label: string, paise: number, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, 330, y, { width: 140, align: 'right' });
      doc.text(formatInr(paise), 480, y, { width: 75, align: 'right' });
      y += 16;
    };
    totalRow('Subtotal', q.subtotalPaise);
    if (q.discountPaise) totalRow('Discount', -q.discountPaise);
    totalRow('Taxable value', q.taxablePaise);
    for (const t of q.taxBreakdown) totalRow(`${t.type} @ ${t.rateBps / 100}%`, t.amountPaise);
    if (q.roundOffPaise) totalRow('Round off', q.roundOffPaise);
    totalRow('Total', q.totalPaise, true);

    if (q.terms) {
      doc.moveDown(2).font('Helvetica-Bold').fontSize(9).text('Terms', 40);
      doc.font('Helvetica').fillColor('#475569').text(q.terms, 40, undefined, { width: 515 });
    }
    doc.fontSize(8).fillColor('#94a3b8').text(`Tax configuration v${q.taxConfigVersion}. Computer-generated quotation.`, 40, 790, { width: 515, align: 'center' });
    doc.end();
  });
}
