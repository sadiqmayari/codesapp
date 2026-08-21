import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { PayfastBatch } from './payfast-settlement.types';

const A4 = { w: 595.28, h: 841.89 };

export interface PayfastStatementPdfOpts {
  companyName: string;
  companyAddress?: string | null;
  logo?: { bytes: Buffer; mime: string } | null;
  merchantId: string | null;
  periodLabel: string;
  generatedLabel: string;
  currency: string;
  grand: {
    txns: number;
    matched: number;
    gross: number;
    fees: number;
    whtSt: number;
    received: number;
  };
  batches: PayfastBatch[];
  unmatched: Array<{ paymentId: string; amount: number; issuer: string }>;
}

/**
 * The CodesApp-branded PayFast settlement statement: one consolidated document
 * for the period — a grand-total summary, then each payout settlement as its own
 * section (its orders + subtotal), then any unmatched transactions. Same visual
 * conventions as the courier statement (A4, Helvetica, brand band, zebra rows,
 * right-aligned money).
 */
export async function buildPayfastStatementPdf(
  opts: PayfastStatementPdfOpts,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M = 30;
  const ink = rgb(0.11, 0.12, 0.15);
  const grey = rgb(0.44, 0.45, 0.5);
  const line = rgb(0.86, 0.87, 0.9);
  const brand = rgb(0.17, 0.2, 0.36);
  const headBg = rgb(0.93, 0.94, 0.98);
  const zebra = rgb(0.973, 0.976, 0.985);
  const white = rgb(1, 1, 1);
  const green = rgb(0.08, 0.44, 0.24);
  const red = rgb(0.7, 0.15, 0.15);

  const usable = A4.w - M * 2;
  const rightEdge = A4.w - M;
  const PAD = 6;
  const FS = 8.5;
  const LH = 12;

  const money = (v: number): string => `${opts.currency} ${Math.round(v).toLocaleString()}`;
  // pdf-lib's standard Helvetica is WinAnsi-encoded and can't render characters
  // outside Latin-1 (e.g. the arrow →, em dash, smart quotes). Normalize common
  // ones to ASCII and drop anything still unencodable so a stray character in a
  // bank/customer name can never crash the build.
  const wa = (s: string): string =>
    (s ?? '')
      .replace(/→/g, '->')
      .replace(/[—–]/g, '-')
      .replace(/…/g, '...')
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/•/g, '-')
      .replace(/[^\x00-\xFF]/g, '');
  const clip = (s: string, maxW: number, f: PDFFont = font, size = FS): string => {
    let t = wa(s ?? '');
    while (t.length && f.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -1);
    return t;
  };

  let page = doc.addPage([A4.w, A4.h]);
  let y = A4.h;

  const newPage = () => {
    page = doc.addPage([A4.w, A4.h]);
    y = A4.h - M;
  };
  const ensure = (need: number) => {
    if (y - need < M) newPage();
  };

  // ── Header band ───────────────────────────────────────────────────────────
  const bandH = 90;
  page.drawRectangle({ x: 0, y: A4.h - bandH, width: A4.w, height: bandH, color: brand });
  let textX = M;
  if (opts.logo) {
    try {
      const img = /png/i.test(opts.logo.mime)
        ? await doc.embedPng(opts.logo.bytes)
        : await doc.embedJpg(opts.logo.bytes);
      const box = 38;
      const scale = Math.min(box / img.width, box / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: M, y: A4.h - bandH / 2 - h / 2, width: w, height: h });
      textX = M + w + 12;
    } catch {
      /* fall back to name */
    }
  }
  page.drawText(clip(opts.companyName, 280, bold, 15), { x: textX, y: A4.h - 32, size: 15, font: bold, color: white });
  if (opts.companyAddress) {
    page.drawText(clip(opts.companyAddress, 280, font, 8.5), { x: textX, y: A4.h - 48, size: 8.5, font, color: rgb(0.82, 0.84, 0.92) });
  }
  page.drawText('PayFast Settlement Statement', { x: textX, y: A4.h - 64, size: 9.5, font, color: rgb(0.82, 0.84, 0.92) });

  const pfName = clip('PayFast', 200, bold, 15);
  page.drawText(pfName, { x: rightEdge - bold.widthOfTextAtSize(pfName, 15), y: A4.h - 32, size: 15, font: bold, color: white });
  const rightLines: Array<[string, string]> = [
    ['Merchant ID', opts.merchantId ?? '—'],
    ['Period', opts.periodLabel || '—'],
    ['Generated', opts.generatedLabel],
  ];
  let ry = A4.h - 50;
  for (const [k, vRaw] of rightLines) {
    const v = wa(vRaw);
    const vw = bold.widthOfTextAtSize(v, 8.5);
    page.drawText(v, { x: rightEdge - vw, y: ry, size: 8.5, font: bold, color: white });
    const kw = font.widthOfTextAtSize(k, 7.5);
    page.drawText(k, { x: rightEdge - vw - 6 - kw, y: ry, size: 7.5, font, color: rgb(0.72, 0.75, 0.88) });
    ry -= 12;
  }
  y = A4.h - bandH - 18;

  // ── Grand-total cards ─────────────────────────────────────────────────────
  const cards: Array<[string, string, ReturnType<typeof rgb>]> = [
    ['Gross collected', money(opts.grand.gross), ink],
    ['PayFast fees', `- ${money(opts.grand.fees)}`, red],
    ['Withholding (WHT+ST)', `- ${money(opts.grand.whtSt)}`, red],
    ['Net received', money(opts.grand.received - opts.grand.whtSt), green],
  ];
  const cw = (usable - 3 * 10) / 4;
  const chH = 50;
  cards.forEach(([label, val, col], i) => {
    const x = M + i * (cw + 10);
    page.drawRectangle({ x, y: y - chH, width: cw, height: chH, color: headBg, borderColor: line, borderWidth: 0.5 });
    page.drawText(label, { x: x + 8, y: y - 16, size: 7.5, font, color: grey });
    page.drawText(clip(val, cw - 16, bold, 12), { x: x + 8, y: y - 34, size: 12, font: bold, color: col });
  });
  y -= chH + 8;
  page.drawText(
    `${opts.grand.matched.toLocaleString()} of ${opts.grand.txns.toLocaleString()} transactions matched to orders · ${opts.batches.length} settlements`,
    { x: M, y: y - 2, size: 8, font, color: grey },
  );
  y -= 20;

  // ── Column layout for the per-settlement order tables ─────────────────────
  const cols = [
    { key: 'order', title: 'Order', w: 70, right: false },
    { key: 'method', title: 'Method', w: 90, right: false },
    { key: 'amount', title: 'Amount', w: 95, right: true },
    { key: 'fee', title: 'Fee', w: 85, right: true },
    { key: 'wht', title: 'WHT+ST', w: 80, right: true },
    { key: 'recv', title: 'Received', w: usable - 70 - 90 - 95 - 85 - 80, right: true },
  ];
  const xOf: Record<string, number> = {};
  {
    let acc = M;
    for (const c of cols) {
      xOf[c.key] = acc;
      acc += c.w;
    }
  }
  const drawHeaderRow = () => {
    page.drawRectangle({ x: M, y: y - LH, width: usable, height: LH, color: brand });
    for (const c of cols) {
      const t = c.title;
      const tx = c.right ? xOf[c.key] + c.w - PAD - bold.widthOfTextAtSize(t, FS) : xOf[c.key] + PAD;
      page.drawText(t, { x: tx, y: y - LH + 3.5, size: FS, font: bold, color: white });
    }
    y -= LH;
  };
  const cell = (key: string, text: string, f: PDFFont, color = ink) => {
    const c = cols.find((k) => k.key === key)!;
    const t = clip(text, c.w - PAD * 2, f);
    const tx = c.right ? xOf[key] + c.w - PAD - f.widthOfTextAtSize(t, FS) : xOf[key] + PAD;
    page.drawText(t, { x: tx, y: y - LH + 3.5, size: FS, font: f, color });
  };

  for (const b of opts.batches) {
    ensure(LH * 4);
    // Settlement section header
    page.drawText(clip(`${b.settlementDate ?? '—'}  ·  ${b.bank}  ·  ${b.count} orders`, usable - 160, bold, 9.5), {
      x: M,
      y: y - 12,
      size: 9.5,
      font: bold,
      color: brand,
    });
    const sub = `${money(b.gross)} -> ${money(b.received)}`;
    page.drawText(sub, { x: rightEdge - bold.widthOfTextAtSize(sub, 9), y: y - 12, size: 9, font: bold, color: green });
    y -= 18;
    drawHeaderRow();
    let zi = 0;
    for (const t of b.txns) {
      ensure(LH);
      if (y - LH < M) {
        drawHeaderRow();
      }
      if (zi % 2 === 1) page.drawRectangle({ x: M, y: y - LH, width: usable, height: LH, color: zebra });
      cell('order', t.orderName ?? '(unmatched)', bold, t.orderName ? ink : red);
      cell('method', t.issuer, font, grey);
      cell('amount', money(t.amount), font);
      cell('fee', money(t.fee), font, grey);
      cell('wht', money(t.whtSt), font, grey);
      cell('recv', money(t.merchantAmount), font);
      y -= LH;
      zi++;
    }
    // subtotal row
    ensure(LH);
    page.drawRectangle({ x: M, y: y - LH, width: usable, height: LH, color: headBg });
    cell('order', 'Subtotal', bold);
    cell('method', `${b.count}`, bold, grey);
    cell('amount', money(b.gross), bold);
    cell('fee', money(b.fees), bold, red);
    cell('wht', money(b.whtSt), bold, red);
    cell('recv', money(b.received), bold, green);
    y -= LH + 12;
  }

  // ── Unmatched ─────────────────────────────────────────────────────────────
  if (opts.unmatched.length) {
    ensure(LH * 3);
    page.drawText(`Unmatched transactions (${opts.unmatched.length})`, { x: M, y: y - 12, size: 9.5, font: bold, color: red });
    y -= 18;
    for (const u of opts.unmatched) {
      ensure(LH);
      page.drawText(clip(`${u.paymentId}  ·  ${u.issuer}  ·  ${money(u.amount)}`, usable, font, 8), { x: M, y: y - 9, size: 8, font, color: grey });
      y -= LH;
    }
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
