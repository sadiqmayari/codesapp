import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PrService } from './pr.service';
import { PublicPrSubmitDto } from './dto/public-pr.dto';

/**
 * Public (no-auth) resolver for the influencer submission form. A campaign is
 * resolved either by its unguessable token (legacy /pr-apply/<token>) or by
 * tenant public_slug + campaign slug (the pr.codentra.pk/<tenant>/<campaign>
 * subdomain). Any miss → identical 404 (no existence leak). Returns a sanitized
 * DTO; accepts a submission scoped to the campaign's company and creates/links
 * an influencer CRM profile.
 */
@Injectable()
export class PublicPrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pr: PrService,
  ) {}

  private async resolveByToken(token: string) {
    const campaign = await this.prisma.prCampaign.findFirst({
      where: { public_token: token, active: true },
      include: { company: { select: { company_name: true, logo_url: true } } },
    });
    if (!campaign) throw new NotFoundException('Not found');
    return campaign;
  }

  private async resolveBySlugs(tenantSlug: string, campaignSlug: string) {
    const company = await this.prisma.company.findUnique({
      where: { public_slug: tenantSlug.toLowerCase() },
      select: { id: true, company_name: true, logo_url: true },
    });
    if (!company) throw new NotFoundException('Not found');
    const campaign = await this.prisma.prCampaign.findFirst({
      where: {
        company_id: company.id,
        slug: campaignSlug.toLowerCase(),
        active: true,
      },
    });
    if (!campaign) throw new NotFoundException('Not found');
    return {
      ...campaign,
      company: { company_name: company.company_name, logo_url: company.logo_url },
    };
  }

  private form(c: {
    name: string;
    intro: string | null;
    company: { company_name: string; logo_url: string | null };
  }) {
    return {
      campaignName: c.name,
      intro: c.intro,
      companyName: c.company.company_name,
      logoUrl: c.company.logo_url,
    };
  }

  getForm(token: string) {
    return this.resolveByToken(token).then((c) => this.form(c));
  }

  getFormBySlugs(tenantSlug: string, campaignSlug: string) {
    return this.resolveBySlugs(tenantSlug, campaignSlug).then((c) => this.form(c));
  }

  private async record(
    campaign: { id: number; company_id: number },
    dto: PublicPrSubmitDto,
  ) {
    // Create-or-link the influencer CRM profile first (deduped).
    const influencerId = await this.pr.upsertInfluencer(campaign.company_id, {
      influencer_name: dto.influencerName,
      phone: dto.phone,
      email: dto.email,
      city: dto.city,
      address: dto.address,
      instagram: dto.instagram,
      tiktok: dto.tiktok,
      follower_count: dto.followerCount ?? null,
    });
    await this.prisma.prSubmission.create({
      data: {
        company_id: campaign.company_id,
        campaign_id: campaign.id,
        influencer_id: influencerId,
        influencer_name: dto.influencerName.trim(),
        phone: dto.phone?.trim() || null,
        email: dto.email?.trim() || null,
        city: dto.city?.trim() || null,
        address: dto.address?.trim() || null,
        instagram: dto.instagram?.trim() || null,
        tiktok: dto.tiktok?.trim() || null,
        follower_count: dto.followerCount ?? null,
        product_wishlist: dto.productWishlist?.trim() || null,
        status: 'new',
      },
    });
    return { ok: true };
  }

  async submit(token: string, dto: PublicPrSubmitDto) {
    return this.record(await this.resolveByToken(token), dto);
  }

  async submitBySlugs(
    tenantSlug: string,
    campaignSlug: string,
    dto: PublicPrSubmitDto,
  ) {
    return this.record(await this.resolveBySlugs(tenantSlug, campaignSlug), dto);
  }
}
