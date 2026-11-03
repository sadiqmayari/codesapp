import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from './encryption.service';

const digits = (s?: string | null) => (s ?? '').replace(/\D/g, '');

/**
 * Keeps the Asterisk WhatsApp-Calling SIP trunk password in sync with Meta —
 * automatically, with zero SSH/config edits — so a rotated credential never
 * silently takes the trunk down.
 *
 * WHAT THE TRUNK PASSWORD ACTUALLY IS: NOT the Meta access token. It is the
 * per-number SIP credential `calling.sip.servers[].sip_user_password` returned
 * by `GET /<phone_number_id>/settings?include_sip_credentials=true`. The access
 * token is only the Bearer used to FETCH it. (An earlier version of this file
 * wrongly stored the access token itself as the password → every call failed
 * "Failed to authenticate" both directions.) Asterisk REGISTERs/authenticates
 * to `wa.meta.vc` with this ~32-char password.
 *
 * It used to be hardcoded in `deploy/asterisk/config/pjsip.conf`
 * (`${META_SIP_PASSWORD}`), so when Meta rotated it the trunk kept using the
 * dead one until a hand-edit on the box. Now the two trunk auth objects live in
 * PJSIP Realtime (`asterisk.ps_auths`), and `syncTrunkAuth` re-fetches the live
 * SIP password and upserts them whenever the token is saved (onboarding step 3,
 * add/update WhatsApp number) + a manual re-sync endpoint.
 *
 * MULTI-TENANT SAFETY: the Asterisk trunk authenticates as exactly ONE WhatsApp
 * number (`CALLS_BUSINESS_NUMBER`), so only the company that owns that number
 * may touch the shared `meta-auth` / `meta-auth-out` rows. For every other
 * tenant — and on any deployment where `CALLS_BUSINESS_NUMBER` is unset — this
 * is a safe no-op.
 *
 * Realtime rows mirror the (bootstrap) static pjsip.conf auth objects. One auth
 * = one realm (the hard-won pjsip.conf gotcha):
 *   meta-auth      realm=asterisk     inbound  (we are the SIP server)
 *   meta-auth-out  realm=wa.meta.vc   outbound (we are the SIP client)
 */
@Injectable()
export class SipTrunkAuthService {
  private readonly logger = new Logger(SipTrunkAuthService.name);
  private readonly graphVersion: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
  ) {
    this.graphVersion =
      this.config.get<string>('META_GRAPH_VERSION') ?? 'v19.0';
  }

  /**
   * Resolve the company's token + phone number, fetch the live SIP password
   * from Meta, and push it into the trunk auth rows — but only when this company
   * owns the configured calling business number. Best-effort — NEVER throws (a
   * token save must not fail because the trunk sync did). Returns a small result
   * for the manual endpoint to report.
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
      // (confirms ownership), phone_number_id (to fetch SIP creds), token.
      const number = (
        await this.prisma.whatsAppNumber.findMany({
          where: { company_id: companyId, status: 'active' },
          orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
          select: {
            display_phone_number: true,
            phone_number_id: true,
            access_token_encrypted: true,
          },
          take: 1,
        })
      )[0];

      const display = number?.display_phone_number ?? null;
      let phoneNumberId: string | null = number?.phone_number_id ?? null;
      let token: string | null = null;
      if (number?.access_token_encrypted) {
        try {
          token = this.encryption.decrypt(number.access_token_encrypted);
        } catch {
          /* fall through to the legacy onboarding token */
        }
      }

      // Legacy-company fallback: token in onboarding_status JSON, phone id on
      // companies.phone_number_id (pre-multi-number rows).
      if (!token || !phoneNumberId) {
        const company = await this.prisma.company.findUnique({
          where: { id: companyId },
          select: { onboarding_status: true, phone_number_id: true },
        });
        if (!phoneNumberId) phoneNumberId = company?.phone_number_id ?? null;
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

      // Ownership gate: this company's number must BE the calling number.
      if (!digits(display).endsWith(businessNoPlus.slice(-11))) {
        return { synced: false, reason: 'not_calling_company' };
      }
      if (!token) return { synced: false, reason: 'no_token' };
      if (!phoneNumberId) return { synced: false, reason: 'no_phone_number_id' };

      // The trunk password is Meta's sip_user_password, NOT the access token.
      const sipPassword = await this.fetchSipPassword(phoneNumberId, token);
      if (!sipPassword) return { synced: false, reason: 'no_sip_password' };

      await this.upsertTrunkAuth('meta-auth', 'asterisk', businessNoPlus, sipPassword);
      await this.upsertTrunkAuth('meta-auth-out', 'wa.meta.vc', businessNoPlus, sipPassword);
      this.logger.log(
        `SIP trunk auth synced for company ${companyId} (${businessNoPlus})`,
      );
      return { synced: true };
    } catch (e) {
      this.logger.error(`syncTrunkAuth failed: ${(e as Error).message}`);
      return { synced: false, reason: 'error' };
    }
  }

  /**
   * GET /<phoneNumberId>/settings?include_sip_credentials=true → the live
   * `calling.sip.servers[0].sip_user_password`. Null on any error / when SIP
   * isn't enabled (caller treats null as "don't touch the rows").
   */
  private fetchSipPassword(
    phoneNumberId: string,
    token: string,
  ): Promise<string | null> {
    const path = `/${this.graphVersion}/${phoneNumberId}/settings?include_sip_credentials=true`;
    return new Promise((resolve) => {
      const req = https.request(
        {
          host: 'graph.facebook.com',
          path,
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15_000,
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              if (res.statusCode !== 200) {
                this.logger.warn(
                  `SIP settings fetch HTTP ${res.statusCode} for ${phoneNumberId}`,
                );
                return resolve(null);
              }
              const json = JSON.parse(body) as {
                calling?: { sip?: { servers?: { sip_user_password?: string }[] } };
              };
              const pw =
                json?.calling?.sip?.servers?.find((s) => s?.sip_user_password)
                  ?.sip_user_password ?? null;
              resolve(pw);
            } catch (e) {
              this.logger.warn(
                `SIP settings parse failed: ${(e as Error).message}`,
              );
              resolve(null);
            }
          });
        },
      );
      req.on('error', (e) => {
        this.logger.warn(`SIP settings request error: ${e.message}`);
        resolve(null);
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
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
