import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { EncryptionService } from '../../common/services/encryption.service';
import {
  ProfileRow,
  ResolvedProfile,
  resolveProfile,
  StoreOverride,
  withStore,
} from './agent/profile';
import { PACKS } from './agent/packs';

/** A loaded profile plus the company facts every AI path needs. */
export interface AgentProfileBundle {
  profile: ResolvedProfile;
  companyName: string;
  timezone: string | null;
  /** Decrypted structured payment details (bank/wallet) — NEVER from RAG. */
  paymentDetails: string | null;
  /** True when a row exists (false = pure defaults, never saved). */
  saved: boolean;
}

/** Profile cache TTL — short: web saves, the worker reads (separate processes). */
const TTL_SEC = 30;

/**
 * Loads / saves the per-company Agent Profile and per-store overrides. Every
 * AI path (copilot, agent runtime, playground, evals) reads the profile here so
 * language, currency, persona and skills come from ONE place.
 */
@Injectable()
export class AiProfileService {
  private readonly logger = new Logger(AiProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly encryption: EncryptionService,
  ) {}

  private key(companyId: number): string {
    return `ai-profile:${companyId}`;
  }

  invalidate(companyId: number): void {
    this.cache.del(this.key(companyId));
  }

  private decrypt(v: string | null | undefined): string | null {
    if (!v) return null;
    try {
      return this.encryption.decrypt(v) || null;
    } catch {
      return null;
    }
  }

  async load(companyId: number): Promise<AgentProfileBundle> {
    const hit = this.cache.get<AgentProfileBundle>(this.key(companyId));
    if (hit) return hit;
    const [row, company] = await Promise.all([
      this.prisma.aiAgentProfile.findUnique({ where: { company_id: companyId } }),
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          company_name: true,
          timezone: true,
          ai_brand_tone: true,
          default_country_code: true,
        },
      }),
    ]);
    const bundle: AgentProfileBundle = {
      profile: resolveProfile(row as ProfileRow | null, {
        tone: company?.ai_brand_tone,
        countryCode: company?.default_country_code,
      }),
      companyName: company?.company_name ?? '',
      timezone: company?.timezone ?? null,
      paymentDetails: this.decrypt(row?.payment_details_encrypted),
      saved: !!row,
    };
    this.cache.set(this.key(companyId), bundle, TTL_SEC);
    return bundle;
  }

  /**
   * Load the profile as seen by a chat resolved to `storeId` (store overrides
   * layered on top: brand name, voice, currency, country, payment details).
   */
  async loadForStore(
    companyId: number,
    storeId: number | null | undefined,
  ): Promise<AgentProfileBundle & { brandName: string }> {
    const base = await this.load(companyId);
    if (!storeId) return { ...base, brandName: base.companyName };
    const sp = await this.prisma.aiStoreProfile
      .findFirst({ where: { company_id: companyId, store_id: storeId } })
      .catch(() => null);
    if (!sp) {
      const store = await this.prisma.shopifyStore
        .findFirst({ where: { id: storeId, company_id: companyId }, select: { label: true } })
        .catch(() => null);
      return { ...base, brandName: store?.label || base.companyName };
    }
    const override: StoreOverride = {
      brandName: sp.brand_name,
      tone: sp.tone,
      currencyCode: sp.currency_code,
      currencySymbol: sp.currency_symbol,
      countryCode: sp.country_code,
    };
    return {
      ...base,
      profile: withStore(base.profile, override),
      paymentDetails: this.decrypt(sp.payment_details_encrypted) ?? base.paymentDetails,
      brandName: sp.brand_name?.trim() || base.companyName,
    };
  }

  /** Raw editable view for Settings (payment details never leave decrypted
   *  except as a masked flag + the owner's explicit read). */
  async getEditable(companyId: number) {
    const b = await this.load(companyId);
    return {
      ...b.profile,
      paymentDetails: b.paymentDetails ?? '',
      saved: b.saved,
      packs: Object.values(PACKS).map((p) => ({
        key: p.key,
        label: p.label,
        description: p.description,
      })),
    };
  }

  /**
   * Save a (partial) profile. Unknown keys are ignored; everything is
   * re-normalised by resolveProfile on the next read. `paymentDetails`
   * '' clears, undefined keeps.
   */
  async save(
    companyId: number,
    patch: Partial<{
      industry: string;
      agentName: string;
      agentRole: string;
      goals: string;
      doRules: string;
      dontRules: string;
      tone: string;
      countryCode: string;
      currencyCode: string;
      currencySymbol: string;
      languages: string[];
      mirrorLanguage: boolean;
      voiceLanguage: string;
      paymentMethods: string[];
      paymentDetails: string;
      skills: unknown;
      handoff: unknown;
      hours: unknown;
      engine: string;
    }>,
  ): Promise<ResolvedProfile> {
    const data: Prisma.AiAgentProfileUncheckedUpdateInput = {};
    const set = <K extends keyof typeof data>(k: K, v: (typeof data)[K]) => {
      data[k] = v;
    };
    if (patch.industry !== undefined) set('industry', String(patch.industry).slice(0, 32));
    if (patch.agentName !== undefined) set('agent_name', patch.agentName.slice(0, 80) || null);
    if (patch.agentRole !== undefined) set('agent_role', patch.agentRole.slice(0, 120) || null);
    if (patch.goals !== undefined) set('goals', patch.goals.slice(0, 4000) || null);
    if (patch.doRules !== undefined) set('do_rules', patch.doRules.slice(0, 4000) || null);
    if (patch.dontRules !== undefined) set('dont_rules', patch.dontRules.slice(0, 4000) || null);
    if (patch.tone !== undefined) set('tone', patch.tone.slice(0, 2000) || null);
    if (patch.countryCode !== undefined)
      set('country_code', patch.countryCode.toUpperCase().slice(0, 2) || null);
    if (patch.currencyCode !== undefined)
      set('currency_code', patch.currencyCode.toUpperCase().slice(0, 3) || null);
    if (patch.currencySymbol !== undefined)
      set('currency_symbol', patch.currencySymbol.slice(0, 8) || null);
    if (patch.languages !== undefined)
      set('languages', patch.languages.slice(0, 10) as Prisma.InputJsonValue);
    if (patch.mirrorLanguage !== undefined) set('mirror_language', !!patch.mirrorLanguage);
    if (patch.voiceLanguage !== undefined) set('voice_language', patch.voiceLanguage.slice(0, 8));
    if (patch.paymentMethods !== undefined)
      set('payment_methods', patch.paymentMethods.slice(0, 10) as Prisma.InputJsonValue);
    if (patch.paymentDetails !== undefined)
      set(
        'payment_details_encrypted',
        patch.paymentDetails.trim()
          ? this.encryption.encrypt(patch.paymentDetails.trim().slice(0, 2000))
          : null,
      );
    if (patch.skills !== undefined) set('skills', patch.skills as Prisma.InputJsonValue);
    if (patch.handoff !== undefined) set('handoff', patch.handoff as Prisma.InputJsonValue);
    if (patch.hours !== undefined) set('hours', patch.hours as Prisma.InputJsonValue);
    if (patch.engine !== undefined && ['v1', 'shadow', 'v2'].includes(patch.engine))
      set('engine', patch.engine);

    await this.prisma.aiAgentProfile.upsert({
      where: { company_id: companyId },
      create: {
        ...(data as Prisma.AiAgentProfileUncheckedCreateInput),
        company_id: companyId,
      },
      update: data,
    });
    this.invalidate(companyId);
    return (await this.load(companyId)).profile;
  }

  /** Per-store overrides for Settings → AI Agent → Stores. */
  async listStoreProfiles(companyId: number) {
    const [stores, rows] = await Promise.all([
      this.prisma.shopifyStore.findMany({
        where: { company_id: companyId },
        select: { id: true, label: true, provider: true, shop_domain: true, is_primary: true },
        orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.aiStoreProfile.findMany({ where: { company_id: companyId } }),
    ]);
    return stores.map((s) => {
      const r = rows.find((x) => x.store_id === s.id);
      return {
        storeId: s.id,
        label: s.label || s.shop_domain,
        provider: s.provider,
        isPrimary: s.is_primary,
        brandName: r?.brand_name ?? '',
        tone: r?.tone ?? '',
        currencyCode: r?.currency_code ?? '',
        currencySymbol: r?.currency_symbol ?? '',
        countryCode: r?.country_code ?? '',
        paymentDetailsSet: !!r?.payment_details_encrypted,
      };
    });
  }

  async saveStoreProfile(
    companyId: number,
    storeId: number,
    patch: Partial<{
      brandName: string;
      tone: string;
      currencyCode: string;
      currencySymbol: string;
      countryCode: string;
      paymentDetails: string;
    }>,
  ): Promise<void> {
    const store = await this.prisma.shopifyStore.findFirst({
      where: { id: storeId, company_id: companyId },
      select: { id: true },
    });
    if (!store) throw new Error('Store not found');
    const data: Prisma.AiStoreProfileUncheckedUpdateInput = {};
    if (patch.brandName !== undefined) data.brand_name = patch.brandName.slice(0, 120) || null;
    if (patch.tone !== undefined) data.tone = patch.tone.slice(0, 2000) || null;
    if (patch.currencyCode !== undefined)
      data.currency_code = patch.currencyCode.toUpperCase().slice(0, 3) || null;
    if (patch.currencySymbol !== undefined)
      data.currency_symbol = patch.currencySymbol.slice(0, 8) || null;
    if (patch.countryCode !== undefined)
      data.country_code = patch.countryCode.toUpperCase().slice(0, 2) || null;
    if (patch.paymentDetails !== undefined)
      data.payment_details_encrypted = patch.paymentDetails.trim()
        ? this.encryption.encrypt(patch.paymentDetails.trim().slice(0, 2000))
        : null;
    await this.prisma.aiStoreProfile.upsert({
      where: { store_id: storeId },
      create: {
        ...(data as Prisma.AiStoreProfileUncheckedCreateInput),
        company_id: companyId,
        store_id: storeId,
      },
      update: data,
    });
  }
}
