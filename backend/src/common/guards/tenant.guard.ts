import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { CompanyStatusService } from '../services/company-status.service';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly companyStatus: CompanyStatusService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;

    if (!user?.companyId) {
      throw new ForbiddenException('No company context');
    }

    // Was a raw company.findUnique on EVERY authenticated request — a per-request
    // DB round-trip that added up under multi-agent load. CompanyStatusService
    // caches the active flag (30s TTL, invalidated on suspend/reactivate), so
    // this is now a memory hit on the hot path. Same semantics: only 'active'
    // companies pass.
    if (!(await this.companyStatus.isActive(user.companyId))) {
      throw new ForbiddenException('Company account is not active');
    }

    req.companyId = user.companyId;
    return true;
  }
}
