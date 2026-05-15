import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';

const ALLOWED_PLANS = new Set(['growth', 'pro', 'enterprise']);

@Injectable()
export class BroadcastPlanGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const companyId: number = req.companyId;
    if (!companyId) throw new ForbiddenException('No company context');

    const cacheKey = `broadcast-plan:${companyId}`;
    const cached = this.cache.get<string>(cacheKey);
    let planName = cached;

    if (!planName) {
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
        include: { subscription: { select: { plan_name: true } } },
      });
      planName = company?.subscription.plan_name.toLowerCase() ?? '';
      this.cache.set(cacheKey, planName, 300);
    }

    if (!ALLOWED_PLANS.has(planName)) {
      throw new ForbiddenException(
        'Broadcasts require Growth, Pro, or Enterprise plan',
      );
    }
    return true;
  }
}
