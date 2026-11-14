import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlatformRegistry } from '../platforms/platform-registry';
import { ATTRIBUTION_WINDOWS, BID_STRATEGIES, CreateDraft, CreatedIds, OPTIMIZATION_GOALS } from '../platforms/ad-writer.types';
import { AdAccountsService } from './ad-accounts.service';
import { AdSyncService } from './ad-sync.service';
import { GrowthVersionService } from './growth-version.service';
import { GrowthQueryService } from './growth-query.service';
import { GrowthMirrorService } from '../store/growth-mirror.service';
import { addDays, n } from '../growth.util';

type Actor = { companyId: number; userId: number | null };
export type UploadedMedia = { buffer: Buffer; mimetype: string; originalname: string; size: number };

const MAX_IMAGE = 30 * 1024 * 1024;
const MAX_VIDEO = 200 * 1024 * 1024;

/**
 * Builds a whole Meta campaign (campaign → ad set → creative → ad) from the
 * Create wizard. EVERYTHING is created PAUSED; on a mid-chain failure the
 * campaign already created is paused and the partial ids are logged.
 */
@Injectable()
export class AdCreateService {
  private readonly logger = new Logger(AdCreateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PlatformRegistry,
    private readonly accounts: AdAccountsService,
    private readonly sync: AdSyncService,
    private readonly version: GrowthVersionService,
    private readonly query: GrowthQueryService,
    private readonly mirror: GrowthMirrorService,
  ) {}

  private async account(companyId: number, accountId: number) {
    const acc = await this.prisma.adAccount.findFirst({ where: { id: accountId, company_id: companyId, status: 'active' } });
    if (!acc) throw new NotFoundException('Ad account not found');
    if (!this.registry.canManage(acc.platform)) this.registry.writer(acc.platform); // throws the 501 message
    const token = await this.accounts.resolveToken(acc);
    if (!token) throw new BadRequestException('No token for this ad account. Reconnect it in Connections.');
    return { acc, token };
  }

  /** Everything the builder needs in one call: assets, numbers, benchmarks, risky cities. */
  async assets(companyId: number, accountId: number) {
    const { acc, token } = await this.account(companyId, accountId);
    const writer = this.registry.writer(acc.platform);
    const [assets, numbers, bench, cities] = await Promise.all([
      writer.listAssets(token, acc.external_id),
      this.prisma.whatsAppNumber.findMany({
        where: { company_id: companyId, status: 'active' },
        select: { id: true, display_phone_number: true, label: true, is_primary: true },
        orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
      }),
      this.benchmarks(companyId, acc.id),
      this.highRtoCities(companyId),
    ]);
    // Resolve the risky cities to Meta location keys (best-effort, top 5).
    const resolved: Array<{ key: string; name: string; rate: number; lostMonthly: number }> = [];
    for (const c of cities.slice(0, 5)) {
      try {
        const hit = (await writer.searchCities(token, c.city, 'PK'))[0];
        if (hit) resolved.push({ key: hit.key, name: hit.name, rate: c.rate, lostMonthly: c.lostMonthly });
      } catch {
        /* skip */
      }
    }
    return {
      account: { id: acc.id, name: acc.name, currency: acc.currency, platform: acc.platform },
      ...assets,
      whatsappNumbers: numbers.map((w) => ({ id: w.id, number: w.display_phone_number, label: w.label, primary: w.is_primary })),
      benchmarks: bench,
      riskyCities: resolved,
    };
  }

  /**
   * Last-30-day account benchmarks (platform CPA / ROAS / cost per conversation)
   * + the store's break-even translated to Meta's placed-order terms.
   */
  async benchmarks(companyId: number, accountId: number) {
    const to = new Date().toISOString().slice(0, 10);
    const from = addDays(to, -30);
    const [r] = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT SUM(spend_base) s, SUM(spend) sl, SUM(purchases) p, SUM(purchase_value_base) v, SUM(messaging_started) m, SUM(link_clicks) lc, COUNT(DISTINCT date) d
         FROM ad_insights_daily WHERE company_id = ? AND account_id = ? AND date >= ?`,
      companyId,
      accountId,
      from,
    );
    const spend = n(r?.s);
    const days = Math.max(1, n(r?.d));
    let breakEven: number | null = null;
    let expRoas: number | null = null;
    let platformRoas = spend > 0 ? n(r?.v) / spend : null;
    let rtoRate: number | null = null;
    try {
      const ov = (await this.query.overview(companyId, { from, to, compare: 'none' })) as unknown as {
        kpis: Record<string, { value: number | null } | undefined>;
      };
      breakEven = ov.kpis.breakEvenRoas?.value ?? null;
      expRoas = ov.kpis.expRoas?.value ?? null;
      platformRoas = ov.kpis.platformRoas?.value ?? platformRoas;
      rtoRate = ov.kpis.rtoRate?.value ?? null;
    } catch {
      /* no facts yet */
    }
    // Meta counts placed-order value; we know what is actually delivered. factor = Meta ROAS / expected ROAS.
    const placedFactor = platformRoas && expRoas ? platformRoas / expRoas : null;
    return {
      days,
      dailySpend: spend / days,
      platformCpa: n(r?.p) > 0 ? spend / n(r?.p) : null,
      costPerConversation: n(r?.m) > 0 ? spend / n(r?.m) : null,
      costPerLinkClick: n(r?.lc) > 0 ? spend / n(r?.lc) : null,
      purchasesPerDay: n(r?.p) / days,
      platformRoas,
      expRoas,
      breakEvenRoas: breakEven,
      placedFactor,
      breakEvenMetaRoas: breakEven && placedFactor ? breakEven * placedFactor : null,
      rtoRate,
    };
  }

  /** Cities whose RTO rate is ≥ 15 pts above the store's, last 90 days, ≥ 15 resolved orders. */
  async highRtoCities(companyId: number) {
    const to = new Date().toISOString().slice(0, 10);
    const rows = await this.mirror.query(
      companyId,
      `SELECT city, COUNT(*) o, SUM(lifecycle = 'rto') r, SUM(lifecycle = 'delivered') d, SUM(net) v
         FROM {facts} WHERE company_id = :co AND order_date >= :from AND order_date <= :to AND city IS NOT NULL
        GROUP BY city`,
      { co: ['Int32', companyId], from: ['Date', addDays(to, -90)], to: ['Date', to] },
    );
    let D = 0;
    let R = 0;
    for (const x of rows) {
      D += n(x.d);
      R += n(x.r);
    }
    const base = D + R ? R / (D + R) : 0;
    return rows
      .filter((x) => n(x.d) + n(x.r) >= 15 && n(x.r) / (n(x.d) + n(x.r)) >= base + 0.15)
      .map((x) => ({ city: String(x.city), rate: n(x.r) / (n(x.d) + n(x.r)), lostMonthly: (n(x.v) * (n(x.r) / Math.max(1, n(x.o)))) / 3 }))
      .sort((a, b) => b.lostMonthly - a.lostMonthly);
  }

  async searchCities(companyId: number, accountId: number, q: string, country: string) {
    const { acc, token } = await this.account(companyId, accountId);
    if (!q || q.trim().length < 2) return [];
    return this.registry.writer(acc.platform).searchCities(token, q.trim(), (country || 'PK').slice(0, 2).toUpperCase());
  }

  async uploadMedia(companyId: number, accountId: number, file: UploadedMedia | undefined) {
    if (!file) throw new BadRequestException('Choose an image or video.');
    const { acc, token } = await this.account(companyId, accountId);
    const w = this.registry.writer(acc.platform);
    if (/^image\/(jpe?g|png)$/.test(file.mimetype)) {
      if (file.size > MAX_IMAGE) throw new BadRequestException('Images up to 30 MB.');
      return { kind: 'image', imageHash: await w.uploadImage(token, acc.external_id, file.buffer, file.originalname) };
    }
    if (/^video\/(mp4|quicktime)$/.test(file.mimetype)) {
      if (file.size > MAX_VIDEO) throw new BadRequestException('Videos up to 200 MB.');
      return { kind: 'video', videoId: await w.uploadVideo(token, acc.external_id, file.buffer, file.originalname) };
    }
    throw new BadRequestException('Use a JPG/PNG image or an MP4/MOV video.');
  }

  // ── drafts (one autosaved draft per user) ─────────────────────────────────
  async getDraft(actor: Actor) {
    if (!actor.userId) return null;
    const d = await this.prisma.adDraft.findUnique({ where: { company_id_user_id: { company_id: actor.companyId, user_id: actor.userId } } });
    return d ? { payload: d.payload, updatedAt: d.updated_at } : null;
  }

  async saveDraft(actor: Actor, payload: unknown) {
    if (!actor.userId) return { ok: false };
    const json = JSON.stringify(payload ?? {});
    if (json.length > 200_000) throw new BadRequestException('Draft too large.');
    if (payload == null) {
      await this.prisma.adDraft.deleteMany({ where: { company_id: actor.companyId, user_id: actor.userId } });
      return { ok: true };
    }
    await this.prisma.adDraft.upsert({
      where: { company_id_user_id: { company_id: actor.companyId, user_id: actor.userId } },
      create: { company_id: actor.companyId, user_id: actor.userId, payload: payload as Prisma.InputJsonValue },
      update: { payload: payload as Prisma.InputJsonValue },
    });
    return { ok: true };
  }

  // ── create ────────────────────────────────────────────────────────────────
  /** Mirror Meta's rules up front so the user sees one clear message, not a Graph error. */
  validate(d: CreateDraft): string[] {
    const errs: string[] = [];
    if (!d.name?.trim()) errs.push('Name the campaign.');
    if (!(d.budget > 0)) errs.push('Enter a budget.');
    if (d.budgetType === 'lifetime' && !d.endTime) errs.push('A lifetime budget needs an end date.');
    if (d.endTime && d.startTime && new Date(d.endTime) <= new Date(d.startTime)) errs.push('The end date must be after the start.');
    if (!BID_STRATEGIES.includes(d.bidStrategy)) errs.push('Pick a bid strategy.');
    if (!OPTIMIZATION_GOALS.includes(d.optimizationGoal)) errs.push('Pick a performance goal.');
    if (!ATTRIBUTION_WINDOWS.includes(d.attributionWindow)) errs.push('Pick an attribution setting.');
    if (d.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS') {
      if (d.optimizationGoal !== 'VALUE') errs.push('A ROAS goal needs “Maximise value of conversions”.');
      if (!(Number(d.roasFloor) > 0)) errs.push('Enter the ROAS goal.');
    }
    if ((d.bidStrategy === 'COST_CAP' || d.bidStrategy === 'LOWEST_COST_WITH_BID_CAP') && !(Number(d.bidAmount) > 0)) errs.push('Enter the cost goal / bid cap.');
    if (d.conversionLocation === 'whatsapp') {
      if (!d.whatsappNumber) errs.push('Choose the WhatsApp number.');
      if (d.optimizationGoal !== 'CONVERSATIONS') errs.push('WhatsApp campaigns optimise for conversations.');
    } else {
      if (!d.url?.trim()) errs.push('Add the website URL.');
      if ((d.optimizationGoal === 'OFFSITE_CONVERSIONS' || d.optimizationGoal === 'VALUE') && !d.pixelId) errs.push('Choose the pixel.');
    }
    if (!d.pageId) errs.push('Choose the Facebook Page.');
    if (!d.imageHash && !d.videoId) errs.push('Add an image or video.');
    if (!d.primaryText?.trim()) errs.push('Write the primary text.');
    if (d.ageMin < 18 || d.ageMax > 65 || d.ageMin > d.ageMax) errs.push('Age must be between 18 and 65.');
    return errs;
  }

  async create(actor: Actor, accountId: number, d: CreateDraft) {
    const errs = this.validate(d);
    if (errs.length) throw new BadRequestException(errs.join(' '));
    const { acc, token } = await this.account(actor.companyId, accountId);
    const writer = this.registry.writer(acc.platform);
    const userName = actor.userId ? (await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }))?.name ?? null : null;
    const log = await this.prisma.adChangeLog.create({
      data: {
        company_id: actor.companyId, account_id: acc.id, user_id: actor.userId, user_name: userName, platform: acc.platform,
        level: 'campaign', entity_id: 'new', entity_name: d.name.slice(0, 255), action: 'create',
        before: Prisma.JsonNull, after: { draft: d as unknown as Prisma.InputJsonValue }, batch_id: randomUUID(),
      },
    });
    let ids: CreatedIds = {};
    try {
      await writer.createAll(token, acc.external_id, d, acc.currency, (x) => {
        ids = x;
      });
      await this.prisma.adChangeLog.update({
        where: { id: log.id },
        data: { result: 'ok', entity_id: ids.campaignId ?? 'new', after: { ...ids, paused: true } as Prisma.InputJsonValue },
      });
      void this.sync.refreshEntities(acc.id);
      this.version.bump(actor.companyId, 'spend');
      return { ok: true, ...ids, logId: log.id };
    } catch (err) {
      const msg = (err as Error)?.message ?? 'Creating the campaign failed.';
      if (ids.campaignId) {
        await writer.update(token, 'campaign', ids.campaignId, { status: 'PAUSED' }, acc.currency).catch(() => undefined);
      }
      await this.prisma.adChangeLog.update({
        where: { id: log.id },
        data: { result: 'failed', error: msg.slice(0, 1000), entity_id: ids.campaignId ?? 'new', after: { ...ids, paused: true } as Prisma.InputJsonValue },
      });
      if (ids.campaignId) void this.sync.refreshEntities(acc.id);
      throw new BadRequestException(
        ids.campaignId ? `${msg} — the part already created (campaign ${ids.campaignId}) is paused.` : msg,
      );
    }
  }
}
