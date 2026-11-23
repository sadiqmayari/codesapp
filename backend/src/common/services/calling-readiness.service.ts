import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SipTrunkAuthService } from './sip-trunk-auth.service';
import { FeatureService } from './feature.service';

export type CheckState = 'ok' | 'todo' | 'blocked' | 'unknown';

export interface CallingCheck {
  key: 'number' | 'tier' | 'module' | 'meta_calling' | 'server' | 'agents';
  state: CheckState;
  detail: string;
}

export interface CallingReadiness {
  ready: boolean;
  tier: string | null;
  callingStatus: string | null;
  displayNumber: string | null;
  checks: CallingCheck[];
}

/** Messaging-limit tiers Meta accepts for calling (docs: 2,000 or above). */
const CALLING_TIERS = new Set([
  'TIER_2K',
  'TIER_10K',
  'TIER_100K',
  'TIER_UNLIMITED',
]);

const TIER_LABEL: Record<string, string> = {
  TIER_50: '50',
  TIER_250: '250',
  TIER_1K: '1,000',
  TIER_2K: '2,000',
  TIER_10K: '10,000',
  TIER_100K: '100,000',
  TIER_UNLIMITED: 'unlimited',
};

/**
 * WhatsApp Calling setup checklist for Settings → WhatsApp (read-only, live
 * from Meta). Tells a tenant exactly which step is missing:
 *   number connected → messaging limit ≥ 2,000 (Meta's rule) → calling module
 *   granted → calling enabled on the number in Meta → number connected to the
 *   CodesApp calling server → agents ready.
 * Never throws: an unreachable Meta yields `unknown` checks.
 */
@Injectable()
export class CallingReadinessService {
  private readonly logger = new Logger(CallingReadinessService.name);
  private readonly graphVersion: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sip: SipTrunkAuthService,
    private readonly feature: FeatureService,
    private readonly config: ConfigService,
  ) {
    this.graphVersion =
      this.config.get<string>('META_GRAPH_VERSION') ?? 'v19.0';
  }

  async readiness(companyId: number): Promise<CallingReadiness> {
    const checks: CallingCheck[] = [];
    let tier: string | null = null;
    let callingStatus: string | null = null;
    let display: string | null = null;

    const num = await this.sip.resolveNumber(companyId).catch(() => null);
    display = num?.display ?? null;
    const connected = !!(num?.phoneNumberId && num?.token);
    checks.push({
      key: 'number',
      state: connected ? 'ok' : 'todo',
      detail: connected
        ? 'WhatsApp Cloud API number connected.'
        : 'Connect your WhatsApp number first (access token + phone number ID).',
    });

    let metaOk = false;
    if (connected) {
      const info = await this.graph<{
        messaging_limit_tier?: string;
        display_phone_number?: string;
      }>(
        `${num!.phoneNumberId}?fields=messaging_limit_tier,display_phone_number`,
        num!.token!,
      );
      const settings = await this.graph<{
        calling?: { status?: string; sip?: { status?: string } };
      }>(`${num!.phoneNumberId}/settings`, num!.token!);
      metaOk = !!info;
      tier = info?.messaging_limit_tier ?? null;
      display = display ?? info?.display_phone_number ?? null;
      callingStatus = settings?.calling?.status ?? null;
    }

    // Messaging limit.
    if (!connected || !metaOk) {
      checks.push({
        key: 'tier',
        state: 'unknown',
        detail: 'Couldn’t read your messaging limit from Meta.',
      });
    } else if (tier && CALLING_TIERS.has(tier)) {
      checks.push({
        key: 'tier',
        state: 'ok',
        detail: `Messaging limit ${TIER_LABEL[tier] ?? tier}: eligible for calling.`,
      });
    } else {
      checks.push({
        key: 'tier',
        state: 'blocked',
        detail: `Your messaging limit is ${tier ? TIER_LABEL[tier] ?? tier : 'unknown'}. Meta enables calling from 2,000 a day. Keep sending good-quality messages; Meta raises the limit automatically.`,
      });
    }

    // Module grant (super-admin).
    const moduleOn = await this.feature
      .enabled(companyId, 'calls')
      .catch(() => false);
    checks.push({
      key: 'module',
      state: moduleOn ? 'ok' : 'todo',
      detail: moduleOn
        ? 'Calling is included in your CodesApp plan.'
        : 'Calling isn’t switched on for your workspace yet. Ask CodesApp support to enable it.',
    });

    // Calling enabled on the number in Meta.
    const callingOn = callingStatus === 'ENABLED';
    checks.push({
      key: 'meta_calling',
      state: !connected || !metaOk ? 'unknown' : callingOn ? 'ok' : 'todo',
      detail: callingOn
        ? 'Calling is enabled on your number in Meta.'
        : 'Calling isn’t enabled on your number yet. CodesApp turns it on and connects it once the steps above are done.',
    });

    // Connected to the CodesApp calling server.
    const serverOn = this.sip.isCallingNumber(display);
    checks.push({
      key: 'server',
      state: serverOn ? 'ok' : 'todo',
      detail: serverOn
        ? 'Your number is connected to the CodesApp calling server.'
        : 'Not connected to the CodesApp calling server yet. CodesApp support does this for you.',
    });

    // Agents with a softphone line.
    let agents = 0;
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ n: bigint | number }[]>(
        `SELECT COUNT(*) AS n FROM asterisk.ps_endpoints WHERE id LIKE ?`,
        `agent-${companyId}-%`,
      );
      agents = Number(rows[0]?.n ?? 0);
    } catch {
      /* asterisk schema not reachable */
    }
    checks.push({
      key: 'agents',
      state: agents > 0 ? 'ok' : 'todo',
      detail:
        agents > 0
          ? `${agents} team member${agents === 1 ? '' : 's'} ready to take calls.`
          : 'Team members get a call line automatically the first time they open CodesApp after calling is live.',
    });

    return {
      ready: checks.every((c) => c.state === 'ok'),
      tier,
      callingStatus,
      displayNumber: display,
      checks,
    };
  }

  private async graph<T>(path: string, token: string): Promise<T | null> {
    try {
      const r = await fetch(
        `https://graph.facebook.com/${this.graphVersion}/${path}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch (e) {
      this.logger.warn(`Meta read ${path.split('?')[0]} failed: ${(e as Error).message}`);
      return null;
    }
  }
}
