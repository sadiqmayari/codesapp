import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { SharedStateService } from '../../../../common/services/shared-state.service';
import { httpJson } from '../http';

const BASE = 'https://business-api.tiktok.com/open_api/v1.3';
const AUTH_URL = 'https://business-api.tiktok.com/portal/auth';
/** Frontend page TikTok sends the browser back to (must equal the app's Advertiser redirect URL). */
export const TIKTOK_CALLBACK_PATH = '/growth/connections/tiktok';
const STATE_TTL_MS = 15 * 60_000;
const PICK_TTL_S = 30 * 60;

export interface TikTokAdvertiser {
  id: string;
  name: string | null;
}

interface PendingPick {
  companyId: number;
  token: string;
  advertisers: TikTokAdvertiser[];
}

/**
 * TikTok for Business advertiser authorisation (one CodesApp app, accounts
 * added by opening our auth link — like the Meta platform app).
 *
 * Flow: `authUrl` (signed state) → TikTok → browser lands on
 * TIKTOK_CALLBACK_PATH → `exchange(auth_code, state)` swaps the code for a
 * long-lived advertiser token, parks it server-side (SharedStateService, 30 min)
 * and returns only a `pickId` + the advertiser list. `takePick` hands the token
 * to the normal connect path. The token never reaches the browser.
 */
@Injectable()
export class TikTokOAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly shared: SharedStateService,
  ) {}

  private creds() {
    const appId = this.config.get<string>('TIKTOK_APP_ID');
    const secret = this.config.get<string>('TIKTOK_APP_SECRET');
    if (!appId || !secret) {
      throw new ServiceUnavailableException('TikTok is not set up yet (TIKTOK_APP_ID / TIKTOK_APP_SECRET missing).');
    }
    return { appId, secret };
  }

  private sign(payload: string): string {
    const key = this.config.get<string>('JWT_SECRET') ?? '';
    return createHmac('sha256', key).update(`tiktok-oauth:${payload}`).digest('base64url');
  }

  /** Redirect URI is built from APP_URL — it must match the app's registered Advertiser redirect URL exactly. */
  authUrl(companyId: number, userId: number) {
    const { appId } = this.creds();
    const origin = this.config.get<string>('APP_URL') || 'https://apps.codentra.pk';
    const payload = `${companyId}.${userId}.${Date.now() + STATE_TTL_MS}.${randomBytes(6).toString('base64url')}`;
    const state = `${payload}.${this.sign(payload)}`;
    const redirect = `${origin.replace(/\/+$/, '')}${TIKTOK_CALLBACK_PATH}`;
    const url = `${AUTH_URL}?app_id=${encodeURIComponent(appId)}&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirect)}`;
    return { url, redirectUri: redirect };
  }

  private verifyState(state: string, companyId: number, userId: number) {
    const parts = state.split('.');
    if (parts.length !== 5) throw new BadRequestException('Invalid TikTok sign-in state. Start again.');
    const payload = parts.slice(0, 4).join('.');
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(parts[4]);
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      throw new BadRequestException('Invalid TikTok sign-in state. Start again.');
    }
    if (Number(parts[0]) !== companyId || Number(parts[1]) !== userId) {
      throw new BadRequestException('This TikTok sign-in was started by another user. Start again.');
    }
    if (Date.now() > Number(parts[2])) throw new BadRequestException('TikTok sign-in expired. Start again.');
  }

  async exchange(companyId: number, userId: number, authCode: string, state: string) {
    this.verifyState(state, companyId, userId);
    const { appId, secret } = this.creds();
    type Tok = { code?: number; message?: string; data?: { access_token?: string; advertiser_ids?: Array<string | number> } };
    const res = await httpJson<Tok>('POST', `${BASE}/oauth2/access_token/`, {}, { app_id: appId, secret, auth_code: authCode });
    const token = res.body.data?.access_token;
    if (res.body.code !== 0 || !token) {
      throw new BadRequestException(`TikTok refused the sign-in: ${res.body.message ?? `error ${res.body.code ?? res.status}`}`);
    }
    const ids = (res.body.data?.advertiser_ids ?? []).map(String);
    const advertisers = await this.advertiserNames(token, appId, secret, ids);
    const pickId = randomBytes(12).toString('base64url');
    const pick: PendingPick = { companyId, token, advertisers };
    await this.shared.set(`tiktok-pick:${pickId}`, pick, PICK_TTL_S);
    return { pickId, advertisers };
  }

  /** Names for the picker; falls back to bare ids if the lookup fails. */
  private async advertiserNames(token: string, appId: string, secret: string, ids: string[]): Promise<TikTokAdvertiser[]> {
    try {
      type L = { code?: number; data?: { list?: Array<{ advertiser_id?: string | number; advertiser_name?: string }> } };
      const q = `app_id=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`;
      const res = await httpJson<L>('GET', `${BASE}/oauth2/advertiser/get/?${q}`, { 'Access-Token': token });
      const list = res.body.code === 0 ? res.body.data?.list ?? [] : [];
      const names = new Map(list.map((a) => [String(a.advertiser_id), a.advertiser_name ?? null]));
      const all = ids.length ? ids : [...names.keys()];
      return all.map((id) => ({ id, name: names.get(id) ?? null }));
    } catch {
      return ids.map((id) => ({ id, name: null }));
    }
  }

  async takePick(companyId: number, pickId: string) {
    const pick = await this.shared.get<PendingPick>(`tiktok-pick:${pickId}`);
    if (!pick || pick.companyId !== companyId) {
      throw new BadRequestException('TikTok sign-in expired. Connect again.');
    }
    return pick;
  }
}
