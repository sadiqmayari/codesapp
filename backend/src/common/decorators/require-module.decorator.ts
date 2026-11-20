import { SetMetadata } from '@nestjs/common';
import type { ModuleKey } from '../features/feature.constants';

export const MODULE_KEY = 'require_module';

/**
 * Super-admin module grant required for this controller/route. Pair with
 * `ModuleGuard` in @UseGuards, AFTER TenantGuard (it needs req.user.companyId).
 * Method-level overrides class-level.
 */
export const RequireModule = (module: ModuleKey) =>
  SetMetadata(MODULE_KEY, module);
