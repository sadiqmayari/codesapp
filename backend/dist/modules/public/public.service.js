"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PublicService = exports.PUBLIC_PRICING_CACHE_KEY = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("../../common/services/cache.service");
const decimal_1 = require("../../common/utils/decimal");
exports.PUBLIC_PRICING_CACHE_KEY = 'public:pricing';
const CACHE_TTL_SEC = 300;
let PublicService = class PublicService {
    constructor(prisma, cache) {
        this.prisma = prisma;
        this.cache = cache;
    }
    async getPricing() {
        const cached = this.cache.get(exports.PUBLIC_PRICING_CACHE_KEY);
        if (cached)
            return cached;
        const plans = await this.prisma.subscription.findMany({
            where: { is_public: true },
            orderBy: [{ display_order: 'asc' }, { monthly_price: 'asc' }],
        });
        const out = (0, decimal_1.numifyDecimals)(plans.map((p) => ({
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
                ? p.features.filter((f) => typeof f === 'string')
                : [],
        })));
        this.cache.set(exports.PUBLIC_PRICING_CACHE_KEY, out, CACHE_TTL_SEC);
        return out;
    }
};
exports.PublicService = PublicService;
exports.PublicService = PublicService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        cache_service_1.CacheService])
], PublicService);
//# sourceMappingURL=public.service.js.map