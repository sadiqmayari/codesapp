import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PrService } from './pr.service';
import { PublicPrSubmitDto } from './dto/public-pr.dto';

type ResolvedCampaign = {
  id: number;
  company_id: number;
  name: string;
  intro: string | null;
  terms: string | null;
  company: { company_name: string; logo_url: string | null };
};

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

  private async resolveByToken(token: string): Promise<ResolvedCampaign> {
    const campaign = await this.prisma.prCampaign.findFirst({
      where: { public_token: token, active: true },
      include: { company: { select: { company_name: true, logo_url: true } } },
    });
    if (!campaign) throw new NotFoundException('Not found');
    return campaign as unknown as ResolvedCampaign;
  }

  private async resolveBySlugs(
    tenantSlug: string,
    campaignSlug: string,
  ): Promise<ResolvedCampaign> {
    const company = await this.prisma.company.findUnique({
      where: { public_slug: tenantSlug.toLowerCase() },
      select: { id: true, company_name: true, logo_url: true },
    });
    if (!company) throw new NotFoundException('Not found');
    const campaign = await this.prisma.prCampaign.findFirst({
      where: { company_id: company.id, slug: campaignSlug.toLowerCase(), active: true },
    });
    if (!campaign) throw new NotFoundException('Not found');
    return {
      ...campaign,
      company: { company_name: company.company_name, logo_url: company.logo_url },
    } as ResolvedCampaign;
  }

  private form(c: ResolvedCampaign) {
    return {
      campaignName: c.name,
      intro: c.intro,
      terms: c.terms,
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

  /** Build the shipping address string for the order from the structured parts. */
  private composeAddress(a: PublicPrSubmitDto['address']): string {
    return [a.name, a.number, a.house, a.street, a.landmark, a.city]
      .map((p) => (p || '').trim())
      .filter(Boolean)
      .join(', ');
  }

  private async record(campaign: ResolvedCampaign, dto: PublicPrSubmitDto) {
    if (!dto.adsConsent || !dto.termsConsent) {
      throw new BadRequestException(
        'You must accept the ads-access and terms to submit.',
      );
    }
    const address = this.composeAddress(dto.address);
    const followerCount =
      dto.followerCount ?? parseFollowers(dto.followersText);

    // Create-or-link the influencer CRM profile first (deduped).
    const influencerId = await this.pr.upsertInfluencer(campaign.company_id, {
      influencer_name: dto.influencerName,
      phone: dto.phone,
      email: dto.email,
      city: dto.address.city,
      address,
      instagram: dto.instagram,
      tiktok: dto.tiktok,
      follower_count: followerCount,
    });

    await this.prisma.prSubmission.create({
      data: {
        company_id: campaign.company_id,
        campaign_id: campaign.id,
        influencer_id: influencerId,
        influencer_name: dto.influencerName.trim(),
        phone: dto.phone.trim(),
        email: dto.email.trim(),
        city: dto.address.city.trim(),
        address: address || null,
        instagram: dto.instagram.trim(),
        tiktok: dto.tiktok?.trim() || null,
        follower_count: followerCount,
        product_wishlist: dto.productPreference?.trim() || null,
        status: 'new',
        form_data: {
          category: dto.category,
          videoTypes: dto.videoTypes,
          about: dto.about,
          whyCollaborate: dto.whyCollaborate,
          contentPlan: dto.contentPlan,
          videosCount: dto.videosCount,
          productPreference: dto.productPreference ?? null,
          followersText: dto.followersText,
          address: { ...dto.address },
          adsConsent: true,
          termsConsent: true,
        } as unknown as Prisma.InputJsonValue,
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

/** "25K" → 25000, "1.2M" → 1200000, "3,500" → 3500; null when unparseable. */
function parseFollowers(text?: string): number | null {
  if (!text) return null;
  const m = text.trim().replace(/,/g, '').match(/^([\d.]+)\s*([kKmM]?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2].toLowerCase() === 'm' ? 1e6 : m[2].toLowerCase() === 'k' ? 1e3 : 1;
  return Math.round(n * mult);
}
