import { Injectable, Logger } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import {
  BookShipmentInput,
  BookShipmentResult,
  CourierAdapter,
  CourierLabelResult,
  GenerateLoadsheetResult,
  ShipperAdviceAction,
  TrackingCheckpoint,
  UnmappedCourierStatusError,
} from './courier-adapter.interface';
import { httpFetch, isPdf } from './http.util';
import { mergePdfsAsIs } from '../pdf.util';
import { isReturnedToShipper } from './return-status.util';

export interface PostexCredentials {
  token: string;
  pickupAddressCode: string;
}

const BASE_URL = 'https://api.postex.pk/services/integration/api/order';

/**
 * PostEx silently caps ONE generated load sheet at ~259 parcels. When a single
 * generate-load-sheet request exceeds that, PostEx splits it into MULTIPLE load
 * sheets server-side but returns only ONE PDF (the last/overflow sheet) — so a
 * 261-parcel request came back as a 2-parcel manifest while the other 259 sat on
 * a separate sheet only visible on the PostEx portal. We chunk below that cap and
 * merge every chunk's PDF so the saved manifest covers ALL parcels. 250 keeps a
 * safe margin under the observed 259 fill.
 */
const LOADSHEET_CHUNK = 250;

/** Per-chunk budget for generate-load-sheet (PostEx renders large sheets slowly).
 *  Kept under the courier-loadsheet job lease (300s) with room for recovery. */
const POSTEX_LOADSHEET_TIMEOUT_MS = 110_000;

/** PostEx status vocabulary, exactly as observed in the tenant's n8n
 *  "Sois | PostEx Tracking" webhook Switch node. Anything unlisted throws
 *  (the n8n Switch's fallback silently mapped everything else to FAILURE —
 *  we surface it as "needs attention" instead). */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  delivered: 'delivered',
  'postex warehouse': 'in_transit',
  // Hub status: parcel is at the delivery center waiting to go out — IN TRANSIT,
  // not delivered (the word "Delivery" made the pull-sync heuristic mis-map it).
  'waiting for delivery': 'in_transit',
  'out for delivery': 'out_for_delivery',
  // A picked parcel is treated as in-transit (picked_up retired from the tab /
  // Shopify model).
  'picked by postex': 'in_transit',
  booked: 'ready_for_pickup',
  // Created at PostEx but not yet on a load sheet — same lane for us (was
  // unmapped → ~200 "needs-attention" warnings a day).
  unbooked: 'ready_for_pickup',
  attempted: 'attempted',
  'delivery under review': 'attempted',
  // Only a COMPLETED hand-back is a true return. "Returned at Merchant
  // Warehouse" / "Returned to Shipper" (past-tense) = the merchant has it back.
  // "Return to Shipper" / "Return to {city}" / "Return Process Initiated" /
  // "Waiting for Return" are the parcel still moving back = a failed delivery
  // in motion → handled as 'attempted' by mapStatus (kept out of the map so the
  // prefix branch there classifies them).
  returned: 'returned',
  'returned to shipper': 'returned',
  'returned at merchant warehouse': 'returned',
};

@Injectable()
export class PostexAdapter implements CourierAdapter {
  readonly type: CourierType = 'postex';
  private readonly logger = new Logger(PostexAdapter.name);

  async bookShipment(
    creds: PostexCredentials,
    input: BookShipmentInput,
  ): Promise<BookShipmentResult> {
    const body = {
      // PostEx genuinely takes a city NAME, not a numeric code — its city
      // table has a single City column. `cityCode` therefore carries
      // PostEx's canonical spelling of the city (resolved through
      // CityMappingService so an unserved city is rejected before booking).
      cityName: input.destination.cityCode,
      // PostEx convention: a replacement's consignee name is prefixed
      // "(Replacement)" so their ground team handles it as an exchange.
      customerName: input.isReplacement
        ? `(Replacement) ${input.destination.name}`
        : input.destination.name,
      customerPhone: input.destination.phone.replace(/\D/g, ''),
      deliveryAddress: [input.destination.address1, input.destination.address2]
        .filter(Boolean)
        .join(', '),
      invoiceDivision: 1,
      invoicePayment: Math.max(0, Math.round(input.codAmount)),
      // items = total units across the order's line items (falls back to pieces).
      items: Math.max(
        1,
        Math.round(input.totalQuantity != null ? input.totalQuantity : input.pieces),
      ),
      orderRefNumber: input.shopifyOrderName,
      // PostEx create-order `orderType` marks a re-send as a replacement so it's
      // handled/billed as one at the courier (vs a first "Normal" delivery).
      orderType: input.isReplacement ? 'Replacement' : 'Normal',
      pickupAddressCode: creds.pickupAddressCode,
      orderDetail: input.itemsDescription,
    };

    const res = await httpFetch(`${BASE_URL}/v3/create-order`, {
      method: 'POST',
      headers: { token: creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await res.json().catch(() => ({}));
    const trackingNumber = (raw as any)?.dist?.trackingNumber;
    if (!res.ok || !trackingNumber) {
      throw new Error(`PostEx booking failed: ${JSON.stringify(raw)}`);
    }
    return { trackingNumber: String(trackingNumber), raw };
  }

  /**
   * PostEx's generate-load-sheet returns the manifest **as a PDF** (not JSON).
   * Because PostEx caps one sheet at ~259 parcels (see LOADSHEET_CHUNK) we chunk
   * the tracking numbers, generate a sheet per chunk, and MERGE the chunk PDFs
   * into one manifest so it covers every parcel. A small batch is a single chunk
   * → identical to the old one-shot behaviour.
   */
  async generateLoadsheet(
    creds: PostexCredentials,
    trackingNumbers: string[],
  ): Promise<GenerateLoadsheetResult> {
    const chunks: string[][] = [];
    for (let i = 0; i < trackingNumbers.length; i += LOADSHEET_CHUNK) {
      chunks.push(trackingNumbers.slice(i, i + LOADSHEET_CHUNK));
    }
    if (!chunks.length) {
      throw new Error('PostEx loadsheet generation failed: no tracking numbers.');
    }

    const pdfBuffers: Buffer[] = [];
    const loadsheetIds: string[] = [];
    for (const chunk of chunks) {
      const { pdfBuffer, loadsheetId } = await this.generateOneSheet(creds, chunk);
      if (pdfBuffer) pdfBuffers.push(pdfBuffer);
      loadsheetIds.push(loadsheetId);
    }

    // All (or the single) chunk returned real PDFs → merge them into one manifest.
    if (pdfBuffers.length) {
      const merged =
        pdfBuffers.length === 1 ? pdfBuffers[0] : await mergePdfsAsIs(pdfBuffers);
      return { loadsheetId: loadsheetIds.join(','), pdfBuffer: merged, raw: null };
    }
    // No PDFs anywhere (every chunk answered JSON with a loadSheetId) — still a
    // success; return the joined ids so the sheets are recorded.
    return { loadsheetId: loadsheetIds.join(','), raw: null };
  }

  /** Generate ONE PostEx load sheet for a single ≤LOADSHEET_CHUNK group. Returns
   *  the chunk's PDF (when PostEx renders one inline) and its loadsheet id. */
  private async generateOneSheet(
    creds: PostexCredentials,
    trackingNumbers: string[],
  ): Promise<{ pdfBuffer?: Buffer; loadsheetId: string }> {
    // PostEx renders a big sheet slowly. The default 30s courier timeout aborted
    // a 200-parcel request AFTER PostEx had already created the sheet (Sois,
    // 2026-11-14) — so give this call a much longer budget (job lease is 300s).
    const res = await httpFetch(
      `${BASE_URL}/v2/generate-load-sheet`,
      {
        method: 'POST',
        headers: { token: creds.token, 'Content-Type': 'application/json', Accept: 'application/pdf' },
        body: JSON.stringify({ trackingNumbers }),
      },
      POSTEX_LOADSHEET_TIMEOUT_MS,
    );
    // Read the body ONCE as bytes. A real PDF is identified by its %PDF- magic,
    // NOT the content-type header (PostEx's labelling isn't reliable); a non-PDF
    // body (error/HTML/JSON) must NOT be saved as a manifest.
    const buf = Buffer.from(await res.arrayBuffer());
    const ctype = res.headers.get('content-type') || '';
    if (res.ok && isPdf(buf)) {
      return { pdfBuffer: buf, loadsheetId: `postex-${Date.now()}` };
    }
    // Not a PDF → an error/JSON envelope. Some PostEx tenants still answer JSON
    // with a loadSheetId; surface either the id or a clear error. Parse the bytes
    // we already read (the response stream is spent).
    let raw: any = {};
    try {
      raw = JSON.parse(buf.toString('utf8'));
    } catch {
      /* non-JSON error body — leave raw as {} */
    }
    const loadsheetId = raw?.dist?.loadSheetId;
    if (res.ok && loadsheetId) return { loadsheetId: String(loadsheetId) };
    // Surface what PostEx actually sent — the old `{}` (non-JSON body) hid the
    // HTTP status and reason entirely.
    const reason =
      raw?.statusMessage ||
      raw?.message ||
      raw?.error ||
      buf.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 200) ||
      '(empty body)';
    throw new Error(
      `PostEx loadsheet generation failed: HTTP ${res.status}${ctype ? ` (${ctype.split(';')[0]})` : ''} — ${reason}`,
    );
  }

  /**
   * Which of these tracking numbers PostEx already has ON a load sheet.
   * PostEx's public API has no "download a load sheet by id" endpoint, so this
   * is how a lost response is recovered: a parcel is on a sheet once its
   * transactionStatus leaves "Unbooked" (created, not yet sheeted) — "Booked"
   * or anything later. Read-only track-order calls, small concurrency; a parcel
   * whose lookup fails is treated as NOT on a sheet (safe: it gets released and
   * can be regenerated). Never throws.
   */
  async listOnLoadsheet(
    creds: PostexCredentials,
    trackingNumbers: string[],
  ): Promise<string[]> {
    const onSheet: string[] = [];
    let i = 0;
    const worker = async () => {
      while (i < trackingNumbers.length) {
        const tn = trackingNumbers[i++];
        try {
          const res = await httpFetch(
            `${BASE_URL}/v1/track-order/${encodeURIComponent(tn)}`,
            { headers: { token: creds.token } },
            15_000,
          );
          if (!res.ok) continue;
          const raw: any = await res.json().catch(() => null);
          const st = String(raw?.dist?.transactionStatus ?? '').trim().toLowerCase();
          if (st && st !== 'unbooked') onSheet.push(tn);
        } catch {
          /* lookup failed → treat as not on a sheet */
        }
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    return onSheet;
  }

  /** Airway-bill PDF for up to 10 tracking numbers per call (PostEx cap). The
   *  caller passes a single courier's parcels; we chunk by 10 and return the
   *  first chunk's PDF plus (if >10) note the rest via items is unnecessary —
   *  the ops service chunks upstream so each call here is ≤10. */
  async getLabels(
    creds: PostexCredentials,
    trackingNumbers: string[],
  ): Promise<CourierLabelResult> {
    const tns = trackingNumbers.slice(0, 10).map((t) => encodeURIComponent(t)).join(',');
    const res = await httpFetch(`${BASE_URL}/v1/get-invoice?trackingNumbers=${tns}`, {
      headers: { token: creds.token, Accept: 'application/pdf' },
    });
    if (!res.ok) throw new Error(`PostEx label fetch failed (${res.status}).`);
    const pdfBuffer = Buffer.from(await res.arrayBuffer());
    return { pdfBuffer, raw: null };
  }

  async cancelShipment(
    creds: PostexCredentials,
    trackingNumber: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    const res = await httpFetch(`${BASE_URL}/v1/cancel-order`, {
      method: 'PUT',
      headers: { token: creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackingNumber }),
    });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, raw };
  }

  async sendShipperAdvice(
    creds: PostexCredentials,
    trackingNumber: string,
    action: ShipperAdviceAction,
    remarks: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    // PostEx statusId: 1 = Mark Return Requested, 2 = Mark Retry Attempt.
    const statusId = action === 'return' ? 1 : 2;
    const res = await httpFetch(`${BASE_URL}/v2/save-shipper-advice/`, {
      method: 'PUT',
      headers: { token: creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackingNumber, statusId, remarks: remarks || '' }),
    });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, raw };
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    const key = rawStatus.trim().toLowerCase();
    // Completed hand-back → returned (checked first so "Returned at Merchant
    // Warehouse" can't be caught by the en-route/merchant rules below).
    if (isReturnedToShipper(rawStatus)) return 'returned';
    // A parcel EN ROUTE TO the MERCHANT's warehouse is a RETURN leg (a forward
    // parcel travels to the customer, never back to the merchant) → failed
    // delivery on its way back = 'failed' (the Failed tab; re-polled so it still
    // promotes to 'returned' on arrival). Must beat the generic en-route and the
    // "warehouse" wording below. PostEx writes this both hyphenated and spaced.
    if (/en[\s-]?route to\s+(the\s+)?merchant/.test(key)) return 'failed';
    // Any other "return ..." leg is likewise a return in motion → 'failed'.
    if (key.startsWith('return')) return 'failed';
    // "At {Merchant} Warehouse" (present tense, NOT "Returned at …") = the parcel
    // is sitting at the merchant's origin warehouse awaiting PostEx pickup →
    // ready_for_pickup (Booked tab). Excludes PostEx's own hub wording, which is
    // "PostEx WareHouse" / "Transit Hub" (handled by STATUS_MAP / normalize).
    if (/^at\s+.+\swarehouse$/.test(key) && !key.includes('postex') && !key.includes('transit'))
      return 'ready_for_pickup';
    // n8n matches "En-Route to" with CONTAINS; real payloads look like
    // "En-Route to {14} warehouse" — use includes so any en-route hop counts.
    // Tolerate the spaced form too ("En Route to …").
    if (key.includes('en-route') || key.includes('en route')) return 'in_transit';
    const mapped = STATUS_MAP[key];
    if (!mapped) throw new UnmappedCourierStatusError('postex', rawStatus);
    return mapped;
  }

  isAddressIssueReason(rawReason: string): boolean {
    return /wrong address|address.*(not found|invalid)|consignee not available|no such (building|address|plot)/i.test(
      rawReason,
    );
  }

  isAwaitingShipperAdvice(rawStatus: string, reason?: string): boolean {
    const s = `${rawStatus} ${reason ?? ''}`.toLowerCase();
    // PostEx has no dedicated "awaiting advice" status string (its API only
    // reads back advice WE saved) — "Delivery Under Review" is the state where
    // PostEx is holding the parcel pending the merchant's decision. Everything
    // else (plain "Attempted") relies on the aged-attempt fallback.
    return /delivery under review|shipper advis/.test(s);
  }

  /**
   * Pull the current status from PostEx. Auth is the raw `token` header (not
   * Bearer). `dist.transactionStatusHistory` is chronological — the LAST item
   * is the latest. Status text lives in `transactionStatusMessage`.
   */
  async queryTracking(
    creds: PostexCredentials,
    trackingNumber: string,
  ): Promise<{ rawStatus: string; happenedAt?: Date; reason?: string } | null> {
    try {
      const res = await httpFetch(
        `${BASE_URL}/v1/track-order/${encodeURIComponent(trackingNumber)}`,
        { headers: { token: creds.token, Accept: 'application/json' } },
      );
      const j = (await res.json().catch(() => null)) as any;
      const hist = j?.dist?.transactionStatusHistory;
      if (!Array.isArray(hist) || !hist.length) return null;
      const last = hist[hist.length - 1];
      const msg = last?.transactionStatusMessage;
      if (!msg) return null;
      const when = last?.modifiedDatetime || last?.transactionDate;
      return {
        rawStatus: String(msg),
        happenedAt: when ? new Date(when) : undefined,
        // PostEx encodes the attempt reason inline: "Attempt Made: <reason>".
        reason: extractPostexReason(String(msg)),
      };
    } catch {
      return null;
    }
  }

  /** Full checkpoint history (oldest → newest) for the in-app tracking view.
   *  `dist.transactionStatusHistory` is chronological. */
  async queryTrackingHistory(
    creds: PostexCredentials,
    trackingNumber: string,
  ): Promise<TrackingCheckpoint[]> {
    try {
      const res = await httpFetch(
        `${BASE_URL}/v1/track-order/${encodeURIComponent(trackingNumber)}`,
        { headers: { token: creds.token, Accept: 'application/json' } },
      );
      const j = (await res.json().catch(() => null)) as any;
      const hist = j?.dist?.transactionStatusHistory;
      if (!Array.isArray(hist)) return [];
      return hist
        .map((h: any): TrackingCheckpoint | null => {
          const status = String(h?.transactionStatusMessage ?? '').trim();
          if (!status) return null;
          // History items date the checkpoint via `updatedAt` (the top-level
          // track uses modifiedDatetime/transactionDate — keep both as fallback).
          const rawAt = h?.updatedAt || h?.modifiedDatetime || h?.transactionDate;
          const at = rawAt ? new Date(String(rawAt)) : null;
          return {
            status,
            at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : undefined,
          };
        })
        .filter((x: TrackingCheckpoint | null): x is TrackingCheckpoint => x !== null);
    } catch {
      return [];
    }
  }
}

/** Pull the human reason out of PostEx's "Attempt Made: <reason>" status text. */
function extractPostexReason(msg: string): string | undefined {
  const m = /attempt made\s*:\s*(.+)/i.exec(msg);
  return m ? m[1].trim() : undefined;
}
