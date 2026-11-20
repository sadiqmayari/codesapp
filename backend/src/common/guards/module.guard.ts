import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MODULE_KEY } from '../decorators/require-module.decorator';
import { FeatureService } from '../services/feature.service';
import { MODULE_REGISTRY, ModuleKey } from '../features/feature.constants';

/**
 * Enforces a super-admin module grant (see FeatureService.modules). 403 with a
 * stable message the frontend maps to the "not enabled" screen.
 */
@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly feature: FeatureService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<ModuleKey | undefined>(
      MODULE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!key) return true;
    const req = context.switchToHttp().getRequest();
    const companyId = req.user?.companyId;
    if (!companyId) throw new ForbiddenException('No company context');
    if (await this.feature.enabled(companyId, key)) return true;
    const label = MODULE_REGISTRY.find((m) => m.key === key)?.label ?? key;
    throw new ForbiddenException(
      `${label} is not enabled for this workspace. Contact your CodesApp account manager.`,
    );
  }
}
