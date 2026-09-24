import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// A4 portrait in PDF points (72pt = 1in).
const A4 = { w: 595.28, h: 841.89 };

/**
 * Returns Received sheet (RTO goods-inward). One downloadable PDF for a batch of
 * scanned/received returns: a per-parcel MANIFEST grouped by courier (what came
 * back, from which courier) + an aggregated RESTOCK PICKLIST (units per product
 * to put back to stock).
 */
export interface ReturnsParcelRow {
  orderName: string;
  tracking: string;
  courier: string; // display name
  customer: string;
  city: string;
  items: string; // "2x Product (Variant) · 1x Other"
  units: number | null;
}
export interface ReturnsPickRow {
  product: string;
  variant: string | null;
  units: number;
  couriers: string; // "Trax 3 · PostEx 1"
}

// Helvetica (WinAnsi) can't encode chars outside Latin-1 (emoji, Urdu/CJK
// names) and throws on draw. Keep printable ASCII + Latin-1, replace the rest.
const wa = (s: unknown): string =>
  String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

type TableCol = { title: string; w: number; align?: 'l' | 'r' };
type TableRow = { cells: string[]; bold?: boolean; fill?: boolean; wrapIdx?: number };

export async function buildReturnsSheetPdf(opts: {
  companyName: string;
  dateLabel: string;
  parcels: ReturnsParcelRow[]; // pre-sorted by courier
  pickRows: ReturnsPickRow[]; // pre-sorted (units desc)
  totals: { parcels: number; units: number; couriers: number; skus: number };
}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M = 30;
  const ink = rgb(0.1, 0.1, 0.12);
  const grey = rgb(0.42, 0.42, 0.46);
  const line = rgb(0.82, 0.82, 0.86);
  const headBg = rgb(0.95, 0.95, 0.965);
  const FS = 9;
  const LH = 11.5;
  const usable = A4.w - M * 2;
  const rightEdge = A4.w - M;

  const wrap = (text: string, maxW: number, size = FS): string[] => {
    const words = wa(text).split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(t, size) <= maxW) cur = t;
      else {
        if (cur) lines.push(cur);
        let word = w;
        while (font.widthOfTextAtSize(word, size) > maxW && word.length > 1) {
          let cut = word.length;
          while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > maxW) cut--;
          lines.push(word.slice(0, cut));
          word = word.slice(cut);
        }
        cur = word;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };

  let page = doc.addPage([A4.w, A4.h]);
  let y = A4.h - M;
  const newPage = () => {
    page = doc.addPage([A4.w, A4.h]);
    y = A4.h - M;
  };
  const ensure = (h: number) => {
    if (y - h < M) newPage();
  };

  // ── Document header ──
  page.drawText('Returns Received', { x: M, y: y - 18, size: 20, font: bold, color: ink });
  const compW = bold.widthOfTextAtSize(wa(opts.companyName), 11);
  page.drawText(wa(opts.companyName), { x: rightEdge - compW, y: y - 6, size: 11, font: bold, color: ink });
  const dateW = font.widthOfTextAtSize(wa(opts.dateLabel), 10);
  page.drawText(wa(opts.dateLabel), { x: rightEdge - dateW, y: y - 20, size: 10, font, color: grey });
  y -= 30;
  const summary = `${opts.totals.parcels} parcels  ·  ${opts.totals.units} units  ·  ${opts.totals.couriers} couriers  ·  ${opts.totals.skus} SKUs`;
  page.drawText(wa(summary), { x: M, y: y - 6, size: 10, font: bold, color: grey });
  y -= 22;
  page.drawLine({ start: { x: M, y }, end: { x: rightEdge, y }, thickness: 1, color: ink });
  y -= 18;

  // Generic table drawer. The column at `wrapIdx` wraps; others are single-line.
  const drawTable = (title: string, cols: TableCol[], rows: TableRow[]) => {
    ensure(30);
    page.drawText(wa(title), { x: M, y: y - 11, size: 12, font: bold, color: ink });
    y -= 22;
    const xOf: number[] = [];
    let acc = M;
    for (const c of cols) {
      xOf.push(acc);
      acc += c.w;
    }
    const drawHead = () => {
      ensure(18);
      page.drawRectangle({ x: M, y: y - 15, width: usable, height: 15, color: headBg });
      cols.forEach((c, i) => {
        const tw = c.align === 'r' ? bold.widthOfTextAtSize(c.title, 8) : 0;
        page.drawText(c.title, {
          x: c.align === 'r' ? xOf[i] + c.w - 5 - tw : xOf[i] + 4,
          y: y - 11,
          size: 8,
          font: bold,
          color: grey,
        });
      });
      y -= 15;
    };
    drawHead();
    for (const r of rows) {
      const wi = r.wrapIdx ?? -1;
      const wrapped = wi >= 0 ? wrap(r.cells[wi], cols[wi].w - 8) : [''];
      const rowH = Math.max(LH + 5, (wi >= 0 ? wrapped.length : 1) * LH + 5);
      if (y - rowH < M) {
        newPage();
        drawHead();
      }
      if (r.fill) page.drawRectangle({ x: M, y: y - rowH, width: usable, height: rowH, color: rgb(0.965, 0.965, 0.945) });
      const f = r.bold ? bold : font;
      cols.forEach((c, i) => {
        if (i === wi) {
          wrapped.forEach((ln, k) => page.drawText(ln, { x: xOf[i] + 4, y: y - 9 - k * LH, size: FS, font: f, color: ink }));
        } else {
          const txt = wa(r.cells[i] ?? '');
          const tw = c.align === 'r' ? f.widthOfTextAtSize(txt, FS) : 0;
          page.drawText(txt, {
            x: c.align === 'r' ? xOf[i] + c.w - 5 - tw : xOf[i] + 4,
            y: y - 9,
            size: FS,
            font: f,
            color: ink,
          });
        }
      });
      y -= rowH;
      page.drawLine({ start: { x: M, y }, end: { x: rightEdge, y }, thickness: 0.5, color: line });
    }
    y -= 16;
  };

  // ── Section 1: Manifest grouped by courier ──
  const manCols: TableCol[] = [
    { title: 'ORDER', w: 58 },
    { title: 'AWB / CN', w: 92 },
    { title: 'CUSTOMER', w: 95 },
    { title: 'CITY', w: 68 },
    { title: 'ITEMS', w: usable - 58 - 92 - 95 - 68 - 42 },
    { title: 'UNITS', w: 42, align: 'r' },
  ];
  const byCourier = new Map<string, ReturnsParcelRow[]>();
  for (const p of opts.parcels) {
    const k = p.courier || '—';
    const arr = byCourier.get(k);
    if (arr) arr.push(p);
    else byCourier.set(k, [p]);
  }
  ensure(24);
  page.drawText('Manifest — by courier', { x: M, y: y - 12, size: 13, font: bold, color: ink });
  y -= 24;
  for (const [courier, list] of byCourier) {
    const units = list.reduce((s, p) => s + (p.units ?? 0), 0);
    const rows: TableRow[] = list.map((p) => ({
      cells: [p.orderName, p.tracking, p.customer, p.city, p.items, p.units == null ? '' : String(p.units)],
      wrapIdx: 4,
    }));
    rows.push({
      cells: [`${courier} subtotal`, '', '', '', `${list.length} parcels`, String(units)],
      bold: true,
      fill: true,
    });
    drawTable(`${courier}  ·  ${list.length} parcels · ${units} units`, manCols, rows);
  }

  // ── Section 2: Restock picklist ──
  const pickCols: TableCol[] = [
    { title: 'PRODUCT', w: 200 },
    { title: 'VARIANT', w: 110 },
    { title: 'UNITS', w: 45, align: 'r' },
    { title: 'FROM COURIERS', w: usable - 200 - 110 - 45 },
  ];
  const pickRows: TableRow[] = opts.pickRows.map((r) => ({
    cells: [r.product, r.variant ?? '—', String(r.units), r.couriers],
    wrapIdx: 3,
  }));
  pickRows.push({
    cells: ['Total units', '', String(opts.totals.units), `${opts.totals.parcels} parcels`],
    bold: true,
    fill: true,
  });
  drawTable('Restock picklist — put back to stock', pickCols, pickRows);

  return Buffer.from(await doc.save());
}
