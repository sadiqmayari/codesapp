import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// A4 portrait in PDF points (72pt = 1in).
const A4 = { w: 595.28, h: 841.89 };
const GAP = 18;

/**
 * Compose one downloadable PDF that lays the courier's own slip/label pages
 * TWO-PER-A4-PAGE (top + bottom), preserving each slip's aspect ratio. `sources`
 * is an ordered list of courier label PDFs — for Trax that's one buffer per
 * parcel (single page each), for PostEx/Rocket a combined multi-page buffer;
 * either way every page of every source is flattened in order and paginated 2-up.
 * The courier's artwork is embedded as-is (vector, scannable barcode intact) —
 * we only scale + position it, never re-render it.
 */
export async function compose2Up(
  sources: Buffer[],
  opts: {
    /** Keep only the TOP fraction of each source page (crop away trailing
     *  whitespace). Rocket prints one label in the top ~47% of a full A4 page;
     *  without cropping, fitting the whole page to a half-A4 slot shrinks the
     *  label to ~half size. 0.47 keeps the label, drops the blank tear-off. */
    cropTopFraction?: number;
  } = {},
): Promise<Buffer> {
  const out = await PDFDocument.create();
  const embedded = [];
  for (const buf of sources) {
    let src: PDFDocument;
    try {
      src = await PDFDocument.load(buf, { ignoreEncryption: true });
    } catch {
      continue; // skip an unreadable/HTML slip rather than fail the whole sheet
    }
    const pages = src.getPages();
    if (!pages.length) continue;
    let boxes: Array<{ left: number; bottom: number; right: number; top: number }> | undefined;
    if (opts.cropTopFraction && opts.cropTopFraction > 0 && opts.cropTopFraction < 1) {
      boxes = pages.map((p) => {
        const w = p.getWidth();
        const h = p.getHeight();
        return { left: 0, bottom: h * (1 - opts.cropTopFraction!), right: w, top: h };
      });
    }
    const eps = await out.embedPages(pages, boxes);
    embedded.push(...eps);
  }
  if (!embedded.length) {
    throw new Error('No printable label pages could be read for these parcels.');
  }

  const slotH = (A4.h - GAP * 3) / 2; // two slots, gaps top/middle/bottom
  const slotW = A4.w - GAP * 2;
  for (let i = 0; i < embedded.length; i += 2) {
    const page = out.addPage([A4.w, A4.h]);
    const pair = embedded.slice(i, i + 2);
    pair.forEach((ep, k) => {
      const scale = Math.min(slotW / ep.width, slotH / ep.height, 1.6);
      const w = ep.width * scale;
      const h = ep.height * scale;
      const x = (A4.w - w) / 2;
      const slotBottomY = k === 0 ? A4.h - GAP - slotH : GAP;
      const y = slotBottomY + (slotH - h) / 2;
      page.drawPage(ep, { x, y, width: w, height: h });
    });
  }
  return Buffer.from(await out.save());
}

/**
 * Merge courier label PDFs into ONE file WITHOUT re-laying-out — every page of
 * every source is copied through unchanged. Used for couriers whose label PDF is
 * already print-ready (Rocket lays out 2 labels per A4 page itself, so running
 * `compose2Up` on it would crop away half the labels). Preserves the courier's
 * artwork + barcodes exactly.
 */
export async function mergePdfsAsIs(sources: Buffer[]): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const buf of sources) {
    let src: PDFDocument;
    try {
      src = await PDFDocument.load(buf, { ignoreEncryption: true });
    } catch {
      continue; // skip an unreadable slip rather than fail the whole sheet
    }
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  if (!out.getPageCount()) {
    throw new Error('No printable label pages could be read for these parcels.');
  }
  return Buffer.from(await out.save());
}

export interface ManifestRow {
  tracking: string;
  order: string | null;
  city: string | null;
  cod: number | null;
}

/**
 * A dispatch MANIFEST (load sheet) we generate ourselves when the courier has no
 * loadsheet API (Rocket) or its manifest PDF couldn't be fetched (Trax fallback):
 * a numbered table of parcels — Tracking · Order · City · COD — with a total.
 * Bordered, paginated, in the tenant's format (company + date + courier).
 */
export async function buildManifestPdf(opts: {
  companyName: string;
  courierName: string;
  dateLabel: string;
  rows: ManifestRow[];
  currency: string;
}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const M = 32;
  const ink = rgb(0.1, 0.1, 0.12);
  const grey = rgb(0.42, 0.42, 0.46);
  const line = rgb(0.8, 0.8, 0.84);
  const headBg = rgb(0.96, 0.96, 0.97);
  const usable = A4.w - M * 2;
  const rightEdge = A4.w - M;
  const PAD = 6;
  const FS = 9;

  const cols = [
    { key: 'n', title: '#', w: 34 },
    { key: 'tracking', title: 'Tracking', w: 150 },
    { key: 'order', title: 'Order', w: 90 },
    { key: 'city', title: 'City', w: usable - 34 - 150 - 90 - 90 },
    { key: 'cod', title: 'COD', w: 90 },
  ];
  const xOf: Record<string, number> = {};
  let acc = M;
  for (const c of cols) {
    xOf[c.key] = acc;
    acc += c.w;
  }
  const clip = (s: string, maxW: number, f = font, size = FS): string => {
    let t = s ?? '';
    while (t.length && f.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -1);
    return t;
  };

  let page = doc.addPage([A4.w, A4.h]);
  let y = A4.h - M;
  page.drawText('Load Sheet', { x: M, y: y - 16, size: 20, font: bold, color: ink });
  const compW = bold.widthOfTextAtSize(opts.companyName, 11);
  page.drawText(opts.companyName, { x: rightEdge - compW, y: y - 6, size: 11, font: bold, color: ink });
  const dW = font.widthOfTextAtSize(opts.dateLabel, 10);
  page.drawText(opts.dateLabel, { x: rightEdge - dW, y: y - 20, size: 10, font, color: grey });
  y -= 30;
  page.drawText(`Courier: ${opts.courierName}`, { x: M, y: y - 6, size: 11, font: bold, color: grey });
  y -= 26;

  const rowH = 20;
  const drawHead = () => {
    page.drawRectangle({ x: M, y: y - rowH, width: usable, height: rowH, color: headBg, borderColor: line, borderWidth: 0.5 });
    for (const c of cols) {
      if (c.key === 'cod') {
        page.drawText(c.title, { x: rightEdge - PAD - bold.widthOfTextAtSize(c.title, FS), y: y - 13, size: FS, font: bold, color: ink });
      } else {
        page.drawText(c.title, { x: xOf[c.key] + PAD, y: y - 13, size: FS, font: bold, color: ink });
      }
    }
    y -= rowH;
  };
  drawHead();

  let totalCod = 0;
  opts.rows.forEach((r, i) => {
    if (y - rowH < M + 24) {
      page = doc.addPage([A4.w, A4.h]);
      y = A4.h - M;
      drawHead();
    }
    page.drawRectangle({ x: M, y: y - rowH, width: usable, height: rowH, borderColor: line, borderWidth: 0.5 });
    for (const c of cols.slice(1)) {
      page.drawLine({ start: { x: xOf[c.key], y }, end: { x: xOf[c.key], y: y - rowH }, thickness: 0.5, color: line });
    }
    const ty = y - 13;
    page.drawText(String(i + 1), { x: xOf['n'] + PAD, y: ty, size: FS, font, color: grey });
    page.drawText(clip(r.tracking, cols[1].w - PAD * 2), { x: xOf['tracking'] + PAD, y: ty, size: FS, font: bold, color: ink });
    page.drawText(clip(r.order || '—', cols[2].w - PAD * 2), { x: xOf['order'] + PAD, y: ty, size: FS, font, color: ink });
    page.drawText(clip(r.city || '—', cols[3].w - PAD * 2), { x: xOf['city'] + PAD, y: ty, size: FS, font, color: ink });
    const codStr = r.cod != null ? `${opts.currency} ${Number(r.cod).toLocaleString()}` : '—';
    if (r.cod != null) totalCod += r.cod;
    page.drawText(codStr, { x: rightEdge - PAD - font.widthOfTextAtSize(codStr, FS), y: ty, size: FS, font, color: ink });
    y -= rowH;
  });

  // Total row
  if (y - rowH < M) {
    page = doc.addPage([A4.w, A4.h]);
    y = A4.h - M;
  }
  page.drawRectangle({ x: M, y: y - rowH, width: usable, height: rowH, color: headBg, borderColor: line, borderWidth: 0.5 });
  page.drawText(`Total: ${opts.rows.length} parcels`, { x: M + PAD, y: y - 13, size: 10, font: bold, color: ink });
  const tStr = `${opts.currency} ${totalCod.toLocaleString()}`;
  page.drawText(tStr, { x: rightEdge - PAD - bold.widthOfTextAtSize(tStr, 10), y: y - 13, size: 10, font: bold, color: ink });

  return Buffer.from(await doc.save());
}

export interface PicklistRow {
  product: string;
  variant?: string | null;
  qty: number;
  /** Order names this product appears in (e.g. ["#34659","#34660"]). */
  orders: string[];
  /** Optional product/variant image to render in the first column. */
  image?: { bytes: Buffer; mime: string } | null;
}

/**
 * A warehouse pick sheet in the tenant's format: Image | Product Title | Variant
 * | Order | Qty, with the company name + date top-right, the courier under the
 * title, and a TOTAL row at the end. One row per product/variant with the total
 * quantity to pick across every parcel on a loadsheet. Generated by us (the
 * couriers don't provide it) — bordered, paginated, images best-effort.
 */
export async function buildPicklistPdf(opts: {
  companyName: string;
  courierName: string;
  dateLabel: string;
  rows: PicklistRow[];
  totalUnits: number;
}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M = 30;
  const ink = rgb(0.1, 0.1, 0.12);
  const grey = rgb(0.42, 0.42, 0.46);
  const line = rgb(0.8, 0.8, 0.84);
  const headBg = rgb(0.96, 0.96, 0.97);

  // Columns (sum of widths = usable width). Image | Product | Variant | Order | Qty.
  const usable = A4.w - M * 2;
  const cols = [
    { key: 'image', title: 'Image', w: 58 },
    { key: 'product', title: 'Product Title', w: 168 },
    { key: 'variant', title: 'Variant', w: 78 },
    { key: 'order', title: 'Order', w: 168 },
    { key: 'qty', title: 'Qty', w: usable - 58 - 168 - 78 - 168 },
  ];
  const xOf: Record<string, number> = {};
  let acc = M;
  for (const c of cols) {
    xOf[c.key] = acc;
    acc += c.w;
  }
  const rightEdge = A4.w - M;
  const PAD = 6;
  const FS = 9; // body font size
  const LH = 12; // line height

  // Greedy word-wrap to a max pixel width.
  const wrap = (text: string, maxW: number, f = font, size = FS): string[] => {
    const words = (text ?? '').split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(t, size) <= maxW) {
        cur = t;
      } else {
        if (cur) lines.push(cur);
        // Hard-break a single word longer than the column.
        let word = w;
        while (f.widthOfTextAtSize(word, size) > maxW && word.length > 1) {
          let cut = word.length;
          while (cut > 1 && f.widthOfTextAtSize(word.slice(0, cut), size) > maxW) cut--;
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

  // ---- Header: "Pick list" + courier (left), company + date (right) ----
  page.drawText('Pick list', { x: M, y: y - 16, size: 20, font: bold, color: ink });
  const compW = bold.widthOfTextAtSize(opts.companyName, 11);
  page.drawText(opts.companyName, {
    x: rightEdge - compW,
    y: y - 6,
    size: 11,
    font: bold,
    color: ink,
  });
  const dateW = font.widthOfTextAtSize(opts.dateLabel, 10);
  page.drawText(opts.dateLabel, {
    x: rightEdge - dateW,
    y: y - 20,
    size: 10,
    font,
    color: grey,
  });
  y -= 30;
  page.drawText(`Courier: ${opts.courierName}`, {
    x: M,
    y: y - 6,
    size: 11,
    font: bold,
    color: grey,
  });
  y -= 26;

  const drawHeadRow = () => {
    const hH = 20;
    page.drawRectangle({
      x: M,
      y: y - hH,
      width: usable,
      height: hH,
      color: headBg,
      borderColor: line,
      borderWidth: 0.5,
    });
    for (const c of cols) {
      const label = c.title;
      if (c.key === 'qty') {
        page.drawText(label, {
          x: rightEdge - PAD - bold.widthOfTextAtSize(label, FS),
          y: y - 14,
          size: FS,
          font: bold,
          color: ink,
        });
      } else {
        page.drawText(label, { x: xOf[c.key] + PAD, y: y - 14, size: FS, font: bold, color: ink });
      }
    }
    y -= hH;
  };
  drawHeadRow();

  const IMG = 40; // image box size
  for (const r of opts.rows) {
    const productLines = wrap(r.product, cols[1].w - PAD * 2);
    const variantLines = wrap(r.variant || 'Default Title', cols[2].w - PAD * 2);
    const orderLines = wrap(r.orders.join(', '), cols[3].w - PAD * 2);
    const textH = Math.max(productLines.length, variantLines.length, orderLines.length) * LH;
    const rowH = Math.max(textH + PAD * 2, IMG + PAD * 2);

    if (y - rowH < M + 26) {
      // reserve space for the total row too
      page = doc.addPage([A4.w, A4.h]);
      y = A4.h - M;
      drawHeadRow();
    }

    const top = y;
    const bottom = y - rowH;
    // Row border + column separators.
    page.drawRectangle({
      x: M,
      y: bottom,
      width: usable,
      height: rowH,
      borderColor: line,
      borderWidth: 0.5,
    });
    for (const c of cols.slice(1)) {
      page.drawLine({
        start: { x: xOf[c.key], y: top },
        end: { x: xOf[c.key], y: bottom },
        thickness: 0.5,
        color: line,
      });
    }

    // Image cell (best-effort).
    if (r.image) {
      try {
        const img = /png/i.test(r.image.mime)
          ? await doc.embedPng(r.image.bytes)
          : await doc.embedJpg(r.image.bytes);
        const scale = Math.min(IMG / img.width, IMG / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, {
          x: xOf['image'] + (cols[0].w - w) / 2,
          y: top - PAD - h + (IMG - h) / 2,
          width: w,
          height: h,
        });
      } catch {
        /* unsupported/broken image → blank cell */
      }
    }

    const drawLines = (lines: string[], colKey: string, f = font, color = ink) => {
      let ty = top - PAD - FS;
      for (const ln of lines) {
        page.drawText(ln, { x: xOf[colKey] + PAD, y: ty, size: FS, font: f, color });
        ty -= LH;
      }
    };
    drawLines(productLines, 'product', font, ink);
    drawLines(variantLines, 'variant', font, r.variant ? ink : grey);
    drawLines(orderLines, 'order', font, grey);
    const qtyStr = String(r.qty);
    page.drawText(qtyStr, {
      x: rightEdge - PAD - bold.widthOfTextAtSize(qtyStr, FS + 1),
      y: top - PAD - FS,
      size: FS + 1,
      font: bold,
      color: ink,
    });

    y = bottom;
  }

  // ---- Total row ----
  const tH = 22;
  if (y - tH < M) {
    page = doc.addPage([A4.w, A4.h]);
    y = A4.h - M;
  }
  page.drawRectangle({
    x: M,
    y: y - tH,
    width: usable,
    height: tH,
    color: headBg,
    borderColor: line,
    borderWidth: 0.5,
  });
  page.drawText(`Total (${opts.rows.length} SKUs)`, {
    x: M + PAD,
    y: y - 15,
    size: 10,
    font: bold,
    color: ink,
  });
  const totStr = String(opts.totalUnits);
  page.drawText(totStr, {
    x: rightEdge - PAD - bold.widthOfTextAtSize(totStr, 11),
    y: y - 15,
    size: 11,
    font: bold,
    color: ink,
  });

  return Buffer.from(await doc.save());
}
