import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { isReturned } from '../../common/utils/shipment-outcome';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureService } from '../../common/services/feature.service';
import { CommerceResolverService } from '../integrations/commerce/commerce-provider.resolver';
import type { CourierType } from '@prisma/client';
import { courierTrackingUrl } from '../couriers/couriers.constants';
import {
  AddVideoDto,
  CreateManualSubmissionDto,
  CreatePrCampaignDto,
  DecideSubmissionDto,
  SendPackageDto,
  SetOutcomeDto,
  UpdateInfluencerDto,
  UpdatePrCampaignDto,
  UpdateVideoDto,
} from './dto/pr.dto';
import { influencerKey, slugify } from './pr.util';
import { clampQuery } from '../../common/utils/search';
import { phoneSearchDigits } from '../../common/utils/contact-phone';

/** Shape the influencer upsert reads from (submission or send). */
type InfluencerSeed = {
  influencer_name?: string;
  name?: string;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  address?: string | null;
  instagram?: string | null;
  tiktok?: string | null;
  follower_count?: number | null;
};

@Injectable()
export class PrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feature: FeatureService,
    private readonly commerce: CommerceResolverService,
  ) {}

  async assertEnabled(companyId: number) {
    const on = await this.feature.prEnabled(companyId);
    if (!on) throw new ForbiddenException('PR module is not enabled');
  }

  // ─── Campaigns ──────────────────────────────────────────────────────────────
  async listCampaigns(companyId: number) {
    const [company, campaigns] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { public_slug: true },
      }),
      this.prisma.prCampaign.findMany({
        where: { company_id: companyId },
        orderBy: { created_at: 'desc' },
        include: { _count: { select: { submissions: true } } },
      }),
    ]);
    // Attach the tenant slug so the frontend can build the public subdomain URL.
    return campaigns.map((c) => ({
      ...c,
      company_public_slug: company?.public_slug ?? null,
    }));
  }

  /** Ensure a slug unique within the company (append -2, -3… on collision). */
  private async uniqueSlug(companyId: number, base: string, excludeId?: number) {
    let slug = slugify(base);
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? slug : `${slug}-${n}`;
      const clash = await this.prisma.prCampaign.findFirst({
        where: {
          company_id: companyId,
          slug: candidate,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true },
      });
      if (!clash) return candidate;
    }
    return `${slug}-${Date.now()}`;
  }

  async createCampaign(companyId: number, dto: CreatePrCampaignDto) {
    const slug = await this.uniqueSlug(companyId, dto.slug || dto.name);
    return this.prisma.prCampaign.create({
      data: {
        company_id: companyId,
        name: dto.name.trim(),
        slug,
        intro: dto.intro ?? null,
        terms: dto.terms ?? null,
        public_token: crypto.randomBytes(18).toString('base64url'),
      },
    });
  }

  async getCampaign(companyId: number, id: number) {
    const c = await this.prisma.prCampaign.findFirst({
      where: { id, company_id: companyId },
    });
    if (!c) throw new NotFoundException('Campaign not found');
    return c;
  }

  async updateCampaign(companyId: number, id: number, dto: UpdatePrCampaignDto) {
    await this.getCampaign(companyId, id);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.intro !== undefined) data.intro = dto.intro;
    if (dto.terms !== undefined) data.terms = dto.terms;
    if (dto.active !== undefined) data.active = dto.active;
    // Only churn the slug when explicitly provided (keep URLs stable on rename).
    if (dto.slug !== undefined) {
      data.slug = await this.uniqueSlug(companyId, dto.slug, id);
    }
    return this.prisma.prCampaign.update({ where: { id }, data });
  }

  async deleteCampaign(companyId: number, id: number) {
    await this.getCampaign(companyId, id);
    await this.prisma.$transaction([
      this.prisma.prSubmission.deleteMany({ where: { campaign_id: id } }),
      this.prisma.prCampaign.delete({ where: { id } }),
    ]);
    return { ok: true };
  }

  // ─── Submissions ──────────────────────────────────────────────────────────────
  listSubmissions(
    companyId: number,
    filter: { campaignId?: number; status?: string },
  ) {
    return this.prisma.prSubmission.findMany({
      where: {
        company_id: companyId,
        ...(filter.campaignId ? { campaign_id: filter.campaignId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { created_at: 'desc' },
      include: {
        campaign: { select: { id: true, name: true } },
        videos: { orderBy: { created_at: 'asc' } },
      },
    });
  }

  async getSubmission(companyId: number, id: number) {
    const s = await this.prisma.prSubmission.findFirst({
      where: { id, company_id: companyId },
      include: {
        campaign: { select: { id: true, name: true } },
        videos: { orderBy: { created_at: 'asc' } },
      },
    });
    if (!s) throw new NotFoundException('Submission not found');
    return s;
  }

  /**
   * Every PR package that has shipped (`status='sent'` + a commerce order),
   * hydrated with its live courier shipment status so the PR Orders tab can
   * show delivery tracking. Reuses the local order mirror + shipment join (the
   * same shape `ShopifyService.listContactOrders` builds for the inbox) so the
   * existing `OrderTrackingModal` / tracking helpers work unchanged — no new
   * courier logic. Hydration is done inline with prisma (not by importing
   * ShopifyService) to avoid a cross-module import cycle.
   */
  async listPrOrders(companyId: number) {
    const subs = await this.prisma.prSubmission.findMany({
      where: {
        company_id: companyId,
        status: 'sent',
        shopify_order_gid: { not: null },
      },
      orderBy: { decided_at: 'desc' },
      include: {
        campaign: { select: { id: true, name: true } },
        videos: { select: { id: true } },
      },
    });

    const gids = subs
      .map((s) => s.shopify_order_gid)
      .filter((g): g is string => !!g);

    const [mirror, ships] = await Promise.all([
      gids.length
        ? this.prisma.shopifyOrder.findMany({
            where: { company_id: companyId, shopify_order_gid: { in: gids } },
            select: {
              shopify_order_gid: true,
              order_name: true,
              financial_status: true,
              fulfillment_status: true,
              total_price: true,
              total_outstanding: true,
              currency: true,
              shopify_created_at: true,
              line_items_summary: true,
              cancelled_at: true,
              archived_at: true,
            },
          })
        : Promise.resolve([]),
      gids.length
        ? this.prisma.shipment.findMany({
            where: { company_id: companyId, shopify_order_gid: { in: gids } },
            select: {
              id: true,
              shopify_order_gid: true,
              status: true,
              received_at: true,
              courier_type: true,
              courier_tracking_number: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const orderByGid = new Map(mirror.map((o) => [o.shopify_order_gid, o]));
    const shipByGid = new Map(ships.map((s) => [s.shopify_order_gid, s]));

    return subs.map((s) => {
      const gid = s.shopify_order_gid as string;
      const o = orderByGid.get(gid) ?? null;
      const ship = shipByGid.get(gid) ?? null;
      const trackingUrl =
        ship?.courier_type && ship?.courier_tracking_number
          ? courierTrackingUrl(
              ship.courier_type as CourierType,
              ship.courier_tracking_number,
            ) ?? null
          : null;
      const videosCount = Number((s.form_data as any)?.videosCount);
      return {
        // ── PR context ──
        submissionId: s.id,
        influencerId: s.influencer_id,
        influencerName: s.influencer_name,
        campaign: s.campaign ? { id: s.campaign.id, name: s.campaign.name } : null,
        videosDelivered: s.videos.length,
        videosPromised: Number.isFinite(videosCount) ? videosCount : null,
        sentAt: s.decided_at,
        // ── ContactOrder shape (for OrderTrackingModal + tracking helpers) ──
        orderGid: gid,
        orderName: o?.order_name ?? s.order_name ?? null,
        financialStatus: o?.financial_status ?? null,
        fulfillmentStatus: o?.fulfillment_status ?? null,
        shipmentId: ship?.id ?? null,
        shipmentStatus: ship?.status ?? null,
        // Physically received / courier-returned (status may read 'cancelled').
        returned: isReturned(ship),
        courierType: ship?.courier_type ?? null,
        trackingNumber: ship?.courier_tracking_number ?? null,
        trackingUrl,
        total: o?.total_price == null ? null : Number(o.total_price),
        outstanding: o?.total_outstanding == null ? null : Number(o.total_outstanding),
        currency: o?.currency ?? null,
        createdAt: o?.shopify_created_at ?? null,
        itemsSummary: o?.line_items_summary ?? null,
        cancelled: o?.cancelled_at != null,
        archived: o?.archived_at != null,
      };
    });
  }

  async decide(
    companyId: number,
    id: number,
    dto: DecideSubmissionDto,
    userId: number,
  ) {
    const s = await this.getSubmission(companyId, id);
    if (s.status === 'sent') {
      throw new BadRequestException('A package was already sent for this submission');
    }
    return this.prisma.prSubmission.update({
      where: { id },
      data: {
        status: dto.decision,
        decided_by_user_id: userId,
        decided_at: new Date(),
      },
    });
  }

  /**
   * Manually add an influencer who reached the brand outside the public form
   * (DM, WhatsApp, event, referral). Creates a PRE-APPROVED submission under a
   * campaign plus the linked CRM profile (deduped), so the manager can then
   * ship via the existing send-package flow.
   */
  async createManualSubmission(
    companyId: number,
    dto: CreateManualSubmissionDto,
    userId: number,
  ) {
    const campaign = await this.getCampaign(companyId, dto.campaignId);

    const name = dto.influencerName.trim();
    const seed: InfluencerSeed = {
      influencer_name: name,
      phone: dto.phone?.trim() || null,
      email: dto.email?.trim() || null,
      instagram: dto.instagram?.trim() || null,
      tiktok: dto.tiktok?.trim() || null,
      city: dto.city?.trim() || null,
      address: dto.address?.trim() || null,
      follower_count: dto.followerCount ?? null,
    };

    if (!influencerKey(seed)) {
      throw new BadRequestException(
        'Add a phone, Instagram, or email so the influencer can be tracked',
      );
    }

    const influencerId = await this.upsertInfluencer(companyId, seed);

    // Fill niche/notes onto the profile without clobbering manual edits.
    if (influencerId && (dto.niche || dto.notes)) {
      const profile = await this.prisma.prInfluencer.findUnique({
        where: { id: influencerId },
        select: { niche: true, notes: true },
      });
      const patch: Record<string, unknown> = {};
      if (dto.niche?.trim() && !profile?.niche) patch.niche = dto.niche.trim();
      if (dto.notes?.trim() && !profile?.notes) patch.notes = dto.notes.trim();
      if (Object.keys(patch).length) {
        await this.prisma.prInfluencer.update({
          where: { id: influencerId },
          data: patch,
        });
      }
    }

    return this.prisma.prSubmission.create({
      data: {
        company_id: companyId,
        campaign_id: dto.campaignId,
        influencer_id: influencerId,
        influencer_name: name,
        phone: seed.phone,
        email: seed.email,
        city: seed.city,
        address: seed.address,
        instagram: seed.instagram,
        tiktok: seed.tiktok,
        follower_count: seed.follower_count,
        product_wishlist: null,
        form_data: { manual: true, addedBy: userId, niche: dto.niche?.trim() || null },
        status: 'approved',
        decided_by_user_id: userId,
        decided_at: new Date(),
      },
      include: { campaign: { select: { id: true, name: true } } },
    });
  }

  // ─── Influencer CRM ─────────────────────────────────────────────────────────

  /**
   * Create-or-link an influencer profile from a submission/send seed, deduped
   * by phone→Instagram→email. Fills blank profile fields from the seed but
   * never overwrites manually-edited values. Returns the profile id (or null
   * when the seed has no usable identity key).
   */
  async upsertInfluencer(
    companyId: number,
    seed: InfluencerSeed,
    opts: { bumpPackage?: boolean } = {},
  ): Promise<number | null> {
    const key = influencerKey(seed);
    if (!key) return null;
    const name = (seed.name || seed.influencer_name || 'Influencer').trim();

    const existing = await this.prisma.prInfluencer.findUnique({
      where: { company_id_dedup_key: { company_id: companyId, dedup_key: key } },
    });

    if (!existing) {
      const created = await this.prisma.prInfluencer.create({
        data: {
          company_id: companyId,
          dedup_key: key,
          name,
          phone: seed.phone ?? null,
          email: seed.email ?? null,
          city: seed.city ?? null,
          address: seed.address ?? null,
          instagram: seed.instagram ?? null,
          tiktok: seed.tiktok ?? null,
          follower_count: seed.follower_count ?? null,
          packages_count: opts.bumpPackage ? 1 : 0,
          last_package_at: opts.bumpPackage ? new Date() : null,
        },
      });
      return created.id;
    }

    // Fill only blanks; respect manual edits.
    const fill: Record<string, unknown> = {};
    const maybe = (field: keyof InfluencerSeed, col: string) => {
      const val = seed[field];
      if (val != null && val !== '' && (existing as any)[col] == null) {
        fill[col] = val;
      }
    };
    maybe('phone', 'phone');
    maybe('email', 'email');
    maybe('city', 'city');
    maybe('address', 'address');
    maybe('instagram', 'instagram');
    maybe('tiktok', 'tiktok');
    maybe('follower_count', 'follower_count');
    if (opts.bumpPackage) {
      fill.packages_count = { increment: 1 };
      fill.last_package_at = new Date();
    }
    if (Object.keys(fill).length) {
      await this.prisma.prInfluencer.update({ where: { id: existing.id }, data: fill });
    }
    return existing.id;
  }

  listInfluencers(
    companyId: number,
    filter: { status?: string; q?: string },
  ) {
    const q = clampQuery(filter.q);
    // "@handle" matches the stored handle/URL; phone matches in any format
    // (0300… / +92300… / 92300…); TikTok is searched too.
    const handle = q.replace(/^@+/, '');
    const pd = phoneSearchDigits(q);
    return this.prisma.prInfluencer.findMany({
      where: {
        company_id: companyId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q } },
                { instagram: { contains: handle || q } },
                { tiktok: { contains: handle || q } },
                { phone: { contains: q } },
                ...(pd && pd !== q ? [{ phone: { contains: pd } }] : []),
                { email: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: [{ last_package_at: 'desc' }, { created_at: 'desc' }],
    });
  }

  async getInfluencer(companyId: number, id: number) {
    const profile = await this.prisma.prInfluencer.findFirst({
      where: { id, company_id: companyId },
    });
    if (!profile) throw new NotFoundException('Influencer not found');
    const submissions = await this.prisma.prSubmission.findMany({
      where: { company_id: companyId, influencer_id: id },
      orderBy: { created_at: 'desc' },
      include: {
        campaign: { select: { id: true, name: true } },
        videos: { orderBy: { created_at: 'asc' } },
      },
    });
    return { profile, submissions };
  }

  async updateInfluencer(companyId: number, id: number, dto: UpdateInfluencerDto) {
    const profile = await this.prisma.prInfluencer.findFirst({
      where: { id, company_id: companyId },
      select: { id: true },
    });
    if (!profile) throw new NotFoundException('Influencer not found');
    const data: Record<string, unknown> = {};
    for (const k of [
      'name', 'phone', 'email', 'city', 'address', 'instagram',
      'tiktok', 'other_social', 'follower_count', 'niche', 'status', 'notes',
    ] as const) {
      if (dto[k] !== undefined) data[k] = dto[k];
    }
    if (dto.tags !== undefined) data.tags = dto.tags;
    return this.prisma.prInfluencer.update({ where: { id }, data });
  }

  async setOutcome(companyId: number, submissionId: number, dto: SetOutcomeDto) {
    await this.getSubmission(companyId, submissionId);
    return this.prisma.prSubmission.update({
      where: { id: submissionId },
      data: {
        outcome: dto.outcome,
        post_url: dto.postUrl ?? null,
        posted_at: dto.outcome === 'posted' ? new Date() : null,
      },
    });
  }

  // ─── Influencer videos (one submission → many videos) ─────────────────────────

  /**
   * Derive the submission-level `outcome`/`posted_at` from its videos so the
   * existing badge keeps working. ≥1 video ⇒ 'posted' (posted_at = earliest
   * video); 0 videos ⇒ keep a manual 'no_show', else fall back to 'pending'.
   */
  private async recomputeOutcome(submissionId: number) {
    const videos = await this.prisma.prVideo.findMany({
      where: { submission_id: submissionId },
      orderBy: { posted_at: 'asc' },
      select: { posted_at: true },
    });
    if (videos.length > 0) {
      await this.prisma.prSubmission.update({
        where: { id: submissionId },
        data: {
          outcome: 'posted',
          posted_at: videos[0].posted_at ?? new Date(),
        },
      });
      return;
    }
    const current = await this.prisma.prSubmission.findUnique({
      where: { id: submissionId },
      select: { outcome: true },
    });
    await this.prisma.prSubmission.update({
      where: { id: submissionId },
      data: {
        outcome: current?.outcome === 'no_show' ? 'no_show' : 'pending',
        posted_at: null,
      },
    });
  }

  async addVideo(companyId: number, submissionId: number, dto: AddVideoDto) {
    const submission = await this.getSubmission(companyId, submissionId);
    const video = await this.prisma.prVideo.create({
      data: {
        company_id: companyId,
        submission_id: submissionId,
        influencer_id: submission.influencer_id,
        url: dto.url.trim(),
        platform: dto.platform ?? null,
        status: dto.status ?? 'posted',
        notes: dto.notes?.trim() || null,
        posted_at: (dto.status ?? 'posted') === 'rejected' ? null : new Date(),
      },
    });
    await this.recomputeOutcome(submissionId);
    return video;
  }

  async updateVideo(companyId: number, videoId: number, dto: UpdateVideoDto) {
    const existing = await this.prisma.prVideo.findFirst({
      where: { id: videoId, company_id: companyId },
    });
    if (!existing) throw new NotFoundException('Video not found');
    const data: Record<string, unknown> = {};
    if (dto.url !== undefined) data.url = dto.url.trim();
    if (dto.platform !== undefined) data.platform = dto.platform;
    if (dto.notes !== undefined) data.notes = dto.notes?.trim() || null;
    if (dto.status !== undefined) {
      data.status = dto.status;
      // Posted/approved keep a posted_at; a rejected clip clears it.
      if (dto.status === 'rejected') data.posted_at = null;
      else if (!existing.posted_at) data.posted_at = new Date();
    }
    const video = await this.prisma.prVideo.update({
      where: { id: videoId },
      data,
    });
    await this.recomputeOutcome(existing.submission_id);
    return video;
  }

  async deleteVideo(companyId: number, videoId: number) {
    const existing = await this.prisma.prVideo.findFirst({
      where: { id: videoId, company_id: companyId },
      select: { id: true, submission_id: true },
    });
    if (!existing) throw new NotFoundException('Video not found');
    await this.prisma.prVideo.delete({ where: { id: videoId } });
    await this.recomputeOutcome(existing.submission_id);
    return { ok: true };
  }

  /**
   * Send a PR package = a 0-amount commerce order (100% order discount, marked
   * paid) tagged "PR" + the campaign name, shipped to the influencer. Reuses
   * the existing commerce createOrder path (Shopify / Woo).
   */
  async sendPackage(
    companyId: number,
    id: number,
    dto: SendPackageDto,
    userId: number,
  ) {
    const s = await this.getSubmission(companyId, id);
    if (s.status === 'sent' && s.shopify_order_gid) {
      throw new BadRequestException('A package was already sent for this submission');
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { default_country_code: true },
    });
    const countryCode =
      dto.countryCode || (company?.default_country_code ? 'PK' : 'PK');

    const provider = await this.commerce.forStore(companyId, dto.storeId);
    const order = await provider.createOrder(
      companyId,
      {
        lineItems: dto.lineItems.map((li) => ({
          variantId: li.variantId,
          quantity: li.quantity,
        })),
        customerName: s.influencer_name,
        phone: s.phone ?? undefined,
        email: s.email ?? undefined,
        address1: s.address ?? undefined,
        city: s.city ?? undefined,
        countryCode,
        prepaid: true, // a 0-total COD order is odd → mark it paid
        orderDiscount: { type: 'percentage', value: 100 },
        tags: ['PR', s.campaign.name].filter(Boolean),
        note: `PR package — ${s.campaign.name}`,
        source: 'inbox',
        storeId: dto.storeId,
      },
      userId,
    );

    // Ensure a linked influencer profile + bump its package rollups.
    const influencerId =
      s.influencer_id ??
      (await this.upsertInfluencer(companyId, s, { bumpPackage: true }));
    if (s.influencer_id) {
      // Already linked → just bump the rollup.
      await this.prisma.prInfluencer
        .update({
          where: { id: s.influencer_id },
          data: { packages_count: { increment: 1 }, last_package_at: new Date() },
        })
        .catch(() => undefined);
    }

    const updated = await this.prisma.prSubmission.update({
      where: { id },
      data: {
        status: 'sent',
        shopify_order_gid: order.orderId,
        order_name: order.orderName,
        decided_by_user_id: userId,
        decided_at: new Date(),
        outcome: 'pending',
        ...(influencerId && !s.influencer_id ? { influencer_id: influencerId } : {}),
      },
    });
    return { submission: updated, order };
  }
}
