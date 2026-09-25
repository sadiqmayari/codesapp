import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as bwipjs from 'bwip-js';
import { MNP_LOGO_PNG_B64, MNP_URDU_NOTE_PNG_B64 } from './assets/mnp-slip-assets';

// M&P shipping slip — generated in-app because M&P has NO label/AWB PDF API.
// Laid out to match M&P's own printed slip (wide 2:1 label). The generateLabels /
// generateSlipSheet ops 2-up these onto A4 via the existing pdf.util pipeline.

export interface MnpSlipData {
  cn: string;
  service: string;
  destCity: string;
  originCity: string;
  consignee: string;
  consigneePhone: string;
  consigneeAddr: string;
  shipper: string;
  shipperPhone: string;
  shipperAddr: string;
  cod: number;
  pieces: number;
  weight: string;
  returnBranch: string;
  returnAddr: string;
  printOn: string;
  orderId: string;
  product: string;
  remarks?: string;
}

/** bwip-js -> PNG buffer (Code39 / QR), white bg, no padding. */
async function bwipPng(opts: Record<string, unknown>): Promise<Buffer> {
  return bwipjs.toBuffer({
    backgroundcolor: 'FFFFFF',
    paddingwidth: 0,
    paddingheight: 0,
    ...(opts as any),
  } as any);
}

/**
 * Render ONE M&P shipping slip as a single-page PDF: logo + centered CN Code39
 * barcode, To/OVERNIGHT/From, consignee + QR (encodes the CN) + shipper,
 * COD/pieces/weight/return, remarks/print+order-barcode/product, and the Urdu
 * disclaimer footer (baked image — pdf-lib's built-in fonts can't shape Arabic).
 */
export async function buildMnpSlipPdf(data: MnpSlipData): Promise<Buffer> {
  const W = 576;
  const H = 288;
  const ink = rgb(0.07, 0.07, 0.09);
  const grey = rgb(0.38, 0.38, 0.43);
  const line = rgb(0.72, 0.72, 0.76);
  const DIV1 = 222;
  const DIV2 = 353;

  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const bold = await d.embedFont(StandardFonts.HelveticaBold);
  const page = d.addPage([W, H]);
  const top = (y: number) => H - y;
  const logo = await d.embedPng(Buffer.from(MNP_LOGO_PNG_B64, 'base64'));
  const urduImg = await d.embedPng(Buffer.from(MNP_URDU_NOTE_PNG_B64, 'base64'));

  // Strip chars Helvetica (WinAnsi) can't encode so drawText never throws.
  const safe = (s: unknown) =>
    String(s == null ? '' : s).replace(/[^\x20-\x7E -ÿ]/g, '');
  const T = (s: string, x: number, y: number, size: number, f = font, color = ink) =>
    page.drawText(safe(s), { x, y: top(y), size, font: f, color });
  const Tc = (s: string, cx: number, y: number, size: number, f = font, color = ink) => {
    const w = f.widthOfTextAtSize(safe(s), size);
    page.drawText(safe(s), { x: cx - w / 2, y: top(y), size, font: f, color });
  };
  const LV = (label: string, val: string, x: number, y: number, size = 8.5) => {
    T(label, x, y, size, bold);
    T(val, x + bold.widthOfTextAtSize(safe(label), size) + 3, y, size, font);
  };
  const labelWrap = (
    label: string,
    val: string,
    x: number,
    y: number,
    colRight: number,
    size = 8.5,
    lh = 11,
  ) => {
    T(label, x, y, size, bold);
    const aw = bold.widthOfTextAtSize(safe(label), size);
    const firstMax = colRight - (x + aw + 3);
    const restMax = colRight - x;
    const words = safe(val).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = '';
    let max = firstMax;
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(t, size) <= max) cur = t;
      else {
        if (cur) lines.push(cur);
        cur = w;
        max = restMax;
      }
    }
    if (cur) lines.push(cur);
    lines.forEach((ln, i) => T(ln, i === 0 ? x + aw + 3 : x, y + i * lh, size));
  };
  const hline = (y: number, x1 = 0, x2 = W) =>
    page.drawLine({ start: { x: x1, y: top(y) }, end: { x: x2, y: top(y) }, thickness: 0.7, color: line });
  const vline = (x: number, y1: number, y2: number) =>
    page.drawLine({ start: { x, y: top(y1) }, end: { x, y: top(y2) }, thickness: 0.7, color: line });
  const wrap = (s: string, maxW: number, f = font, size = 8): string[] => {
    const words = safe(s).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(t, size) <= maxW) cur = t;
      else {
        if (cur) lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };

  const B = { header: 54, city: 84, details: 176, cod: 214, foot: 262 };

  // Header: logo + centered CN barcode.
  const lgH = 40;
  const ls = lgH / logo.height;
  page.drawImage(logo, { x: 12, y: top(8 + logo.height * ls), width: logo.width * ls, height: logo.height * ls });
  const cnImg = await d.embedPng(
    await bwipPng({ bcid: 'code39', text: data.cn, includetext: true, textxalign: 'center', height: 10, scale: 3 }),
  );
  const cw = 248;
  const ch = cw * (cnImg.height / cnImg.width);
  page.drawImage(cnImg, { x: (W - cw) / 2, y: top(6 + ch), width: cw, height: ch });
  hline(B.header);

  // City row.
  T('To:', 8, 77, 8, bold, grey);
  Tc(data.destCity, DIV1 / 2 + 12, 77, 13, bold);
  Tc(data.service, (DIV1 + DIV2) / 2, 77, 12, bold);
  T('From:', DIV2 + 7, 77, 8, bold, grey);
  Tc(data.originCity, (DIV2 + W) / 2 + 14, 77, 13, bold);
  hline(B.city);
  vline(DIV1, B.header, B.foot);
  vline(DIV2, B.header, B.foot);

  // Details.
  let y = 100;
  LV('Consignee: ', data.consignee, 8, y, 8.5);
  y += 14;
  LV('Contact: ', data.consigneePhone, 8, y, 8.5);
  y += 14;
  labelWrap('Address: ', data.consigneeAddr, 8, y, DIV1 - 8, 8.5, 11);
  const rx = DIV2 + 7;
  let ry = 100;
  LV('Shipper: ', data.shipper, rx, ry, 8.5);
  ry += 14;
  LV('Contact: ', data.shipperPhone, rx, ry, 8.5);
  ry += 14;
  labelWrap('Address: ', data.shipperAddr, rx, ry, W - 8, 8.5, 11);
  const q = 80;
  const qx = DIV1 + (DIV2 - DIV1 - q) / 2;
  page.drawImage(await d.embedPng(await bwipPng({ bcid: 'qrcode', text: data.cn, scale: 4 })), {
    x: qx,
    y: top(92 + q),
    width: q,
    height: q,
  });
  hline(B.details);

  // COD / Pieces-Weight / Return.
  T('COD Amount:', 8, 190, 8.5, bold, grey);
  T('Rs ' + Math.round(data.cod).toLocaleString(), 8, 209, 16, bold);
  Tc('Pieces: ' + data.pieces + '      Weight: ' + data.weight, (DIV1 + DIV2) / 2, 197, 9, bold);
  LV('Return Branch: ', data.returnBranch, rx, 191, 8.5);
  labelWrap('Address: ', data.returnAddr, rx, 206, W - 8, 8.5, 11);
  hline(B.cod);

  // Remarks / Print+Order / Product.
  T('Remarks:', 8, 227, 8.5, bold);
  if (data.remarks) {
    let py = 239;
    for (const ln of wrap(data.remarks, DIV1 - 16)) {
      T(ln, 8, py, 8);
      py += 10;
    }
  }
  T('Print On : ' + data.printOn, DIV1 + 6, 226, 7.5);
  LV('Order ID : ', data.orderId, DIV1 + 6, 237, 8);
  const oidImg = await d.embedPng(
    await bwipPng({
      bcid: 'code39',
      text: data.orderId.replace(/[^0-9A-Za-z]/g, '') || '0',
      includetext: true,
      textxalign: 'center',
      height: 5,
      scale: 2,
    }),
  );
  const ow = 92;
  const oh = ow * (oidImg.height / oidImg.width);
  page.drawImage(oidImg, { x: (DIV1 + DIV2) / 2 - ow / 2, y: top(240 + oh), width: ow, height: oh });
  T('Product:', rx, 226, 8.5, bold);
  {
    let py = 238;
    for (const ln of wrap(data.product, W - 8 - rx, font, 8.5)) {
      T(ln, rx, py, 8.5);
      py += 11;
    }
  }
  hline(B.foot);

  // Footer: Urdu disclaimer (baked image).
  const uw = W - 16;
  const uh = Math.min(uw * (urduImg.height / urduImg.width), 20);
  page.drawImage(urduImg, { x: 8, y: top(264 + uh) + (20 - uh) / 2, width: uw, height: uh });

  page.drawRectangle({ x: 0.6, y: 0.6, width: W - 1.2, height: H - 1.2, borderColor: ink, borderWidth: 1.1 });

  return Buffer.from(await d.save());
}
