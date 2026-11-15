import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import * as bwipjs from 'bwip-js';

/**
 * RapidXpk shipping label — RapidXpk has no label API, so we print their own
 * label spec (sample JSON they shared), field for field:
 *   order_id (Code128 + text) · tracking_url (QR) · external_id · service ·
 *   date · from.brand · deliver_to {name, phone, address, landmark, city} ·
 *   cod_amount | PREPAID · pieces · items[{name,qty}] · notes
 * Rule from RapidXpk: when payment is PREPAID, print
 * "PREPAID - DO NOT COLLECT CASH" INSTEAD of the COD amount.
 * Labels are stacked greedily onto A4 at natural height (no scaling).
 */
export interface RapidxpkLabelData {
  orderId: string; // RXK-…
  trackingUrl: string;
  externalId: string;
  service: string;
  date: string; // YYYY-MM-DD, tenant clock
  brand: string;
  name: string;
  phone: string;
  address: string;
  landmark: string;
  city: string;
  codAmount: number;
  payment: 'COD' | 'PREPAID';
  pieces: number;
  items: { name: string; qty: number }[];
  notes: string;
}

const A4 = { w: 595.28, h: 841.89 };
const M = 22;
const GAP = 14;
const W = A4.w - M * 2;
const PAD = 9;
const INK = rgb(0.07, 0.07, 0.08);
const GREY = rgb(0.33, 0.34, 0.37);
const LIME = rgb(0.776, 0.957, 0.196);
const WHITE = rgb(1, 1, 1);

/** Helvetica is WinAnsi — drop anything it can't encode so drawText never throws. */
export const pdfSafe = (s: unknown): string =>
  String(s == null ? '' : s)
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E¡-ÿ]/g, '');

export function wrapText(text: string, maxW: number, font: PDFFont, size: number): string[] {
  const out: string[] = [];
  for (const para of pdfSafe(text).split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const cand = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(cand, size) <= maxW) {
        line = cand;
        continue;
      }
      if (line) out.push(line);
      // hard-break an over-long word
      let w = word;
      while (font.widthOfTextAtSize(w, size) > maxW && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxW) cut--;
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      line = w;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

export function formatRs(n: number): string {
  return `Rs ${Math.round(n).toLocaleString('en-US')}`;
}

async function png(opts: Record<string, unknown>): Promise<Buffer> {
  return bwipjs.toBuffer({
    backgroundcolor: 'FFFFFF',
    paddingwidth: 0,
    paddingheight: 0,
    ...(opts as any),
  } as any);
}

interface Fonts {
  r: PDFFont;
  b: PDFFont;
}

interface Layout {
  addr: string[];
  items: string[];
  notes: string[];
  h: number;
  hHead: number;
  hCode: number;
  hTo: number;
  hPay: number;
  hItems: number;
}

const HALF = W / 2;
const LH = 12;

function layout(d: RapidxpkLabelData, f: Fonts): Layout {
  const addr = wrapText(d.address, W - PAD * 2, f.r, 10).slice(0, 4);
  const items = d.items.length
    ? d.items.flatMap((i) => wrapText(`${i.qty} x ${i.name}`, HALF - PAD * 2, f.r, 9.5))
    : ['-'];
  const notes = d.notes ? wrapText(d.notes, HALF - PAD * 2, f.b, 9.5) : ['-'];
  const hHead = 62;
  const hCode = 78;
  const hTo = PAD + 10 + 16 + 13 + addr.length * LH + (d.landmark ? LH : 0) + 20 + PAD;
  const hPay = 64;
  const hItems = PAD + 10 + Math.max(items.length, notes.length) * LH + PAD;
  return { addr, items, notes, hHead, hCode, hTo, hPay, hItems, h: hHead + hCode + hTo + hPay + hItems };
}

async function drawLabel(
  doc: PDFDocument,
  page: PDFPage,
  top: number,
  d: RapidxpkLabelData,
  L: Layout,
  f: Fonts,
): Promise<void> {
  const x0 = M;
  const text = (s: string, x: number, y: number, size: number, font: PDFFont, color = INK) =>
    page.drawText(pdfSafe(s), { x, y, size, font, color });
  const label = (s: string, x: number, y: number) => text(s.toUpperCase(), x, y, 7.5, f.b, GREY);
  const hline = (y: number) =>
    page.drawLine({ start: { x: x0, y }, end: { x: x0 + W, y }, thickness: 1.5, color: INK });
  const vline = (x: number, y1: number, y2: number) =>
    page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: 1.5, color: INK });

  page.drawRectangle({ x: x0, y: top - L.h, width: W, height: L.h, borderColor: INK, borderWidth: 1.8 });

  // ── header: FROM brand · RapidXpk | service + date ──
  let y = top;
  label('From', x0 + PAD, y - PAD - 6);
  text(d.brand, x0 + PAD, y - PAD - 22, 14, f.b);
  // RapidXpk mark
  page.drawRectangle({ x: x0 + PAD, y: y - L.hHead + 7, width: 13, height: 10, color: INK });
  text('RX', x0 + PAD + 1.8, y - L.hHead + 9.5, 6.5, f.b, LIME);
  text('RapidXpk', x0 + PAD + 17, y - L.hHead + 9.5, 8.5, f.b);
  const rx = x0 + W - PAD;
  const rt = (s: string, yy: number, size: number, font: PDFFont, color = INK) => {
    const t = pdfSafe(s);
    page.drawText(t, { x: rx - font.widthOfTextAtSize(t, size), y: yy, size, font, color });
  };
  rt('SERVICE', y - PAD - 6, 7.5, f.b, GREY);
  rt(d.service, y - PAD - 18, 10, f.b);
  rt('DATE', y - PAD - 30, 7.5, f.b, GREY);
  rt(d.date, y - PAD - 42, 10, f.b);
  y -= L.hHead;
  hline(y);

  // ── barcode (order_id) + QR (tracking_url) ──
  const qrSize = 58;
  const bcW = W - PAD * 3 - qrSize - 10;
  try {
    const bc = await doc.embedPng(
      await png({ bcid: 'code128', text: d.orderId, scale: 3, height: 12, includetext: false }),
    );
    page.drawImage(bc, { x: x0 + PAD, y: y - PAD - 40, width: bcW, height: 40 });
  } catch {
    /* barcode is best-effort; the number below is always printed */
  }
  const idW = f.b.widthOfTextAtSize(pdfSafe(d.orderId), 14);
  text(d.orderId, x0 + PAD + (bcW - idW) / 2, y - PAD - 58, 14, f.b);
  if (d.trackingUrl) {
    try {
      const qr = await doc.embedPng(await png({ bcid: 'qrcode', text: d.trackingUrl, scale: 3 }));
      page.drawImage(qr, { x: x0 + W - PAD - qrSize, y: y - PAD - qrSize, width: qrSize, height: qrSize });
    } catch {
      /* ignore */
    }
    const sc = 'SCAN TO TRACK';
    text(sc, x0 + W - PAD - qrSize / 2 - f.b.widthOfTextAtSize(sc, 6) / 2, y - PAD - qrSize - 8, 6, f.b, GREY);
  }
  y -= L.hCode;
  hline(y);

  // ── deliver to ──
  let ty = y - PAD - 6;
  label('Deliver to', x0 + PAD, ty);
  ty -= 15;
  text(d.name, x0 + PAD, ty, 13, f.b);
  ty -= 13;
  text(d.phone, x0 + PAD, ty, 10.5, f.b);
  for (const ln of L.addr) {
    ty -= LH;
    text(ln, x0 + PAD, ty, 10, f.r);
  }
  if (d.landmark) {
    ty -= LH;
    text('LANDMARK', x0 + PAD, ty, 7.5, f.b, GREY);
    text(d.landmark, x0 + PAD + f.b.widthOfTextAtSize('LANDMARK', 7.5) + 6, ty, 10, f.r);
  }
  ty -= 19;
  text(d.city.toUpperCase(), x0 + PAD, ty, 16, f.b);
  y -= L.hTo;
  hline(y);

  // ── payment | order ref + pieces ──
  if (d.payment === 'PREPAID') {
    page.drawRectangle({ x: x0 + PAD, y: y - L.hPay + PAD, width: HALF - PAD * 2, height: L.hPay - PAD * 2, color: INK });
    text('PREPAID', x0 + PAD + 8, y - PAD - 18, 13, f.b, WHITE);
    text('DO NOT COLLECT CASH', x0 + PAD + 8, y - PAD - 34, 11, f.b, WHITE);
  } else {
    label('Cash to collect (COD)', x0 + PAD, y - PAD - 6);
    text(formatRs(d.codAmount), x0 + PAD, y - PAD - 34, 24, f.b);
  }
  vline(x0 + HALF, y, y - L.hPay);
  label('Order ref', x0 + HALF + PAD, y - PAD - 6);
  text(d.externalId, x0 + HALF + PAD, y - PAD - 22, 13, f.b);
  label('Pieces', x0 + HALF + PAD, y - PAD - 34);
  text(String(d.pieces), x0 + HALF + PAD, y - PAD - 46, 11, f.b);
  y -= L.hPay;
  hline(y);

  // ── items | notes ──
  label('Items', x0 + PAD, y - PAD - 6);
  label('Notes', x0 + HALF + PAD, y - PAD - 6);
  let iy = y - PAD - 6;
  for (const ln of L.items) {
    iy -= LH;
    text(ln, x0 + PAD, iy, 9.5, f.r);
  }
  let ny = y - PAD - 6;
  for (const ln of L.notes) {
    ny -= LH;
    text(ln, x0 + HALF + PAD, ny, 9.5, f.b);
  }
  vline(x0 + HALF, y, y - L.hItems);
}

/** All labels, stacked as many per A4 as fit (each at natural height). */
export async function buildRapidxpkLabelsPdf(labels: RapidxpkLabelData[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const f: Fonts = {
    r: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  let page = doc.addPage([A4.w, A4.h]);
  let top = A4.h - M;
  for (const d of labels) {
    const L = layout(d, f);
    if (top - L.h < M && top < A4.h - M) {
      page = doc.addPage([A4.w, A4.h]);
      top = A4.h - M;
    }
    await drawLabel(doc, page, top, d, L, f);
    top -= L.h + GAP;
  }
  return Buffer.from(await doc.save());
}
