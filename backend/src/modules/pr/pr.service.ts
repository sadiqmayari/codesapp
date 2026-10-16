import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureService } from '../../common/services/feature.service';
import { CommerceResolverService } from '../integrations/commerce/commerce-provider.resolver';
import {
  CreatePrCampaignDto,
  DecideSubmissionDto,
  SendPackageDto,
  SetOutcomeDto,
  UpdateInfluencerDto,
  UpdatePrCampaignDto,
} from './dto/pr.dto';
import { influencerKey, slugify } from './pr.util';

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
      include: { campaign: { select: { id: true, name: true } } },
    });
  }

  async getSubmission(companyId: number, id: number) {
    const s = await this.prisma.prSubmission.findFirst({
      where: { id, company_id: companyId },
      include: { campaign: { select: { id: true, name: true } } },
    });
    if (!s) throw new NotFoundException('Submission not found');
    return s;
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
    const q = filter.q?.trim();
    return this.prisma.prInfluencer.findMany({
      where: {
        company_id: companyId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q } },
                { instagram: { contains: q } },
                { phone: { contains: q } },
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
      include: { campaign: { select: { id: true, name: true } } },
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
