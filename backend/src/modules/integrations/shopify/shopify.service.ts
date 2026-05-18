import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/services/encryption.service';

@Injectable()
export class ShopifyService {
  private readonly logger = new Logger(ShopifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
  ) {}

  getOAuthUrl(companyId: number): { url: string } {
    const clientId = this.config.get('SHOPIFY_CLIENT_ID');
    const appUrl = this.config.get('APP_URL');
    const state = Buffer.from(JSON.stringify({ companyId })).toString('base64');
    const redirectUri = `${appUrl}/integrations/shopify/callback`;
    const scopes = 'read_orders,read_customers';

    // Shop domain must be provided by client — this returns the template URL
    const url = `https://{shop}.myshopify.com/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    return { url };
  }

  async handleCallback(shop: string, code: string, state: string) {
    let companyId: number;
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
      companyId = decoded.companyId;
    } catch {
      throw new UnauthorizedException('Invalid OAuth state');
    }

    // Exchange code for access token
    const clientId = this.config.get('SHOPIFY_CLIENT_ID');
    const clientSecret = this.config.get('SHOPIFY_CLIENT_SECRET');
    const appUrl = this.config.get('APP_URL');

    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });

    if (!res.ok) throw new UnauthorizedException('Shopify token exchange failed');

    const { access_token } = (await res.json()) as { access_token: string };
    const webhookSecret = this.config.get('SHOPIFY_WEBHOOK_SECRET') ?? '';

    const encryptedToken = this.encryption.encrypt(access_token);
    const encryptedSecret = this.encryption.encrypt(webhookSecret);

    await this.prisma.shopifyIntegration.upsert({
      where: { company_id: companyId },
      create: {
        company_id: companyId,
        shop_domain: shop,
        access_token_encrypted: encryptedToken,
        webhook_secret_encrypted: encryptedSecret,
        active_events: ['orders/create', 'orders/fulfilled'],
        status: 'active',
      },
      update: {
        shop_domain: shop,
        access_token_encrypted: encryptedToken,
        webhook_secret_encrypted: encryptedSecret,
        status: 'active',
      },
    });

    return { message: 'Shopify connected', shop };
  }

  async handleWebhook(
    topic: string,
    hmac: string,
    rawBody: Buffer,
  ): Promise<void> {
    const secret = this.config.get('SHOPIFY_WEBHOOK_SECRET');
    if (!secret) return;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
      throw new UnauthorizedException('Invalid Shopify HMAC');
    }

    this.logger.log(`Shopify webhook received: ${topic}`);

    // TODO (Phase 2): Wire up order event handlers when templates module exists
    // Handlers needed: orders/create, orders/fulfilled, orders/cancelled, orders/paid
  }

  async getIntegration(companyId: number) {
    const integration = await this.prisma.shopifyIntegration.findUnique({
      where: { company_id: companyId },
      select: {
        id: true,
        shop_domain: true,
        active_events: true,
        status: true,
        created_at: true,
      },
    });
    if (!integration) throw new NotFoundException('No Shopify integration found');
    return integration;
  }

  /** Settings UI variant — returns null instead of throwing when unlinked. */
  async getIntegrationOrNull(companyId: number) {
    return this.prisma.shopifyIntegration.findUnique({
      where: { company_id: companyId },
      select: {
        id: true,
        shop_domain: true,
        active_events: true,
        status: true,
        created_at: true,
      },
    });
  }

  async updateEvents(companyId: number, events: string[]) {
    const allowed = [
      'orders/create',
      'orders/paid',
      'orders/fulfilled',
      'orders/cancelled',
    ];
    const clean = Array.from(
      new Set(events.filter((e) => allowed.includes(e))),
    );
    const integration = await this.prisma.shopifyIntegration.findUnique({
      where: { company_id: companyId },
      select: { id: true },
    });
    if (!integration) throw new NotFoundException('No Shopify integration found');
    return this.prisma.shopifyIntegration.update({
      where: { company_id: companyId },
      data: { active_events: clean },
      select: {
        id: true,
        shop_domain: true,
        active_events: true,
        status: true,
        created_at: true,
      },
    });
  }

  async disconnect(companyId: number) {
    await this.prisma.shopifyIntegration.delete({
      where: { company_id: companyId },
    });
    return { message: 'Shopify disconnected' };
  }

  /**
   * Per-tenant Shopify webhook key (mirrors Meta Option B `webhook_key`).
   * Immutable, company-name-seeded, generated once — the client pastes
   * `/webhooks/shopify/{key}` into their own Shopify app's webhook config.
   */
  private async ensureShopifyWebhookKey(companyId: number): Promise<string> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { company_name: true, shopify_webhook_key: true },
    });
    if (!company) throw new NotFoundException('Company not found');
    if (company.shopify_webhook_key) return company.shopify_webhook_key;

    const slug =
      company.company_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'company';
    let key = `${slug}-sh-${crypto.randomBytes(6).toString('hex')}`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = `${slug}-sh-${crypto
        .randomBytes(attempt === 0 ? 3 : 5)
        .toString('hex')}`;
      const clash = await this.prisma.company.findFirst({
        where: { shopify_webhook_key: candidate },
        select: { id: true },
      });
      if (!clash) {
        key = candidate;
        break;
      }
    }
    await this.prisma.company.update({
      where: { id: companyId },
      data: { shopify_webhook_key: key },
    });
    return key;
  }

  /**
   * Per-tenant Shopify webhook receiver (Phase 2). Resolves the company by
   * the URL key, verifies the HMAC with THAT company's stored signing
   * secret, and parses `orders/create`. Phase 2 only validates + parses +
   * logs; the template send + order tagging come in Phase 4.
   */
  async handleTenantOrderWebhook(
    key: string,
    topic: string,
    hmacHeader: string,
    rawBody: Buffer,
  ): Promise<{ received: true; ignored?: string }> {
    const company = await this.prisma.company.findFirst({
      where: { shopify_webhook_key: key },
      select: { id: true, shopify_webhook_secret_encrypted: true },
    });
    if (!company) {
      throw new UnauthorizedException('Unknown Shopify webhook key');
    }
    if (!company.shopify_webhook_secret_encrypted) {
      throw new UnauthorizedException(
        'Shopify webhook secret not configured for this company',
      );
    }

    let secret: string;
    try {
      secret = this.encryption.decrypt(
        company.shopify_webhook_secret_encrypted,
      );
    } catch {
      throw new UnauthorizedException('Cannot decrypt Shopify webhook secret');
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');
    const a = Buffer.from(hmacHeader || '', 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid Shopify HMAC');
    }

    // Only orders/create drives the confirmation flow for now.
    if (topic !== 'orders/create') {
      this.logger.log(
        `Shopify webhook for company ${company.id} ignored (topic=${topic})`,
      );
      return { received: true, ignored: topic };
    }

    let order: {
      id?: number | string;
      name?: string;
      total_price?: string;
      currency?: string;
      customer?: { phone?: string; first_name?: string; last_name?: string };
      phone?: string;
    };
    try {
      order = JSON.parse(rawBody.toString('utf8'));
    } catch {
      this.logger.warn(
        `Shopify orders/create for company ${company.id}: unparseable body`,
      );
      return { received: true, ignored: 'bad-json' };
    }

    this.logger.log(
      `Shopify orders/create company=${company.id} order=${
        order.name ?? order.id
      } total=${order.total_price ?? '?'} ${order.currency ?? ''} ` +
        `phone=${order.customer?.phone ?? order.phone ?? 'n/a'} ` +
        `[Phase 2: validated+parsed only — send+tag is Phase 4]`,
    );
    return { received: true };
  }

  async getWebhookConfig(companyId: number) {
    const webhookKey = await this.ensureShopifyWebhookKey(companyId);
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { shopify_webhook_secret_encrypted: true },
    });
    return {
      webhookKey,
      webhookSecretSet: !!c?.shopify_webhook_secret_encrypted,
    };
  }

  async setWebhookSecret(companyId: number, secret: string) {
    if (this.encryption.isUsingPlaceholderKey()) {
      throw new ServiceUnavailableException(
        'Server encryption key is not configured — refusing to store secrets.',
      );
    }
    const trimmed = secret.trim();
    if (trimmed.length < 8) {
      throw new BadRequestException(
        'Shopify webhook signing secret looks too short',
      );
    }
    await this.ensureShopifyWebhookKey(companyId);
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        shopify_webhook_secret_encrypted: this.encryption.encrypt(trimmed),
      },
    });
    return { webhookSecretSet: true };
  }
}
