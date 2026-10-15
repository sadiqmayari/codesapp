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
  UpdatePrCampaignDto,
} from './dto/pr.dto';

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
  listCampaigns(companyId: number) {
    return this.prisma.prCampaign.findMany({
      where: { company_id: companyId },
      orderBy: { created_at: 'desc' },
      include: { _count: { select: { submissions: true } } },
    });
  }

  createCampaign(companyId: number, dto: CreatePrCampaignDto) {
    return this.prisma.prCampaign.create({
      data: {
        company_id: companyId,
        name: dto.name.trim(),
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

    const updated = await this.prisma.prSubmission.update({
      where: { id },
      data: {
        status: 'sent',
        shopify_order_gid: order.orderId,
        order_name: order.orderName,
        decided_by_user_id: userId,
        decided_at: new Date(),
      },
    });
    return { submission: updated, order };
  }
}
