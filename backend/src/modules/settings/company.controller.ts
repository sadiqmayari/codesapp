import {
  Controller,
  Delete,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CompanyService } from './company.service';

/**
 * Shell-Polish-A: company branding logo. Lives under the global /api prefix.
 * Owner/admin only — agents cannot change company branding.
 */
@Controller('settings/company')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  @Post('logo')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 }, // 2MB hard cap
    }),
  )
  uploadLogo(
    @CurrentUser() user: { companyId: number },
    @UploadedFile()
    file?: { buffer: Buffer; mimetype: string; size: number },
  ) {
    return this.companyService.uploadLogo(user.companyId, file);
  }

  @Delete('logo')
  deleteLogo(@CurrentUser() user: { companyId: number }) {
    return this.companyService.deleteLogo(user.companyId);
  }
}
