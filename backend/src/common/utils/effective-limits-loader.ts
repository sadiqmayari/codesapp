import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../services/cache.service';
import { EffectiveLimits, resolveEffectiveLimits } from './effective-limits';

const TTL_SEC = 300;

/**
 * THE single cached reader of a tenant's effective plan limits.
 *
 * Every consumer of `cache.subscriptionKey(companyId)` MUST go through this
 * function. Previously PlanGuard, LimitWarningService and the CSV importer each
 * stored a DIFFERENT shape under that same key (`{contact_limit,…}` vs
 * `{contacts,templates}` vs `{contact_limit}`), so whichever ran first poisoned
 * the others for 5 minutes — e.g. PlanGuard then read `template_limit` as
 * `undefined` and `current >= undefined` is false → template/user caps bypassed.
 *
 * Invalidation is unchanged: `cache.del(cache.subscriptionKey(id))`.
 * Returns null when the company or its subscription doesn't exist.
 */
export async function loadEffectiveLimits(
  prisma: PrismaService,
  cache: CacheService,
  companyId: number,
): Promise<EffectiveLimits | null> {
  const key = cache.subscriptionKey(companyId);
  const cached = cache.get<EffectiveLimits & { __v?: number }>(key);
  // `__v` guards against a value written by an older code path in the same
  // process (rolling restart safety) — treat anything without it as a miss.
  if (cached && cached.__v === 2) return cached;

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      contact_limit_override: true,
      template_limit_override: true,
      user_limit_override: true,
      shopify_store_limit_override: true,
      whatsapp_number_limit_override: true,
      subscription: {
        select: {
          contact_limit: true,
          template_limit: true,
          user_limit: true,
          shopify_store_limit: true,
          whatsapp_number_limit: true,
        },
      },
    },
  });
  if (!company?.subscription) return null;

  const limits = resolveEffectiveLimits(company.subscription, company);
  cache.set(key, { ...limits, __v: 2 }, TTL_SEC);
  return limits;
}
