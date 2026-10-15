import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PublicPrSubmitDto } from './dto/public-pr.dto';

/**
 * Public (no-auth) resolver for the influencer submission form. The campaign
 * is resolved by its unguessable token only. Any miss → identical 404 (no
 * existence leak). Returns a sanitized DTO; accepts a submission scoped to the
 * campaign's company.
 */
@Injectable()
export class PublicPrService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveActive(token: string) {
    const campaign = await this.prisma.prCampaign.findFirst({
      where: { public_token: token, active: true },
      include: {
        company: { select: { company_name: true, logo_url: true } },
      },
    });
    if (!campaign) throw new NotFoundException('Not found');
    return campaign;
  }

  async getForm(token: string) {
    const c = await this.resolveActive(token);
    return {
      campaignName: c.name,
      intro: c.intro,
      companyName: c.company.company_name,
      logoUrl: c.company.logo_url,
    };
  }

  async submit(token: string, dto: PublicPrSubmitDto) {
    const c = await this.resolveActive(token);
    await this.prisma.prSubmission.create({
      data: {
        company_id: c.company_id,
        campaign_id: c.id,
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
}
