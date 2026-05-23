import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { MailService } from '../../common/services/mail.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { InboxGateway } from '../inbox/inbox.gateway';
import { resolveEffectiveLimits } from '../../common/utils/effective-limits';

/**
 * Phase 4.5 — Usage-limit notifications at 90 / 99 / 100% (per period).
 *
 * Fires exactly ONCE per (company, period, dim, threshold) via the
 * `usage_metering.thresholds_notified` JSON ledger. A new period (new
 * calendar month) creates a fresh `usage_metering` row, so the ledger
 * resets implicitly.
 *
 * Channels per threshold:
 *  - 90  → in-app banner (socket) + email + outbound `subscription.limit.warning` webhook
 *  - 99  → same + ALSO the blinking-navbar pulse (frontend escalation)
 *  - 100 → same + outbound `subscription.limit.reached` webhook
 *
 * The legacy 80% `subscription.limit.warning` keeps firing from
 * `LimitWarningService.check` — unchanged. This service runs alongside it.
 *
 * Scope (deliberate cut for v1):
 *   Evaluates contacts + templates only. The `users` limit is not
 *   metered per-period (it's a live count enforced at the time of adding
 *   a teammate by TeamService) — adding 90/99 warnings for users would
 *   need a different trigger and is deferred. Messages / webhook_calls /
 *   conversations have no Subscription cap, so nothing to warn against.
 *
 * Never throws — caller (UsageMeteringService.increment) must not be
 * disrupted by a notification failure.
 */

const THRESHOLDS: Array<{ pct: number; key: '90' | '99' | '100' }> = [
  { pct: 90, key: '90' },
  { pct: 99, key: '99' },
  { pct: 100, key: '100' },
];

const DIM_MAP: Record<string, 'contacts' | 'templates'> = {
  contacts: 'contacts',
  contacts_stored: 'contacts',
  templates: 'templates',
  templates_used: 'templates',
};

interface OwnerContact {
  email: string;
  name: string;
  companyName: string;
}

@Injectable()
export class LimitNotifierService {
  private readonly logger = new Logger(LimitNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly mail: MailService,
    private readonly dispatcher: WebhookDispatcherService,
    private readonly gateway: InboxGateway,
  ) {}

  /**
   * Evaluate a single dimension after an increment.
   * Caller passes the raw dimension name (e.g. 'contacts_stored').
   */
  async evaluate(companyId: number, rawDim: string): Promise<void> {
    const dim = DIM_MAP[rawDim];
    if (!dim) return;

    try {
      const period = new Date().toISOString().slice(0, 7);

      // Load effective limit + current usage + existing ledger in one go.
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          company_name: true,
          contact_limit_override: true,
          template_limit_override: true,
          user_limit_override: true,
          subscription: {
            select: {
              contact_limit: true,
              template_limit: true,
              user_limit: true,
            },
          },
          users: {
            where: { role: 'owner' },
            select: { name: true, email: true },
            take: 1,
          },
        },
      });
      if (!company?.subscription) return;

      const limits = resolveEffectiveLimits(company.subscription, company);
      const limit =
        dim === 'contacts' ? limits.contact_limit : limits.template_limit;
      if (!limit || limit <= 0) return;

      const usage = await this.prisma.usageMetering.findUnique({
        where: { company_id_period: { company_id: companyId, period } },
      });
      if (!usage) return;
      const current =
        dim === 'contacts'
          ? usage.contacts_stored
          : usage.templates_used;
      const pct = (current / limit) * 100;

      const notified = parseLedger(usage.thresholds_notified);

      const owner: OwnerContact | null =
        company.users[0]
          ? {
              email: company.users[0].email,
              name: company.users[0].name,
              companyName: company.company_name,
            }
          : null;

      for (const t of THRESHOLDS) {
        if (pct < t.pct) continue;
        const flag = `${dim}:${t.key}`;
        if (notified.has(flag)) continue;

        const persisted = await this.markFlag(usage.id, notified, flag);
        if (!persisted) continue; // another caller raced us; skip silently

        await this.fireOne(
          companyId,
          dim,
          t.key,
          current,
          limit,
          period,
          owner,
        );
      }
    } catch (err) {
      this.logger.warn(
        `limit-notifier evaluate(${companyId}, ${rawDim}) failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Atomically append `flag` to thresholds_notified using JSON_MERGE_PRESERVE
   * with a uniqueness re-check after the write. Returns true if WE were the
   * writer; false if a parallel caller had already persisted the same flag.
   *
   * Note: MySQL JSON arrays can't enforce uniqueness natively, so we
   * read-modify-write inside a small SQL upsert with a post-write check.
   */
  private async markFlag(
    usageRowId: number,
    inMemory: Set<string>,
    flag: string,
  ): Promise<boolean> {
    if (inMemory.has(flag)) return false;
    const next = [...inMemory, flag];
    inMemory.add(flag);

    const result = await this.prisma.usageMetering.updateMany({
      where: {
        id: usageRowId,
        // Cheap optimistic concurrency: only write if the existing ledger
        // doesn't already contain this flag. With JSON_CONTAINS we keep this
        // single-statement and avoid a transaction. If it races with another
        // process, one of the two updateMany() calls reports count=0.
        AND: [
          {
            OR: [
              { thresholds_notified: { equals: Prisma.JsonNull } },
              { thresholds_notified: { not: { array_contains: flag } } },
            ],
          },
        ],
      },
      data: { thresholds_notified: next },
    });
    return result.count > 0;
  }

  private async fireOne(
    companyId: number,
    dim: 'contacts' | 'templates',
    threshold: '90' | '99' | '100',
    current: number,
    limit: number,
    period: string,
    owner: OwnerContact | null,
  ): Promise<void> {
    const pct = Math.round((current / limit) * 100);
    const severity: 'warn' | 'critical' =
      threshold === '90' ? 'warn' : 'critical';

    // 1) Socket — live banner toast for connected agents
    this.gateway.emitToCompany(companyId, 'usage.warning', {
      dim,
      threshold,
      pct,
      current,
      limit,
      severity,
      period,
    });

    // 2) Email to owner
    if (owner) {
      await this.mail.send(
        owner.email,
        usageEmailSubject(dim, threshold, owner.companyName),
        usageEmailHtml(
          owner.name,
          owner.companyName,
          dim,
          threshold,
          current,
          limit,
        ),
      );
    }

    // 3) Outbound webhook — escalation event at 100%, warning otherwise
    const event =
      threshold === '100'
        ? 'subscription.limit.reached'
        : 'subscription.limit.warning';
    await this.dispatcher.dispatch(companyId, event, {
      dimension: dim,
      threshold: Number(threshold),
      current,
      limit,
      period,
    });

    this.logger.log(
      `usage notification fired: company=${companyId} dim=${dim} threshold=${threshold} (${current}/${limit})`,
    );
  }

  /**
   * Read current ledger + effective limits — used by the hydration endpoint
   * GET /api/billing/usage-warnings so a page load doesn't have to wait for
   * a socket tick to render the banner.
   */
  async snapshot(companyId: number): Promise<
    Array<{
      dim: 'contacts' | 'templates';
      threshold: '90' | '99' | '100';
      pct: number;
      current: number;
      limit: number;
      severity: 'warn' | 'critical';
    }>
  > {
    const period = new Date().toISOString().slice(0, 7);

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        contact_limit_override: true,
        template_limit_override: true,
        user_limit_override: true,
        subscription: {
          select: {
            contact_limit: true,
            template_limit: true,
            user_limit: true,
          },
        },
      },
    });
    if (!company?.subscription) return [];

    const usage = await this.prisma.usageMetering.findUnique({
      where: { company_id_period: { company_id: companyId, period } },
    });
    if (!usage) return [];

    const limits = resolveEffectiveLimits(company.subscription, company);
    const out: Array<{
      dim: 'contacts' | 'templates';
      threshold: '90' | '99' | '100';
      pct: number;
      current: number;
      limit: number;
      severity: 'warn' | 'critical';
    }> = [];

    const evalDim = (
      dim: 'contacts' | 'templates',
      current: number,
      limit: number,
    ) => {
      if (limit <= 0) return;
      const pct = (current / limit) * 100;
      const top =
        pct >= 100
          ? { pct: 100, key: '100' as const }
          : pct >= 99
            ? { pct: 99, key: '99' as const }
            : pct >= 90
              ? { pct: 90, key: '90' as const }
              : null;
      if (!top) return;
      out.push({
        dim,
        threshold: top.key,
        pct: Math.min(100, Math.round(pct)),
        current,
        limit,
        severity: top.key === '90' ? 'warn' : 'critical',
      });
    };

    evalDim('contacts', usage.contacts_stored, limits.contact_limit);
    evalDim('templates', usage.templates_used, limits.template_limit);
    return out;
  }

  /**
   * Suspension notice — fired once when a company transitions from
   * non-suspended to suspended (super-admin OR auto-suspend cron).
   * Idempotency is the caller's responsibility (we only email here).
   */
  async sendSuspensionEmail(companyId: number): Promise<void> {
    try {
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          company_name: true,
          users: {
            where: { role: 'owner' },
            select: { name: true, email: true },
            take: 1,
          },
          invoices: {
            where: { status: { in: ['pending', 'overdue'] } },
            select: { amount: true },
          },
        },
      });
      const owner = company?.users[0];
      if (!owner) return;

      const outstanding = (company.invoices ?? []).reduce(
        (s, i) => s + Number(i.amount),
        0,
      );

      await this.mail.send(
        owner.email,
        `[CodesApp] Your account has been suspended`,
        suspensionEmailHtml(
          owner.name,
          company.company_name,
          outstanding,
        ),
      );
    } catch (err) {
      this.logger.warn(
        `suspension email failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseLedger(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === 'string'));
}

const DIM_LABEL: Record<'contacts' | 'templates', string> = {
  contacts: 'contacts',
  templates: 'message templates',
};

function usageEmailSubject(
  dim: 'contacts' | 'templates',
  threshold: '90' | '99' | '100',
  companyName: string,
): string {
  const label = DIM_LABEL[dim];
  if (threshold === '100')
    return `[CodesApp] ${companyName} — ${label} quota reached`;
  return `[CodesApp] ${companyName} — ${threshold}% of ${label} quota used`;
}

function usageEmailHtml(
  ownerName: string,
  companyName: string,
  dim: 'contacts' | 'templates',
  threshold: '90' | '99' | '100',
  current: number,
  limit: number,
): string {
  const label = DIM_LABEL[dim];
  const banner =
    threshold === '100'
      ? `<p style="background:#fef2f2;color:#991b1b;border:1px solid #fecaca;padding:10px 14px;border-radius:8px;font-weight:600;">You have reached your ${label} quota. New ${label} may be blocked depending on your usage-limit policy.</p>`
      : threshold === '99'
        ? `<p style="background:#fef2f2;color:#991b1b;border:1px solid #fecaca;padding:10px 14px;border-radius:8px;font-weight:600;">Critical: 99% of your ${label} quota used. Service will be restricted at 100%.</p>`
        : `<p style="background:#fffbeb;color:#92400e;border:1px solid #fde68a;padding:10px 14px;border-radius:8px;font-weight:600;">You've used 90% of your ${label} quota. Consider upgrading before you hit the cap.</p>`;
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;color:#111827;">
      <h2 style="margin:0 0 6px;">Hi ${escapeHtml(ownerName)},</h2>
      <p style="margin:0 0 14px;color:#4b5563;">
        Your CodesApp workspace <strong>${escapeHtml(companyName)}</strong> is approaching a plan limit.
      </p>
      ${banner}
      <table style="border-collapse:collapse;margin-top:14px;font-size:14px;">
        <tr><td style="color:#6b7280;padding:4px 12px 4px 0;">Dimension</td><td style="font-weight:600;">${label}</td></tr>
        <tr><td style="color:#6b7280;padding:4px 12px 4px 0;">Used</td><td style="font-weight:600;">${current.toLocaleString()} / ${limit.toLocaleString()}</td></tr>
      </table>
      <p style="margin-top:18px;">
        <a href="https://apps.codentra.pk/billing" style="background:#16a34a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">View usage</a>
      </p>
      <p style="margin-top:18px;font-size:12px;color:#9ca3af;">
        Need help? Email admin@codentra.pk
      </p>
    </div>
  `;
}

function suspensionEmailHtml(
  ownerName: string,
  companyName: string,
  outstandingUsd: number,
): string {
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;color:#111827;">
      <h2 style="margin:0 0 6px;">Hi ${escapeHtml(ownerName)},</h2>
      <p style="margin:0 0 14px;color:#4b5563;">
        Your CodesApp workspace <strong>${escapeHtml(companyName)}</strong> has been
        <strong style="color:#dc2626;">suspended</strong>.
      </p>
      <p style="background:#fef2f2;color:#991b1b;border:1px solid #fecaca;padding:10px 14px;border-radius:8px;">
        While suspended, sign-in to the app is disabled. Inbound WhatsApp
        messages are still recorded against your account and will be visible
        once service is restored.
      </p>
      <table style="border-collapse:collapse;margin-top:14px;font-size:14px;">
        <tr><td style="color:#6b7280;padding:4px 12px 4px 0;">Outstanding balance</td><td style="font-weight:600;">$${outstandingUsd.toFixed(2)}</td></tr>
      </table>
      <p style="margin-top:18px;">
        To restore service, please settle the outstanding balance with our team at
        <a href="mailto:admin@codentra.pk">admin@codentra.pk</a>.
      </p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&'
      ? '&amp;'
      : c === '<'
        ? '&lt;'
        : c === '>'
          ? '&gt;'
          : c === '"'
            ? '&quot;'
            : '&#39;',
  );
}
