import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../services/cache.service';
import { PLAN_LIMIT_KEY } from '../decorators/plan-limit.decorator';

type LimitField = 'contacts' | 'templates' | 'users';

interface SubscriptionData {
  contact_limit: number;
  template_limit: number;
  user_limit: number;
}

@Injectable()
export class PlanGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const limitField = this.reflector.get<LimitField>(
      PLAN_LIMIT_KEY,
      context.getHandler(),
    );
    if (!limitField) return true;

    const req = context.switchToHttp().getRequest();
    const companyId: number = req.companyId;
    if (!companyId) return true;

    const subscription = await this.getSubscription(companyId);
    const usage = await this.getCurrentUsage(companyId);

    const { limit, current } = this.getLimit(limitField, subscription, usage);

    if (current >= limit) {
      throw new ForbiddenException(
        `Plan limit reached: ${limitField} (${current}/${limit})`,
      );
    }

    return true;
  }

  private async getSubscription(companyId: number): Promise<SubscriptionData> {
    const cacheKey = this.cache.subscriptionKey(companyId);
    const cached = this.cache.get<SubscriptionData>(cacheKey);
    if (cached) return cached;

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: {
        subscription: {
          select: {
            contact_limit: true,
            template_limit: true,
            user_limit: true,
          },
        },
      },
    });

    const sub = company!.subscription;
    this.cache.set(cacheKey, sub, 300);
    return sub;
  }

  private async getCurrentUsage(companyId: number) {
    const period = new Date().toISOString().slice(0, 7); // YYYY-MM
    return this.prisma.usageMetering.findUnique({
      where: { company_id_period: { company_id: companyId, period } },
    });
  }

  private getLimit(
    field: LimitField,
    sub: SubscriptionData,
    usage: { contacts_stored: number; templates_used: number } | null,
  ): { limit: number; current: number } {
    switch (field) {
      case 'contacts':
        return {
          limit: sub.contact_limit,
          current: usage?.contacts_stored ?? 0,
        };
      case 'templates':
        return {
          limit: sub.template_limit,
          current: usage?.templates_used ?? 0,
        };
      case 'users':
        return { limit: sub.user_limit, current: 0 };
    }
  }
}
