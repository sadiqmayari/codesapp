import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { formatRs, pdfSafe } from './rapidxpk-slip.util';
import { RapidxpkLabelData } from './rapidxpk-slip.util';

/**
 * RapidXpk loadsheet — "one per pickup, handed to our rider" — in the exact
 * shape RapidXpk shared:
 *   { loadsheet_date, brand, total_parcels, total_cod,
 *     orders: [{ order_id, external_id, name, phone, city, pieces, cod_amount, payment }] }
 * total_cod sums COD orders only (prepaid rows carry 0). A batch that spans
 * several stores becomes one sheet per brand, all in one PDF.
 */
export interface RapidxpkLoadsheetJson {
  loadsheet_date: string;
  brand: string;
  total_parcels: number;
  total_cod: number;
  orders: Array<{
    order_id: string;
    external_id: string;
    name: string;
    phone: string;
    city: string;
    pieces: number;
    cod_amount: number;
    payment: 'COD' | 'PREPAID';
  }>;
}

/** Group parcels by brand into RapidXpk's loadsheet JSON (one per brand). */
export function toRapidxpkLoadsheets(
  parcels: RapidxpkLabelData[],
  loadsheetDate: string,
): RapidxpkLoadsheetJson[] {
  const byBrand = new Map<string, RapidxpkLabelData[]>();
  for (const p of parcels) {
    const k = p.brand || '-';
    if (!byBrand.has(k)) byBrand.set(k, []);
    byBrand.get(k)!.push(p);
  }
  return [...byBrand.entries()].map(([brand, list]) => {
    const orders = list.map((p) => ({
      order_id: p.orderId,
      external_id: p.externalId,
      name: p.name,
      phone: p.phone,
      city: p.city,
      pieces: p.pieces,
      cod_amount: p.payment === 'COD' ? Math.round(p.codAmount) : 0,
      payment: p.payment,
    }));
    return {
      loadsheet_date: loadsheetDate,
      brand,
      total_parcels: orders.length,
      total_cod: orders.reduce((s, o) => s + o.cod_amount, 0),
      orders,
    };
  });
}

const A4 = { w: 595.28, h: 841.89 };
const M = 32;
const INK = rgb(0.07, 0.07, 0.08);
const GREY = rgb(0.35, 0.36, 0.39);
const LINE = rgb(0.85, 0.86, 0.88);
const HEAD_BG = rgb(0.94, 0.95, 0.96);
const LIME = rgb(0.776, 0.957, 0.196);

// # | Order ID | External ID | Name | Phone | City | Pcs | COD | Payment
const COLS: Array<{ title: string; w: number; right?: boolean }> = [
  { title: '#', w: 22 },
  { title: 'ORDER ID', w: 72 },
  { title: 'EXTERNAL ID', w: 64 },
  { title: 'NAME', w: 96 },
  { title: 'PHONE', w: 70 },
  { title: 'CITY', w: 60 },
  { title: 'PCS', w: 28, right: true },
  { title: 'COD', w: 50, right: true },
  { title: 'PAYMENT', w: 69.28 },
];
const ROW_H = 17;

function clip(s: string, maxW: number, font: PDFFont, size: number): string {
  let t = pdfSafe(s);
  if (font.widthOfTextAtSize(t, size) <= maxW) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > maxW) t = t.slice(0, -1);
  return `${t}...`;
}

function drawHeader(page: PDFPage, sheet: RapidxpkLoadsheetJson, r: PDFFont, b: PDFFont, cont: boolean): number {
  let y = A4.h - M;
  page.drawText('RAPIDXPK LOADSHEET', { x: M, y: y - 8, size: 8, font: b, color: GREY });
  page.drawText(pdfSafe(sheet.brand) + (cont ? '  (continued)' : ''), { x: M, y: y - 28, size: 18, font: b, color: INK });
  // RapidXpk mark, right
  page.drawRectangle({ x: A4.w - M - 78, y: y - 26, width: 18, height: 14, color: INK });
  page.drawText('RX', { x: A4.w - M - 75.5, y: y - 22, size: 8, font: b, color: LIME });
  page.drawText('RapidXpk', { x: A4.w - M - 56, y: y - 22, size: 10, font: b, color: INK });
  y -= 44;
  // totals boxes
  const boxes: Array<[string, string]> = [
    ['LOADSHEET DATE', sheet.loadsheet_date],
    ['BRAND', sheet.brand],
    ['TOTAL PARCELS', String(sheet.total_parcels)],
    ['TOTAL COD', formatRs(sheet.total_cod)],
  ];
  const bw = (A4.w - M * 2 - 3 * 8) / 4;
  boxes.forEach(([k, v], i) => {
    const x = M + i * (bw + 8);
    page.drawRectangle({ x, y: y - 36, width: bw, height: 36, borderColor: INK, borderWidth: 1.3 });
    page.drawText(k, { x: x + 7, y: y - 12, size: 6.5, font: b, color: GREY });
    page.drawText(clip(v, bw - 14, b, 12), { x: x + 7, y: y - 28, size: 12, font: b, color: INK });
  });
  return y - 52;
}

function drawTableHead(page: PDFPage, y: number, b: PDFFont): number {
  page.drawRectangle({ x: M, y: y - ROW_H, width: A4.w - M * 2, height: ROW_H, color: HEAD_BG });
  let x = M;
  for (const c of COLS) {
    const t = c.title;
    const tx = c.right ? x + c.w - 5 - b.widthOfTextAtSize(t, 6.5) : x + 5;
    page.drawText(t, { x: tx, y: y - 11.5, size: 6.5, font: b, color: GREY });
    x += c.w;
  }
  return y - ROW_H;
}

/** One PDF; one (or more, when long) page set per brand sheet. */
export async function buildRapidxpkLoadsheetPdf(sheets: RapidxpkLoadsheetJson[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const r = await doc.embedFont(StandardFonts.Helvetica);
  const b = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const sheet of sheets) {
    let page = doc.addPage([A4.w, A4.h]);
    let y = drawTableHead(page, drawHeader(page, sheet, r, b, false), b);
    sheet.orders.forEach((o, i) => {
      if (y - ROW_H < M + 70) {
        page = doc.addPage([A4.w, A4.h]);
        y = drawTableHead(page, drawHeader(page, sheet, r, b, true), b);
      }
      const cells = [
        String(i + 1),
        o.order_id,
        o.external_id,
        o.name,
        o.phone,
        o.city,
        String(o.pieces),
        o.cod_amount ? o.cod_amount.toLocaleString('en-US') : '0',
        o.payment,
      ];
      let x = M;
      cells.forEach((cell, ci) => {
        const c = COLS[ci];
        const font = ci === 8 || ci === 1 ? b : r;
        const t = clip(cell, c.w - 10, font, 8);
        const tx = c.right ? x + c.w - 5 - font.widthOfTextAtSize(t, 8) : x + 5;
        page.drawText(t, { x: tx, y: y - 11.5, size: 8, font, color: INK });
        x += c.w;
      });
      page.drawLine({ start: { x: M, y: y - ROW_H }, end: { x: A4.w - M, y: y - ROW_H }, thickness: 0.6, color: LINE });
      y -= ROW_H;
    });
    // signatures
    const sy = Math.max(M + 20, y - 50);
    const half = (A4.w - M * 2 - 30) / 2;
    page.drawLine({ start: { x: M, y: sy }, end: { x: M + half, y: sy }, thickness: 1, color: INK });
    page.drawLine({ start: { x: M + half + 30, y: sy }, end: { x: A4.w - M, y: sy }, thickness: 1, color: INK });
    page.drawText('Handed over by (store) - name & signature', { x: M, y: sy - 11, size: 7.5, font: r, color: GREY });
    page.drawText('Received by (RapidXpk rider) - name & signature', { x: M + half + 30, y: sy - 11, size: 7.5, font: r, color: GREY });
  }
  return Buffer.from(await doc.save());
}
