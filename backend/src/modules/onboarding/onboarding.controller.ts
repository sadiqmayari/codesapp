import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OnboardingService } from './onboarding.service';
import { Step1MetaAppDto } from './dtos/step-1-meta-app.dto';
import { Step2WebhookDto } from './dtos/step-2-webhook.dto';
import { Step3AccessTokenDto } from './dtos/step-3-access-token.dto';
import { Step4WabaPhoneDto } from './dtos/step-4-waba-phone.dto';
import { Step5TestMessageDto } from './dtos/step-5-test-message.dto';

@Controller('onboarding')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('status')
  status(@CurrentUser() user: { companyId: number }) {
    return this.onboarding.getStatus(user.companyId);
  }

  @Post('step-1-meta-app')
  step1(
    @CurrentUser() user: { companyId: number },
    @Body() dto: Step1MetaAppDto,
  ) {
    return this.onboarding.step1(user.companyId, dto);
  }

  @Post('step-2-webhook-verify')
  step2(
    @CurrentUser() user: { companyId: number },
    @Body() dto: Step2WebhookDto,
  ) {
    return this.onboarding.step2(user.companyId, dto);
  }

  @Post('step-3-access-token')
  step3(
    @CurrentUser() user: { companyId: number },
    @Body() dto: Step3AccessTokenDto,
  ) {
    return this.onboarding.step3(user.companyId, dto);
  }

  @Post('step-4-waba-phone')
  step4(
    @CurrentUser() user: { companyId: number },
    @Body() dto: Step4WabaPhoneDto,
  ) {
    return this.onboarding.step4(user.companyId, dto);
  }

  @Post('step-5-test-message')
  step5(
    @CurrentUser() user: { companyId: number },
    @Body() dto: Step5TestMessageDto,
  ) {
    return this.onboarding.step5(user.companyId, dto);
  }

  @Post('complete')
  @Roles('owner')
  complete(@CurrentUser() user: { companyId: number }) {
    return this.onboarding.completeWithoutTest(user.companyId);
  }

  @Post('reset')
  @Roles('owner')
  reset(@CurrentUser() user: { companyId: number }) {
    return this.onboarding.reset(user.companyId);
  }
}
