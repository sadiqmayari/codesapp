import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from './encryption.service';

const digits = (s?: string | null) => (s ?? '').replace(/\D/g, '');

/**
 * Keeps the Asterisk WhatsApp-Calling SIP trunk password in sync with the
 * company's Meta System User access token — automatically, with zero SSH/config
 * edits — so a rotated Meta token never silently takes the trunk down.
 *
 * WHY THIS EXISTS: the Meta System User access token doubles as the SIP trunk
 * password Asterisk REGISTERs to `wa.meta.vc` with. It used to be hardcoded in
 * `deploy/asterisk/config/pjsip.conf` (`${META_SIP_PASSWORD}`), so rotating the
 * token in CodesApp left Asterisk authenticating with the dead one → every call
 * rejected until someone hand-edited the config on the box. Now the two trunk
 * auth objects live in PJSIP Realtime (`asterisk.ps_auths`), and this service
 * upserts them whenever the token is saved anywhere in the app (onboarding
 * step 3, add/update WhatsApp number) + a manual re-sync endpoint.
 *
 * MULTI-TENANT SAFETY: the Asterisk trunk authenticates as exactly ONE WhatsApp
 * number (`CALLS_BUSINESS_NUMBER`), so only the company that owns that number
 * may touch the shared `meta-auth` / `meta-auth-out` rows. For every other
 * tenant — and on any deployment where `CALLS_BUSINESS_NUMBER` is unset
 * (i.e. calling isn't configured) — this is a safe no-op.
 *
 * Realtime rows mirror the (now-removed) static pjsip.conf auth objects. One
 * auth = one realm (the hard-won pjsip.conf gotcha):
 *   meta-auth      realm=asterisk     inbound  (we are the SIP server)
 *   meta-auth-out  realm=wa.meta.vc   outbound (we are the SIP client)
 */
@Injectable()
export class SipTrunkAuthService {
  private readonly logger = new Logger(SipTrunkAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Resolve the company's Meta token and push it into the trunk auth rows, but
   * only when this company owns the configured calling business number.
   * Best-effort — NEVER throws (a token save must not fail because the trunk
   * sync did). Returns a small result for the manual endpoint to report.
   */
  async syncTrunkAuth(
    companyId: number,
  ): Promise<{ synced: boolean; reason?: string }> {
    try {
      const businessNoPlus = digits(
        this.config.get<string>('CALLS_BUSINESS_NUMBER'),
      );
      if (!businessNoPlus) {
        return { synced: false, reason: 'calls_business_number_unset' };
      }

      // Primary active WhatsApp number for this company → its display number
      // (to confirm ownership of the calling number) + its encrypted token.
      const number = (
        await this.prisma.whatsAppNumber.findMany({
          where: { company_id: companyId, status: 'active' },
          orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
          select: { display_phone_number: true, access_token_encrypted: true },
          take: 1,
        })
      )[0];

      const display = number?.display_phone_number ?? null;
      let token: string | null = null;
      if (number?.access_token_encrypted) {
        try {
          token = this.encryption.decrypt(number.access_token_encrypted);
        } catch {
          /* fall through to the legacy onboarding token */
        }
      }

      // Legacy-company fallback: token lives in onboarding_status JSON
      // (pre-multi-number rows that never got a whatsapp_numbers token).
      if (!token) {
        const company = await this.prisma.company.findUnique({
          where: { id: companyId },
          select: { onboarding_status: true },
        });
        const onb = company?.onboarding_status as {
          metaAccessTokenEncrypted?: string;
          metaAccessToken?: string;
        } | null;
        const enc = onb?.metaAccessTokenEncrypted ?? onb?.metaAccessToken;
        if (!token && enc) {
          try {
            token = this.encryption.decrypt(enc);
          } catch {
            /* ignore */
          }
        }
      }

      // Ownership gate: this company's number must BE the calling number. A
      // missing/mismatched display number means we cannot safely claim the
      // shared trunk rows — skip (the real gate is still CALLS_BUSINESS_NUMBER).
      if (!digits(display).endsWith(businessNoPlus.slice(-11))) {
        return { synced: false, reason: 'not_calling_company' };
      }
      if (!token) return { synced: false, reason: 'no_token' };

      await this.upsertTrunkAuth('meta-auth', 'asterisk', businessNoPlus, token);
      await this.upsertTrunkAuth(
        'meta-auth-out',
        'wa.meta.vc',
        businessNoPlus,
        token,
      );
      this.logger.log(
        `SIP trunk auth synced for company ${companyId} (${businessNoPlus})`,
      );
      return { synced: true };
    } catch (e) {
      this.logger.error(`syncTrunkAuth failed: ${(e as Error).message}`);
      return { synced: false, reason: 'error' };
    }
  }

  /** Upsert one ps_auths row (realm is REQUIRED — one auth object per realm). */
  private async upsertTrunkAuth(
    id: string,
    realm: string,
    username: string,
    password: string,
  ) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO asterisk.ps_auths (id,auth_type,realm,username,password)
       VALUES (?, 'userpass', ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         realm=VALUES(realm), username=VALUES(username), password=VALUES(password)`,
      id,
      realm,
      username,
      password,
    );
  }
}
