import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from './encryption.service';
import { runsBackground } from '../utils/process-role';

export interface WabaSubscriptionResult {
  wabaId: string;
  subscribed: boolean;
  /** true when this call had to subscribe the app (it was missing). */
  fixed?: boolean;
  apps?: string[];
  error?: string;
}

/**
 * Makes sure Meta actually DELIVERS webhooks for a tenant's WhatsApp Business
 * Account.
 *
 * Meta only POSTs `messages` events (inbound messages AND sent/delivered/read
 * status receipts) to apps that are subscribed to the WABA
 * (`POST /{waba_id}/subscribed_apps`). Setting the callback URL + passing the
 * verify handshake is NOT enough — a WABA with an empty `subscribed_apps` list
 * verifies fine and then never sends a single event. That is exactly what hit
 * Bin Ali (2026-11-23): no inbound ever, every outbound stuck at "sent".
 *
 * `ensureSubscribed` reads `subscribed_apps` with the tenant's own token and
 * subscribes the token's app when it is missing. It runs after every token /
 * WABA save (onboarding steps 3-4, add/update number), on a worker sweep
 * (boot + every 6 h), and from the manual Settings endpoint.
 *
 * Best-effort: NEVER throws (a token save must not fail because of this).
 */
@Injectable()
export class WabaSubscriptionService implements OnModuleInit {
  private readonly logger = new Logger(WabaSubscriptionService.name);
  private readonly graphVersion: string;
  private static readonly SWEEP_MS = 6 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
  ) {
    this.graphVersion =
      this.config.get<string>('META_GRAPH_VERSION') ?? 'v19.0';
  }

  onModuleInit() {
    if (!runsBackground()) return;
    setTimeout(() => void this.sweepAll(), 90_000);
    setInterval(() => void this.sweepAll(), WabaSubscriptionService.SWEEP_MS);
  }

  /** Every WABA of every active company — repairs a missing subscription. */
  async sweepAll(): Promise<void> {
    try {
      const companies = await this.prisma.company.findMany({
        where: { activation_status: 'active' },
        select: { id: true },
      });
      for (const c of companies) {
        const res = await this.ensureSubscribed(c.id);
        for (const r of res) {
          if (r.fixed)
            this.logger.warn(
              `company ${c.id}: WABA ${r.wabaId} had no subscribed app — subscribed it`,
            );
          else if (r.error)
            this.logger.warn(
              `company ${c.id}: WABA ${r.wabaId} subscription check failed: ${r.error}`,
            );
        }
      }
    } catch (e) {
      this.logger.warn(`sweep failed: ${(e as Error).message}`);
    }
  }

  /**
   * Check (and repair) every WABA the company has. `fix=false` = report only.
   */
  async ensureSubscribed(
    companyId: number,
    fix = true,
  ): Promise<WabaSubscriptionResult[]> {
    const out: WabaSubscriptionResult[] = [];
    try {
      const targets = await this.targets(companyId);
      for (const [wabaId, token] of targets) {
        out.push(await this.checkOne(wabaId, token, fix));
      }
    } catch (e) {
      this.logger.warn(
        `ensureSubscribed(${companyId}) failed: ${(e as Error).message}`,
      );
    }
    return out;
  }

  /** Fire-and-forget variant for save paths. */
  kick(companyId: number): void {
    void this.ensureSubscribed(companyId).then((res) => {
      for (const r of res) {
        if (r.fixed)
          this.logger.log(
            `company ${companyId}: subscribed app to WABA ${r.wabaId}`,
          );
        else if (r.error)
          this.logger.warn(
            `company ${companyId}: WABA ${r.wabaId} subscribe failed: ${r.error}`,
          );
      }
    });
  }

  /** waba_id → decrypted token (one token per WABA is enough). */
  private async targets(companyId: number): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const dec = (enc?: string | null): string | null => {
      if (!enc) return null;
      try {
        return this.encryption.decrypt(enc);
      } catch {
        return null;
      }
    };

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { waba_id: true, onboarding_status: true },
    });
    const onb = company?.onboarding_status as {
      metaAccessTokenEncrypted?: string;
    } | null;
    const companyToken = dec(onb?.metaAccessTokenEncrypted);

    const numbers = await this.prisma.whatsAppNumber.findMany({
      where: { company_id: companyId, status: 'active' },
      select: { waba_id: true, access_token_encrypted: true },
    });
    for (const n of numbers) {
      const waba = n.waba_id?.trim();
      if (!waba || map.has(waba)) continue;
      const tok = dec(n.access_token_encrypted) ?? companyToken;
      if (tok) map.set(waba, tok);
    }
    const legacyWaba = company?.waba_id?.trim();
    if (legacyWaba && !map.has(legacyWaba) && companyToken) {
      map.set(legacyWaba, companyToken);
    }
    return map;
  }

  private async checkOne(
    wabaId: string,
    token: string,
    fix: boolean,
  ): Promise<WabaSubscriptionResult> {
    const url = `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(wabaId)}/subscribed_apps`;
    const headers = { Authorization: `Bearer ${token}` };
    const read = async (): Promise<string[] | { error: string }> => {
      const r = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await r.json().catch(() => ({}))) as {
        data?: Array<{ whatsapp_business_api_data?: { name?: string; id?: string } }>;
        error?: { message?: string };
      };
      if (!r.ok) return { error: body.error?.message ?? `HTTP ${r.status}` };
      return (body.data ?? []).map(
        (a) =>
          a.whatsapp_business_api_data?.name ??
          a.whatsapp_business_api_data?.id ??
          'app',
      );
    };

    try {
      const before = await read();
      if (!Array.isArray(before)) {
        return { wabaId, subscribed: false, error: before.error };
      }
      if (before.length > 0 || !fix) {
        return { wabaId, subscribed: before.length > 0, apps: before };
      }
      const r = await fetch(url, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        error?: { message?: string };
      };
      if (!r.ok || body.success === false) {
        return {
          wabaId,
          subscribed: false,
          error: body.error?.message ?? `HTTP ${r.status}`,
        };
      }
      const after = await read();
      return {
        wabaId,
        subscribed: true,
        fixed: true,
        apps: Array.isArray(after) ? after : undefined,
      };
    } catch (e) {
      return { wabaId, subscribed: false, error: (e as Error).message };
    }
  }
}
