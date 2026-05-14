import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;

    if (!user?.companyId) {
      throw new ForbiddenException('No company context');
    }

    const company = await this.prisma.company.findUnique({
      where: { id: user.companyId },
      select: { activation_status: true },
    });

    if (!company || company.activation_status !== 'active') {
      throw new ForbiddenException('Company account is not active');
    }

    req.companyId = user.companyId;
    return true;
  }
}
