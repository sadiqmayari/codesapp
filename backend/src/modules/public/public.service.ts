import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { numifyDecimals } from '../../common/utils/decimal';

/** Single cache key for the public pricing catalog (no tenant scope). */
export const PUBLIC_PRICING_CACHE_KEY = 'public:pricing';
const CACHE_TTL_SEC = 300; // 5m — hit by every anonymous landing visitor

export interface PublicPlan {
  id: number;
  plan_name: string;
  tagline: string | null;
  currency: string;
  billing_period: string;
  monthly_price: number;
  setup_fee: number;
  is_highlighted: boolean;
  cta_label: string | null;
  features: string[];
}

/**
 * Public (UNAUTHENTICATED) read model for the landing-page pricing section.
 * Reads straight from `subscriptions` so the advertised price/limits can never
 * drift from what is actually billed. Only `is_public` plans are exposed.
 */
@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getPricing(): Promise<PublicPlan[]> {
    const cached = this.cache.get<PublicPlan[]>(PUBLIC_PRICING_CACHE_KEY);
    if (cached) return cached;

    const plans = await this.prisma.subscription.findMany({
      where: { is_public: true },
      orderBy: [{ display_order: 'asc' }, { monthly_price: 'asc' }],
    });

    const out = numifyDecimals(
      plans.map((p) => ({
        id: p.id,
        plan_name: p.plan_name,
        tagline: p.tagline,
        currency: p.currency,
        billing_period: p.billing_period,
        monthly_price: p.monthly_price,
        setup_fee: p.setup_fee,
        is_highlighted: p.is_highlighted,
        cta_label: p.cta_label,
        features: Array.isArray(p.features)
          ? (p.features as unknown[]).filter(
              (f): f is string => typeof f === 'string',
            )
          : [],
      })),
    ) as unknown as PublicPlan[];

    this.cache.set(PUBLIC_PRICING_CACHE_KEY, out, CACHE_TTL_SEC);
    return out;
  }
}
