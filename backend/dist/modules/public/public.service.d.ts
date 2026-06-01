import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
export declare const PUBLIC_PRICING_CACHE_KEY = "public:pricing";
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
export declare class PublicService {
    private readonly prisma;
    private readonly cache;
    constructor(prisma: PrismaService, cache: CacheService);
    getPricing(): Promise<PublicPlan[]>;
}
