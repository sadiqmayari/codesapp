import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ReconciledLine, ReconcileSummary } from './invoices/courier-invoice.types';

const A4 = { w: 595.28, h: 841.89 };

export interface CourierInvoicePdfOpts {
  companyName: string;
  companyAddress?: string | null;
  /** Raw logo bytes + mime; pdf-lib embeds JPG/PNG only (anything else is skipped). */
  logo?: { bytes: Buffer; mime: string } | null;
  courierName: string;
  invoiceNumber: string | null;
  reportDateLabel: string | null;
  generatedLabel: string;
  currency: string;
  totals: {
    rows: number;
    paidRows: number;
    codCollected: number;
    shipping: number;
    fuel: number;
    tax: number;
    deductions: number;
    netPayable: number;
  };
  /**
   * Optional courier-specific deduction components. When present, the statement
   * shows a row of tax cards + an itemised deduction breakup (e.g. PostEx's
   * GST / Advance Income Tax / Withholding Sales Tax). When absent, the generic
   * delivered-vs-charges settlement summary is drawn instead.
   */
  taxBreakdown?: Array<{ label: string; sublabel?: string; amount: number }>;
  lines: ReconciledLine[];
  summary: ReconcileSummary;
}

/**
 * The CodesApp-branded courier settlement statement: the courier's own invoice
 * re-rendered under the tenant's brand, PLUS a reconciliation section showing how
 * it lined up with CodesApp. One document that is both the financial record and
 * the audit of applying it.
 *
 * Built with pdf-lib on the same conventions as pdf.util.ts (A4 points, Helvetica,
 * a coloured header band, zebra rows, right-aligned money).
 */
export async function buildCourierInvoicePdf(
  opts: CourierInvoicePdfOpts,
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
  const amber = rgb(0.63, 0.44, 0.04);
  const red = rgb(0.7, 0.15, 0.15);

  const usable = A4.w - M * 2;
  const rightEdge = A4.w - M;
  const PAD = 6;
  const FS = 8.5;
  const LH = 11;

  const money = (v: number): string =>
    `${opts.currency} ${Math.round(v).toLocaleString()}`;
  const clip = (s: string, maxW: number, f = font, size = FS): string => {
    let t = s ?? '';
    while (t.length && f.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -1);
    return t;
  };

  let page = doc.addPage([A4.w, A4.h]);
  let y = A4.h;

  // ── Header band ─────────────────────────────────────────────────────────
  const bandH = 74;
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
      /* unsupported/broken logo → fall back to the name alone */
    }
  }
  page.drawText(clip(opts.companyName, 300, bold, 15), {
    x: textX,
    y: A4.h - 30,
    size: 15,
    font: bold,
    color: white,
  });
  if (opts.companyAddress) {
    page.drawText(clip(opts.companyAddress, 300, font, 8.5), {
      x: textX,
      y: A4.h - 44,
      size: 8.5,
      font,
      color: rgb(0.82, 0.84, 0.92),
    });
  }
  page.drawText('Courier Settlement Statement', {
    x: textX,
    y: A4.h - 60,
    size: 9.5,
    font,
    color: rgb(0.82, 0.84, 0.92),
  });

  // right side of the band: courier + invoice no + dates
  const rightLines: Array<[string, string]> = [
    ['Courier', opts.courierName],
    ['Invoice no.', opts.invoiceNumber ?? '—'],
    ['Statement date', opts.reportDateLabel ?? '—'],
    ['Generated', opts.generatedLabel],
  ];
  let ry = A4.h - 24;
  for (const [k, v] of rightLines) {
    const vw = bold.widthOfTextAtSize(v, 8.5);
    page.drawText(v, { x: rightEdge - vw, y: ry, size: 8.5, font: bold, color: white });
    const kw = font.widthOfTextAtSize(k, 7.5);
    page.drawText(k, {
      x: rightEdge - vw - 6 - kw,
      y: ry,
      size: 7.5,
      font,
      color: rgb(0.72, 0.75, 0.88),
    });
    ry -= 13;
  }

  y = A4.h - bandH - 18;

  // ── Money summary ───────────────────────────────────────────────────────
  const boxH = 54;
  const boxW = (usable - 16) / 3;
  const cards: Array<[string, string, ReturnType<typeof rgb>]> = [
    ['COD collected', money(opts.totals.codCollected), ink],
    ['Deductions', `- ${money(opts.totals.deductions)}`, amber],
    ['Net payable', money(opts.totals.netPayable), green],
  ];
  cards.forEach(([label, value, color], i) => {
    const x = M + i * (boxW + 8);
    page.drawRectangle({
      x,
      y: y - boxH,
      width: boxW,
      height: boxH,
      color: i === 2 ? rgb(0.94, 0.98, 0.95) : headBg,
      borderColor: line,
      borderWidth: 0.5,
    });
    page.drawText(label, { x: x + 10, y: y - 18, size: 8, font, color: grey });
    page.drawText(clip(value, boxW - 20, bold, 14), {
      x: x + 10,
      y: y - 40,
      size: 14,
      font: bold,
      color,
    });
  });
  y -= boxH + 12;

  const chargesOf = (l: ReconciledLine) =>
    (l.shippingCharge || 0) + (l.fuelSurcharge || 0) + (l.gst || 0) + (l.sst || 0) + (l.wht || 0);
  const paidLines = opts.lines.filter((l) => l.paid);
  const unpaidLines = opts.lines.filter((l) => !l.paid);
  const paidCod = paidLines.reduce((s, l) => s + (l.codAmount || 0), 0);
  const paidCharges = paidLines.reduce((s, l) => s + chargesOf(l), 0);
  const unpaidCharges = unpaidLines.reduce((s, l) => s + chargesOf(l), 0);

  const tb = opts.taxBreakdown?.filter((t) => t.amount) ?? [];
  if (tb.length) {
    // ── Tax cards ───────────────────────────────────────────────────────────
    page.drawText('Taxes & charges', { x: M, y: y - 10, size: 11, font: bold, color: ink });
    y -= 20;
    const n = tb.length;
    const gap = 8;
    const cardW = (usable - gap * (n - 1)) / n;
    const cardH = 46;
    tb.forEach((t, i) => {
      const x = M + i * (cardW + gap);
      page.drawRectangle({ x, y: y - cardH, width: cardW, height: cardH, color: white, borderColor: line, borderWidth: 0.6 });
      page.drawText(clip(t.label, cardW - 16, bold, 7.8), { x: x + 8, y: y - 15, size: 7.8, font: bold, color: brand });
      if (t.sublabel) page.drawText(clip(t.sublabel, cardW - 16, font, 6.8), { x: x + 8, y: y - 25, size: 6.8, font, color: grey });
      page.drawText(clip(money(t.amount), cardW - 16, bold, 11), { x: x + 8, y: y - 40, size: 11, font: bold, color: ink });
    });
    y -= cardH + 16;

    // ── Deduction breakup ───────────────────────────────────────────────────
    page.drawText('Deduction breakup', { x: M, y: y - 10, size: 11, font: bold, color: ink });
    y -= 22;
    const brk: Array<[string, string, boolean]> = [
      [`COD collected (${paidLines.length} delivered parcels)`, money(opts.totals.codCollected), false],
      ...tb.map(
        (t) => [t.sublabel ? `${t.label} (${t.sublabel})` : t.label, `- ${money(t.amount)}`, false] as [string, string, boolean],
      ),
      ['Total deductions', `- ${money(opts.totals.deductions)}`, true],
    ];
    for (const [k, v, strong] of brk) {
      page.drawRectangle({ x: M, y: y - 15, width: usable, height: 15, color: strong ? headBg : zebra });
      page.drawText(clip(k, usable - 130, strong ? bold : font, 8.5), { x: M + PAD, y: y - 11, size: 8.5, font: strong ? bold : font, color: strong ? ink : grey });
      const f = strong ? bold : font;
      const vw = f.widthOfTextAtSize(v, 8.5);
      page.drawText(v, { x: rightEdge - PAD - vw, y: y - 11, size: 8.5, font: f, color: v.startsWith('-') ? amber : ink });
      y -= 16;
    }
  } else {
    // ── Settlement breakdown (generic) ──────────────────────────────────────
    // The parcel table below lists ONLY delivered parcels, but undelivered ones
    // still carry charges the courier deducted. Spell the arithmetic out so the
    // statement reconciles to Net payable without those rows being listed.
    page.drawText('Settlement breakdown', { x: M, y: y - 10, size: 11, font: bold, color: ink });
    y -= 22;
    const rowsBreak: Array<[string, string, boolean]> = [
      [`Delivered parcels (${paidLines.length}) — COD collected`, money(paidCod), false],
      [`Delivered parcels — courier charges`, `- ${money(paidCharges)}`, false],
      [`Subtotal for delivered parcels`, money(paidCod - paidCharges), true],
    ];
    if (unpaidLines.length) {
      rowsBreak.push([
        `Undelivered parcels (${unpaidLines.length}) — charges only, not listed below`,
        `- ${money(unpaidCharges)}`,
        false,
      ]);
    }
    for (const [k, v, strong] of rowsBreak) {
      page.drawRectangle({ x: M, y: y - 15, width: usable, height: 15, color: strong ? headBg : zebra });
      page.drawText(clip(k, usable - 130, strong ? bold : font, 8.5), {
        x: M + PAD,
        y: y - 11,
        size: 8.5,
        font: strong ? bold : font,
        color: strong ? ink : grey,
      });
      const f = strong ? bold : font;
      const vw = f.widthOfTextAtSize(v, 8.5);
      page.drawText(v, {
        x: rightEdge - PAD - vw,
        y: y - 11,
        size: 8.5,
        font: f,
        color: v.startsWith('-') ? amber : ink,
      });
      y -= 16;
    }
  }
  // Net payable, emphasised
  page.drawRectangle({
    x: M,
    y: y - 19,
    width: usable,
    height: 19,
    color: rgb(0.94, 0.98, 0.95),
    borderColor: rgb(0.72, 0.88, 0.78),
    borderWidth: 0.6,
  });
  page.drawText('NET PAYABLE', { x: M + PAD, y: y - 13.5, size: 9.5, font: bold, color: green });
  const npStr = money(opts.totals.netPayable);
  page.drawText(npStr, {
    x: rightEdge - PAD - bold.widthOfTextAtSize(npStr, 10.5),
    y: y - 13.5,
    size: 10.5,
    font: bold,
    color: green,
  });
  y -= 30;

  // ── Reconciliation section ──────────────────────────────────────────────
  const s = opts.summary;
  page.drawText('Reconciliation', { x: M, y: y - 10, size: 11, font: bold, color: ink });
  y -= 22;
  const recon: Array<[string, string, ReturnType<typeof rgb>]> = [
    ['Matched to CodesApp orders', `${s.matched} of ${s.totalRows}`, s.unmatched ? amber : green],
    ['Marked delivered from this statement', String(s.toPromote), ink],
    ['Settled (COD reconciled)', String(s.toSettle), green],
    ['Already settled before this run', String(s.alreadySettled), grey],
    ['COD amount discrepancies', String(s.codMismatches), s.codMismatches ? red : green],
    ['Not found in CodesApp', String(s.unmatched), s.unmatched ? amber : green],
  ];
  for (const [k, v, c] of recon) {
    page.drawRectangle({ x: M, y: y - 15, width: usable, height: 15, color: zebra });
    page.drawText(k, { x: M + PAD, y: y - 11, size: 8.5, font, color: ink });
    const vw = bold.widthOfTextAtSize(v, 8.5);
    page.drawText(v, { x: rightEdge - PAD - vw, y: y - 11, size: 8.5, font: bold, color: c });
    y -= 16;
  }

  if (s.unmatchedTracking.length) {
    y -= 6;
    page.drawText('Not found in CodesApp (verify manually):', {
      x: M,
      y: y - 9,
      size: 8,
      font: bold,
      color: amber,
    });
    y -= 14;
    const listed = s.unmatchedTracking.slice(0, 40).join(', ');
    for (const chunk of wrapText(listed, usable - PAD * 2, font, 8)) {
      page.drawText(chunk, { x: M + PAD, y: y - 8, size: 8, font, color: grey });
      y -= 10;
    }
    if (s.unmatchedTracking.length > 40) {
      page.drawText(`… +${s.unmatchedTracking.length - 40} more`, {
        x: M + PAD,
        y: y - 8,
        size: 8,
        font,
        color: grey,
      });
      y -= 10;
    }
  }

  if (s.codMismatchSamples.length) {
    y -= 6;
    page.drawText('COD discrepancies (statement vs expected):', {
      x: M,
      y: y - 9,
      size: 8,
      font: bold,
      color: red,
    });
    y -= 14;
    for (const m of s.codMismatchSamples.slice(0, 12)) {
      const t = `${m.orderName ?? m.trackingNumber}: statement ${money(m.invoiceCod)} vs expected ${
        m.expectedCod == null ? '—' : money(m.expectedCod)
      }`;
      page.drawText(clip(t, usable - PAD * 2), { x: M + PAD, y: y - 8, size: 8, font, color: grey });
      y -= 10;
    }
  }

  // ── Line table ──────────────────────────────────────────────────────────
  y -= 16;
  const cols = [
    // '#' needs room for a 3-4 digit serial plus padding on both sides.
    { key: 'no', title: '#', w: 34 },
    { key: 'date', title: 'Date', w: 54 },
    { key: 'order', title: 'Order', w: 50 },
    { key: 'tracking', title: 'Tracking', w: 76 },
    { key: 'status', title: 'Status', w: 54 },
    { key: 'cod', title: 'COD', w: 66 },
    { key: 'charges', title: 'Charges', w: 60 },
    { key: 'net', title: 'Net', w: usable - 34 - 54 - 50 - 76 - 54 - 66 - 60 },
  ];
  const xOf: Record<string, number> = {};
  let acc = M;
  for (const c of cols) {
    xOf[c.key] = acc;
    acc += c.w;
  }
  const HROW = 18;
  const drawHead = () => {
    page.drawRectangle({
      x: M,
      y: y - HROW,
      width: usable,
      height: HROW,
      color: headBg,
      borderColor: line,
      borderWidth: 0.5,
    });
    for (const c of cols) {
      const rightAligned = ['cod', 'charges', 'net'].includes(c.key);
      const tx = rightAligned
        ? xOf[c.key] + c.w - PAD - bold.widthOfTextAtSize(c.title, FS)
        : xOf[c.key] + PAD;
      page.drawText(c.title, { x: tx, y: y - 12.5, size: FS, font: bold, color: ink });
    }
    y -= HROW;
  };
  const newPage = () => {
    page = doc.addPage([A4.w, A4.h]);
    y = A4.h - M;
  };
  if (y < M + 80) newPage();
  // Only DELIVERED parcels are listed — the ones the courier actually paid for.
  // Undelivered parcels contribute charges (shown in the breakdown above) but
  // would otherwise pad this table with rows that carry no revenue.
  page.drawText(`Delivered parcels (${paidLines.length})`, {
    x: M,
    y: y - 10,
    size: 11,
    font: bold,
    color: ink,
  });
  y -= 20;
  drawHead();

  const ROW = 15;
  paidLines.forEach((l, i) => {
    if (y - ROW < M + 16) {
      newPage();
      drawHead();
    }
    if (i % 2 === 1) {
      page.drawRectangle({ x: M, y: y - ROW, width: usable, height: ROW, color: zebra });
    }
    page.drawRectangle({
      x: M,
      y: y - ROW,
      width: usable,
      height: ROW,
      borderColor: line,
      borderWidth: 0.4,
    });
    const ty = y - 10.5;
    const charges = l.shippingCharge + l.fuelSurcharge + l.gst + l.sst + l.wht;
    const put = (key: string, text: string, f = font, color = ink) => {
      const c = cols.find((x) => x.key === key)!;
      const rightAligned = ['cod', 'charges', 'net'].includes(key);
      const t = clip(text, c.w - PAD * 2, f);
      const tx = rightAligned ? xOf[key] + c.w - PAD - f.widthOfTextAtSize(t, FS) : xOf[key] + PAD;
      page.drawText(t, { x: tx, y: ty, size: FS, font: f, color });
    };
    put('no', String(i + 1), font, grey);
    put('date', l.createdAt ? fmtShort(l.createdAt) : '—');
    put('order', l.orderName ?? (l.clientOrderId ? `#${l.clientOrderId}` : '—'), bold);
    put('tracking', l.trackingNumber);
    put('status', l.status ?? '—', font, l.paid ? green : amber);
    put('cod', l.codAmount ? money(l.codAmount) : '—');
    put('charges', charges ? `- ${money(charges)}` : '—');
    put('net', money(l.netTotal), bold, l.netTotal < 0 ? red : ink);
    y -= ROW;
  });

  // total row — sums THIS table (delivered parcels only)
  if (y - 20 < M) newPage();
  page.drawRectangle({
    x: M,
    y: y - 20,
    width: usable,
    height: 20,
    color: headBg,
    borderColor: line,
    borderWidth: 0.5,
  });
  page.drawText(`Subtotal — ${paidLines.length} delivered parcels`, {
    x: M + PAD,
    y: y - 13.5,
    size: 9,
    font: bold,
    color: ink,
  });
  const totStr = money(paidCod - paidCharges);
  page.drawText(totStr, {
    x: rightEdge - PAD - bold.widthOfTextAtSize(totStr, 9),
    y: y - 13.5,
    size: 9,
    font: bold,
    color: green,
  });
  if (unpaidLines.length) {
    y -= 22;
    // NOTE: standard Helvetica is WinAnsi-encoded — stick to characters it can
    // represent (an arrow like U+2192 throws at draw time). Em dash / middot are fine.
    page.drawText(
      `Less charges on ${unpaidLines.length} undelivered parcels: - ${money(unpaidCharges)}` +
        `   ·   Net payable ${money(opts.totals.netPayable)}`,
      { x: M + PAD, y: y - 8, size: 8, font, color: grey },
    );
  }

  return Buffer.from(await doc.save());
}

/** dd-MMM (compact, for the line table). */
function fmtShort(d: Date): string {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}`;
}

/** Greedy word-wrap, mirroring the helper in pdf.util.ts. */
function wrapText(
  text: string,
  maxW: number,
  f: { widthOfTextAtSize: (t: string, s: number) => number },
  size: number,
): string[] {
  const words = (text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (f.widthOfTextAtSize(t, size) <= maxW) cur = t;
    else {
      if (cur) out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out;
}
