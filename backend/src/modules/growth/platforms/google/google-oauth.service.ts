import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { SharedStateService } from '../../../../common/services/shared-state.service';
import { AdPlatformAuthError } from '../ad-platform.types';
import { httpJson } from '../http';
import { GoogleAdsAdapter } from './google.adapter';
import { GoogleAdsClient, TOKEN_URL, digits } from './google-ads.client';
import { YtChannel, myChannels } from './youtube.client';

/** Frontend page Google sends the browser back to (registered as the OAuth client's redirect URI). */
export const GOOGLE_CALLBACK_PATH = '/growth/connections/google';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const STATE_TTL_MS = 15 * 60_000;
const PICK_TTL_S = 30 * 60;

export type GooglePurpose = 'ads' | 'youtube';

const SCOPES: Record<GooglePurpose, string[]> = {
  ads: ['https://www.googleapis.com/auth/adwords', 'openid', 'email'],
  youtube: [
    'https://www.googleapis.com/auth/youtube.force-ssl',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
    'openid',
    'email',
  ],
};

export interface GoogleAdsPickRow {
  customerId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  /** Manager account the client is reached through (sent as login-customer-id). */
  loginCustomerId: string | null;
  managerName: string | null;
  isManager: boolean;
  testAccount: boolean;
}

interface PendingPick {
  companyId: number;
  purpose: GooglePurpose;
  refresh: string;
  email: string | null;
  accounts?: GoogleAdsPickRow[];
  channels?: YtChannel[];
}

/** Flatten customer_client rows from every accessible root into picker rows (pure, unit-tested). */
export function flattenHierarchy(
  roots: Array<{ rootId: string; rows: Array<{ id: string; name: string | null; currency: string | null; timezone: string | null; manager: boolean; level: number; test: boolean }> }>,
): GoogleAdsPickRow[] {
  const out = new Map<string, GoogleAdsPickRow>();
  for (const root of roots) {
    const self = root.rows.find((r) => r.level === 0);
    const rootIsManager = !!self?.manager;
    for (const r of root.rows) {
      if (r.level === 0 && rootIsManager) {
        // Managers are listed (as headers) but can't be connected themselves.
        if (!out.has(r.id)) out.set(r.id, { customerId: r.id, name: r.name, currency: r.currency, timezone: r.timezone, loginCustomerId: null, managerName: null, isManager: true, testAccount: r.test });
        continue;
      }
      if (r.manager) continue; // sub-managers: their clients appear under their own root
      const viaManager = r.level > 0 ? root.rootId : null;
      const row: GoogleAdsPickRow = {
        customerId: r.id, name: r.name, currency: r.currency, timezone: r.timezone,
        loginCustomerId: viaManager, managerName: viaManager ? self?.name ?? null : null, isManager: false, testAccount: r.test,
      };
      const prev = out.get(r.id);
      // Direct access beats access through a manager.
      if (!prev || (prev.loginCustomerId && !row.loginCustomerId)) out.set(r.id, row);
    }
  }
  return [...out.values()].sort((a, b) => Number(a.isManager) - Number(b.isManager) || (a.managerName ?? '').localeCompare(b.managerName ?? '') || (a.name ?? '').localeCompare(b.name ?? ''));
}

/**
 * "Connect with Google" — one OAuth client for Google Ads AND YouTube.
 * authUrl (signed state incl. purpose) → Google → GOOGLE_CALLBACK_PATH →
 * exchange(code, state) swaps the code for a refresh token, lists the Ads
 * accounts or YouTube channels, parks everything server-side (30 min) and returns
 * only a pickId + the list. The refresh token never reaches the browser.
 */
@Injectable()
export class GoogleOAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly shared: SharedStateService,
    private readonly ads: GoogleAdsAdapter,
  ) {}

  private creds() {
    const clientId = this.config.get<string>('GOOGLE_ADS_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_ADS_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new ServiceUnavailableException('Google is not set up yet (GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET missing).');
    }
    return { clientId, clientSecret };
  }

  youtubeAvailable() {
    return !!(this.config.get<string>('GOOGLE_ADS_CLIENT_ID') && this.config.get<string>('GOOGLE_ADS_CLIENT_SECRET'));
  }

  private redirectUri() {
    const origin = this.config.get<string>('APP_URL') || 'https://apps.codentra.pk';
    return `${origin.replace(/\/+$/, '')}${GOOGLE_CALLBACK_PATH}`;
  }

  private sign(payload: string): string {
    const key = this.config.get<string>('JWT_SECRET') ?? '';
    return createHmac('sha256', key).update(`google-oauth:${payload}`).digest('base64url');
  }

  authUrl(companyId: number, userId: number, purpose: GooglePurpose) {
    const { clientId } = this.creds();
    if (purpose === 'ads' && !this.ads.available) {
      throw new ServiceUnavailableException('Google Ads is not enabled yet — CodesApp\'s developer token is pending.');
    }
    const payload = `${companyId}.${userId}.${purpose}.${Date.now() + STATE_TTL_MS}.${randomBytes(6).toString('base64url')}`;
    const state = `${payload}.${this.sign(payload)}`;
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: SCOPES[purpose].join(' '),
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      state,
    });
    return { url: `${AUTH_URL}?${q.toString()}`, redirectUri: this.redirectUri() };
  }

  private verifyState(state: string, companyId: number, userId: number): GooglePurpose {
    const parts = state.split('.');
    if (parts.length !== 6) throw new BadRequestException('Invalid Google sign-in state. Start again.');
    const payload = parts.slice(0, 5).join('.');
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(parts[5]);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new BadRequestException('Invalid Google sign-in state. Start again.');
    if (Number(parts[0]) !== companyId || Number(parts[1]) !== userId) {
      throw new BadRequestException('This Google sign-in was started by another user. Start again.');
    }
    if (Date.now() > Number(parts[3])) throw new BadRequestException('Google sign-in expired. Start again.');
    const purpose = parts[2];
    if (purpose !== 'ads' && purpose !== 'youtube') throw new BadRequestException('Invalid Google sign-in state. Start again.');
    return purpose;
  }

  async exchange(companyId: number, userId: number, code: string, state: string) {
    const purpose = this.verifyState(state, companyId, userId);
    const { clientId, clientSecret } = this.creds();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: this.redirectUri() }).toString();
    type Tok = { refresh_token?: string; id_token?: string; scope?: string; error?: string; error_description?: string };
    const res = await httpJson<Tok>('POST', TOKEN_URL, { 'Content-Type': 'application/x-www-form-urlencoded' }, form);
    const refresh = res.body.refresh_token;
    if (!refresh) {
      throw new BadRequestException(
        res.body.error
          ? `Google refused the sign-in: ${res.body.error_description ?? res.body.error}`
          : 'Google did not return offline access. Remove CodesApp at myaccount.google.com → Security → Third-party access, then connect again.',
      );
    }
    const granted = (res.body.scope ?? '').split(' ');
    const missing = SCOPES[purpose].filter((s) => s.startsWith('https://') && !granted.includes(s));
    if (missing.length) throw new BadRequestException('Tick every permission on Google\'s screen — CodesApp needs all of them. Connect again.');
    const email = emailOf(res.body.id_token);
    const pick: PendingPick = { companyId, purpose, refresh, email };
    try {
      if (purpose === 'ads') pick.accounts = await this.listAdsAccounts(refresh);
      else pick.channels = await myChannels({ clientId, clientSecret, refresh });
    } catch (e) {
      throw new BadRequestException(e instanceof AdPlatformAuthError ? e.message : `Could not read your Google ${purpose === 'ads' ? 'Ads accounts' : 'YouTube channels'}: ${(e as Error).message}`);
    }
    const pickId = randomBytes(12).toString('base64url');
    await this.shared.set(`google-pick:${pickId}`, pick, PICK_TTL_S);
    return { pickId, purpose, email, accounts: pick.accounts ?? [], channels: pick.channels ?? [] };
  }

  /** Every Ads account the user reaches directly or through a manager (one level down). */
  private async listAdsAccounts(refresh: string): Promise<GoogleAdsPickRow[]> {
    const api = new GoogleAdsClient(this.ads.cfg, { r: refresh, l: null, c: null });
    const roots = await api.accessibleCustomers();
    type R = { customerClient?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean; level?: string | number; testAccount?: boolean; status?: string } };
    const out: Parameters<typeof flattenHierarchy>[0] = [];
    for (const rootId of roots.slice(0, 50)) {
      try {
        const rows = await api.gaql<R>(
          'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, ' +
            "customer_client.manager, customer_client.level, customer_client.test_account, customer_client.status FROM customer_client WHERE customer_client.level <= 1 AND customer_client.status = 'ENABLED'",
          { customerId: rootId, loginCustomerId: rootId },
        );
        out.push({
          rootId,
          rows: rows
            .map((r) => r.customerClient)
            .filter((c): c is NonNullable<typeof c> => !!c?.id)
            .map((c) => ({ id: digits(c.id)!, name: c.descriptiveName ?? null, currency: c.currencyCode ?? null, timezone: c.timeZone ?? null, manager: !!c.manager, level: Number(c.level ?? 0), test: !!c.testAccount })),
        });
      } catch (e) {
        // A closed / suspended root can't be queried; keep the others. Approval errors are global → surface.
        if (e instanceof AdPlatformAuthError && e.kind === 'permission' && /approval|Basic access/i.test(e.message)) throw e;
      }
    }
    return flattenHierarchy(out);
  }

  async takePick(companyId: number, pickId: string, purpose: GooglePurpose): Promise<PendingPick> {
    const pick = await this.shared.get<PendingPick>(`google-pick:${pickId}`);
    if (!pick || pick.companyId !== companyId || pick.purpose !== purpose) throw new BadRequestException('Google sign-in expired. Connect again.');
    return pick;
  }
}

/** Email claim from Google's id_token (came straight from Google over TLS — display only). */
function emailOf(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}
