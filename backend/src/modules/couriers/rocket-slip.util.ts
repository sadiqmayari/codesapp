import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, RGB } from 'pdf-lib';
import * as bwipjs from 'bwip-js';

// CodesApp-designed Rocket shipping slip — generated in-app (replaces Rocket's
// own /pdfapi label). Mirrors the 3-column Rocket layout (Consignee/Client ·
// Tracking ID's · Details) with CodesApp branding, a Code128 + QR of the
// tracking number, and a Product list that GROWS the slip's height so a long
// order never clips. Slips are packed greedily onto A4 pages — as many as fit,
// each at its natural height (no scaling), so text stays a constant size.

export interface RocketSlipData {
  cn: string; // courier_tracking_number -> Code128 + QR
  destCity: string;
  originCity: string;
  consignee: string;
  consigneePhone: string;
  consigneeAddr: string;
  shipper: string;
  shipperPhone: string;
  shipperAddr: string;
  cod: number; // -> big number + Code128 barcode
  pieces: number;
  weight: string;
  customerRef: string;
  bookingDate: string;
  orderId: string;
  products: { qty: number; title: string }[]; // the expandable list
}

// ---- A4 + slip geometry (PDF points; 72pt = 1in) ----
const A4 = { w: 595.28, h: 841.89 };
const M = 20; // page margin
const PAGE_GAP = 10; // vertical gap between stacked slips
const SLIP_W = A4.w - M * 2;
const COL_W = SLIP_W / 3;
const COL_PAD = 7;
const COL_INNER = COL_W - COL_PAD * 2;

const HEAD_H = 34; // branding header band
const CBAR_H = 15; // orange column-title bar
const BODY_TOP = 7;
const BODY_BOT = 7;

const LH = 11; // body line height
const DROW = 13; // details key/value row height
const SUBH = 13; // sub-heading line height
const DIVH = 9; // consignee/shipper divider gap
const BC_H = 32; // tracking barcode height
const QR = 60; // QR size
const COD_BAR_W = 92;
const COD_BAR_H = 20;
const COD_BLOCK = 13 + COD_BAR_H + 3 + 23; // lbl + barcode + big amount (clear gap)

// ---- colours ----
const INK = rgb(0.08, 0.08, 0.1);
const GREY = rgb(0.37, 0.38, 0.42);
const LINE = rgb(0.79, 0.8, 0.83);
const SOFT = rgb(0.9, 0.91, 0.92);
const ORANGE = rgb(0.941, 0.502, 0.125); // #F08020
const BRAND = rgb(0.31, 0.275, 0.898); // #4f46e5
const RED = rgb(0.886, 0.231, 0.18); // courier name
const WHITE = rgb(1, 1, 1);

/** bwip-js -> PNG buffer, white bg, no padding. */
async function bwipPng(opts: Record<string, unknown>): Promise<Buffer> {
  return bwipjs.toBuffer({
    backgroundcolor: 'FFFFFF',
    paddingwidth: 0,
    paddingheight: 0,
    ...(opts as any),
  } as any);
}

/** Strip chars Helvetica (WinAnsi) can't encode so drawText never throws. */
const safe = (s: unknown): string =>
  String(s == null ? '' : s).replace(/[^\x20-\x7E -ÿ]/g, '');

/** Greedy word-wrap to a max pixel width (hard-breaks over-long words). */
function wrap(text: string, maxW: number, font: PDFFont, size: number): string[] {
  const words = safe(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) <= maxW) {
      cur = t;
    } else {
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
}

/** Clip a single line to fit (ellipsis-free trim). */
function clip(s: string, maxW: number, font: PDFFont, size: number): string {
  let t = safe(s);
  while (t.length && font.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -1);
  return t;
}

interface Fonts {
  font: PDFFont;
  bold: PDFFont;
}

/** Pre-computed wrapped text so measure + draw stay identical. */
interface SlipLayout {
  consigneeAddr: string[];
  shipperAddr: string[];
  productBlocks: string[][]; // one wrapped block per line-item
  col1H: number;
  col2H: number;
  col3H: number;
  totalH: number;
}

const FS = 8; // body font size

function computeLayout(data: RocketSlipData, f: Fonts): SlipLayout {
  const { font } = f;
  // label width budget for "Address: " value wrap (value continues under label)
  const consigneeAddr = wrap(data.consigneeAddr, COL_INNER, font, FS);
  const shipperAddr = wrap(data.shipperAddr, COL_INNER, font, FS);

  const products = data.products.length
    ? data.products
    : [{ qty: 0, title: '' }];
  const productBlocks = products.map((p) =>
    wrap(p.qty ? `${p.qty}x ${p.title}` : p.title, COL_INNER, font, FS),
  );

  // Col 1: Consignee Information + Shipper Information.
  const col1H =
    SUBH + // "Consignee Information"
    LH + // Name
    consigneeAddr.length * LH +
    LH + // Contact
    DIVH +
    SUBH + // "Shipper Information"
    LH + // Client
    shipperAddr.length * LH +
    LH; // Contact

  // Col 2: tracking (fixed) — must match the top-cursor draw decrements exactly.
  const col2H =
    15 + // LOGISTICS ORDER
    (BC_H + 2) + // barcode
    13 + // cn number
    (QR + 6) + // QR
    11 + // "Tracking ID"
    18 + // cn big
    11 + // "Destination"
    18; // dest city

  // Col 3: details + the expandable product list.
  const productLines = productBlocks.reduce((a, b) => a + b.length, 0);
  const col3H =
    DROW + // Pieces
    DROW + // Weight
    COD_BLOCK +
    DROW + // Customer Ref
    DROW + // Origin
    DROW + // Booking Date
    DROW + // Order ID
    13 + // "Product(s):"
    productLines * LH +
    (productBlocks.length - 1) * 2; // tiny gap between items

  const bodyH = Math.max(col1H, col2H, col3H);
  const totalH = HEAD_H + CBAR_H + BODY_TOP + bodyH + BODY_BOT;
  return { consigneeAddr, shipperAddr, productBlocks, col1H, col2H, col3H, totalH };
}

interface SlipAssets {
  cnImg: any;
  qrImg: any;
  codImg: any;
}

/**
 * Draw ONE slip with its top-left at (x0, yTop). `boxH` is the outer box height
 * (≥ the slip's natural height) — when several slips share a page they're all
 * given the SAME box height for a uniform look; content is top-aligned, so any
 * extra height is whitespace at the bottom. Returns the box height used.
 */
function drawSlip(
  page: PDFPage,
  doc: PDFDocument,
  x0: number,
  yTop: number,
  data: RocketSlipData,
  f: Fonts,
  layout: SlipLayout,
  assets: SlipAssets,
  boxH?: number,
): number {
  const { font, bold } = f;
  const H = Math.max(boxH ?? layout.totalH, layout.totalH);
  const x1 = x0 + SLIP_W;
  const bottom = yTop - H;

  const T = (s: string, x: number, yBase: number, size: number, fnt = font, color: RGB = INK) =>
    page.drawText(safe(s), { x, y: yBase, size, font: fnt, color });
  const Tc = (s: string, cx: number, yBase: number, size: number, fnt = font, color: RGB = INK) => {
    const w = fnt.widthOfTextAtSize(safe(s), size);
    page.drawText(safe(s), { x: cx - w / 2, y: yBase, size, font: fnt, color });
  };
  const hline = (y: number, xa: number, xb: number, color: RGB = LINE, thickness = 0.6) =>
    page.drawLine({ start: { x: xa, y }, end: { x: xb, y }, thickness, color });
  const vline = (x: number, ya: number, yb: number, color: RGB = LINE) =>
    page.drawLine({ start: { x, y: ya }, end: { x, y: yb }, thickness: 0.6, color });

  // ---- outer box ----
  page.drawRectangle({ x: x0, y: bottom, width: SLIP_W, height: H, borderColor: INK, borderWidth: 1.2 });

  // ---- header band ----
  const headTop = yTop;
  const headBot = yTop - HEAD_H;
  hline(headBot, x0, x1, INK, 1.2);
  // CodesApp branding (left)
  const logoX = x0 + 9;
  const logoY = headBot + (HEAD_H - 20) / 2;
  page.drawRectangle({ x: logoX, y: logoY, width: 20, height: 20, color: BRAND });
  Tc('C', logoX + 10, logoY + 6, 12, bold, WHITE);
  T('CodesApp', logoX + 26, headBot + HEAD_H / 2 - 4, 12, bold, INK);
  // Centre title
  Tc('COD PARCEL', x0 + SLIP_W / 2, headBot + HEAD_H / 2 + 1, 11, bold, INK);
  Tc('(HANDLE WITH CARE)', x0 + SLIP_W / 2, headBot + HEAD_H / 2 - 10, 7.5, bold, GREY);
  // Courier name (right)
  const cName = 'Rocket';
  const cw = bold.widthOfTextAtSize(cName, 13);
  T(cName, x1 - 10 - cw, headBot + HEAD_H / 2, 13, bold, RED);
  const subW = font.widthOfTextAtSize('LOGISTICS', 6);
  T('LOGISTICS', x1 - 10 - subW, headBot + HEAD_H / 2 - 9, 6, font, GREY);

  // ---- column title bars ----
  const colX = [x0, x0 + COL_W, x0 + COL_W * 2];
  const barBot = headBot - CBAR_H;
  const titles = ["Consignee / Client", "Tracking ID's", 'Details'];
  titles.forEach((t, i) => {
    page.drawRectangle({ x: colX[i], y: barBot, width: COL_W, height: CBAR_H, color: ORANGE });
    Tc(t, colX[i] + COL_W / 2, barBot + 4, 9, bold, WHITE);
  });
  // column separators (below the bars, down to slip bottom)
  vline(colX[1], barBot + CBAR_H, bottom);
  vline(colX[2], barBot + CBAR_H, bottom);

  const bodyTop = barBot - BODY_TOP;

  // ---- Col 1: Consignee + Shipper ----
  {
    const cx = colX[0] + COL_PAD;
    const cxCenter = colX[0] + COL_W / 2;
    let y = bodyTop - 9;
    Tc('Consignee Information', cxCenter, y, 8.5, bold, INK);
    y -= SUBH;
    const kv = (label: string, val: string) => {
      T(label, cx, y, FS, bold, INK);
      const aw = bold.widthOfTextAtSize(label, FS);
      T(clip(val, COL_INNER - aw, font, FS), cx + aw + 2, y, FS, font, INK);
      y -= LH;
    };
    kv('Name: ', data.consignee);
    // Address (wrapped)
    T('Address: ', cx, y, FS, bold, INK);
    const aw = bold.widthOfTextAtSize('Address: ', FS);
    layout.consigneeAddr.forEach((ln, i) => {
      T(ln, i === 0 ? cx + aw + 2 : cx, y, FS, font, INK);
      y -= LH;
    });
    kv('Contact: ', data.consigneePhone);
    // divider
    y -= 2;
    hline(y + 6, cx, colX[1] - COL_PAD, SOFT);
    y -= DIVH - 2;
    Tc('Shipper Information', cxCenter, y, 8.5, bold, INK);
    y -= SUBH;
    kv('Client: ', data.shipper);
    T('Address: ', cx, y, FS, bold, INK);
    layout.shipperAddr.forEach((ln, i) => {
      T(ln, i === 0 ? cx + aw + 2 : cx, y, FS, font, INK);
      y -= LH;
    });
    kv('Contact: ', data.shipperPhone);
  }

  // ---- Col 2: Tracking (top-cursor so the last line never spills out the box) ----
  {
    const cxCenter = colX[1] + COL_W / 2;
    const cx = colX[1] + COL_PAD;
    let y = bodyTop;
    Tc('LOGISTICS ORDER', cxCenter, y - 11, 11, bold, INK);
    y -= 15;
    // tracking barcode (full column width, fixed height)
    page.drawImage(assets.cnImg, { x: cx, y: y - BC_H, width: COL_INNER, height: BC_H });
    y -= BC_H + 2;
    Tc(data.cn, cxCenter, y - 9, 9, font, INK);
    y -= 13;
    page.drawImage(assets.qrImg, { x: cxCenter - QR / 2, y: y - QR, width: QR, height: QR });
    y -= QR + 6;
    Tc('Tracking ID', cxCenter, y - 8, 8, bold, GREY);
    y -= 11;
    Tc(data.cn, cxCenter, y - 14, 14, bold, INK);
    y -= 18;
    Tc('Destination', cxCenter, y - 8, 8, bold, GREY);
    y -= 11;
    Tc(safe(data.destCity).toUpperCase(), cxCenter, y - 14, 14, bold, INK);
    y -= 18;
  }

  // ---- Col 3: Details + Products ----
  // Top-cursor model: `y` is the TOP of the next element; each draw decrements it.
  {
    const cx = colX[2] + COL_PAD;
    const cxRight = x1 - COL_PAD;
    let y = bodyTop;
    const drow = (label: string, val: string, valColor: RGB = INK) => {
      const base = y - 9;
      T(label, cx, base, FS, bold, GREY);
      const vs = clip(val, COL_INNER - bold.widthOfTextAtSize(label, FS) - 4, font, FS);
      const vw = font.widthOfTextAtSize(vs, FS);
      T(vs, cxRight - vw, base, FS, font, valColor);
      y -= DROW;
      hline(y + 3, cx, cxRight, SOFT);
    };
    drow('Pieces:', `${data.pieces} Pcs`);
    drow('Weight:', data.weight);
    // COD block — label, barcode, then the big amount with a generous gap so it
    // never collides with the Customer Ref row below.
    T('COD Amount:', cx, y - 8, 8, bold, GREY);
    y -= 13;
    page.drawImage(assets.codImg, { x: cx, y: y - COD_BAR_H, width: COD_BAR_W, height: COD_BAR_H });
    y -= COD_BAR_H + 3;
    T('Rs ' + Math.round(data.cod).toLocaleString(), cx, y - 16, 18, bold, INK);
    y -= 23;
    hline(y + 5, cx, cxRight, SOFT);
    drow('Customer Ref:', data.customerRef);
    drow('Origin:', safe(data.originCity).toUpperCase());
    drow('Booking Date:', data.bookingDate);
    drow('Order ID:', data.orderId);
    // Products (expandable)
    T('Product' + (data.products.length > 1 ? 's' : '') + ':', cx, y - 9, 8.5, bold, INK);
    y -= 13;
    layout.productBlocks.forEach((block) => {
      block.forEach((ln) => {
        T(ln, cx, y - 8, FS, font, INK);
        y -= LH;
      });
      y -= 2;
    });
  }

  return H;
}

/**
 * Build ONE downloadable PDF of CodesApp Rocket slips, greedily packed onto A4
 * pages (as many as fit per page, each at its natural height). The product list
 * grows the slip, so long orders list every item and simply take more room.
 */
export async function buildRocketSlipSheetPdf(slips: RocketSlipData[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const f: Fonts = { font, bold };

  // Pre-compute layout + embed barcodes/QR for each slip.
  const prepared: Array<{ data: RocketSlipData; layout: SlipLayout; assets: SlipAssets }> = [];
  for (const data of slips) {
    const layout = computeLayout(data, f);
    const cnText = safe(data.cn) || '0';
    const codText = String(Math.round(data.cod) || 0);
    const [cnImg, qrImg, codImg] = await Promise.all([
      bwipPng({ bcid: 'code128', text: cnText, includetext: false, height: 9, scale: 3 }).then((b) =>
        doc.embedPng(b),
      ),
      bwipPng({ bcid: 'qrcode', text: cnText, scale: 4 }).then((b) => doc.embedPng(b)),
      bwipPng({ bcid: 'code128', text: codText, includetext: false, height: 7, scale: 2 }).then((b) =>
        doc.embedPng(b),
      ),
    ]);
    prepared.push({ data, layout, assets: { cnImg, qrImg, codImg } });
  }

  // ---- group slips into pages ----
  // A page holds n slips only if n EQUAL boxes (each the tallest slip on the
  // page) + (n+1) minimum gaps still fit the usable height. This keeps every
  // box on a page the same size no matter the product-list length.
  const usable = A4.h - M * 2;
  type Prepared = (typeof prepared)[number];
  const pages: Prepared[][] = [];
  let cur: Prepared[] = [];
  let curMax = 0;
  for (const p of prepared) {
    const h = p.layout.totalH;
    const n = cur.length + 1;
    const newMax = Math.max(curMax, h);
    if (cur.length && n * newMax + (n + 1) * PAGE_GAP > usable) {
      pages.push(cur);
      cur = [];
      curMax = 0;
    }
    cur.push(p);
    curMax = Math.max(curMax, h);
  }
  if (cur.length) pages.push(cur);

  // ---- draw each page: equal box height + equally-divided gaps ----
  for (const pageSlips of pages) {
    const page = doc.addPage([A4.w, A4.h]);
    const n = pageSlips.length;
    if (n === 1) {
      // Lone slip: natural height, pinned near the top.
      const p = pageSlips[0];
      drawSlip(page, doc, M, A4.h - M - PAGE_GAP, p.data, f, p.layout, p.assets);
      continue;
    }
    const boxH = Math.max(...pageSlips.map((p) => p.layout.totalH));
    const leftover = Math.max(0, usable - n * boxH);
    const gap = leftover / (n + 1); // equal gap above, between and below
    let yTop = A4.h - M - gap;
    for (const p of pageSlips) {
      drawSlip(page, doc, M, yTop, p.data, f, p.layout, p.assets, boxH);
      yTop -= boxH + gap;
    }
  }

  return Buffer.from(await doc.save());
}
