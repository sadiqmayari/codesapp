import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { MetaClientService } from '../inbox/meta-client.service';
import { Step1MetaAppDto } from './dtos/step-1-meta-app.dto';
import { Step3AccessTokenDto } from './dtos/step-3-access-token.dto';
import { Step4WabaPhoneDto } from './dtos/step-4-waba-phone.dto';
import { Step5TestMessageDto } from './dtos/step-5-test-message.dto';

export interface OnboardingStatus {
  step: 1 | 2 | 3 | 4 | 5;
  completed: boolean;
  metaAppId: string;
  metaAccessTokenEncrypted: string;
  webhookVerifiedAt: string | null;
  testMessageSentAt: string | null;
}

const EMPTY_STATUS: OnboardingStatus = {
  step: 1,
  completed: false,
  metaAppId: '',
  metaAccessTokenEncrypted: '',
  webhookVerifiedAt: null,
  testMessageSentAt: null,
};

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly metaClient: MetaClientService,
  ) {}

  private async load(companyId: number): Promise<OnboardingStatus> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { onboarding_status: true },
    });
    if (!company) throw new NotFoundException('Company not found');
    const raw = (company.onboarding_status ?? {}) as Partial<OnboardingStatus>;
    return { ...EMPTY_STATUS, ...raw };
  }

  private async save(
    companyId: number,
    status: OnboardingStatus,
  ): Promise<OnboardingStatus> {
    await this.prisma.company.update({
      where: { id: companyId },
      data: { onboarding_status: status as unknown as Prisma.InputJsonValue },
    });
    return status;
  }

  private sanitize(status: OnboardingStatus) {
    return {
      step: status.step,
      completed: status.completed,
      metaAppId: status.metaAppId || null,
      metaAccessToken: status.metaAccessTokenEncrypted ? '(set)' : null,
      webhookVerifiedAt: status.webhookVerifiedAt,
      testMessageSentAt: status.testMessageSentAt,
      currentStep: status.completed ? 5 : status.step,
    };
  }

  async getStatus(companyId: number) {
    return this.sanitize(await this.load(companyId));
  }

  async step1(companyId: number, dto: Step1MetaAppDto) {
    const status = await this.load(companyId);
    status.metaAppId = dto.metaAppId;
    status.step = 2;
    return this.sanitize(await this.save(companyId, status));
  }

  async step2(companyId: number) {
    const status = await this.load(companyId);
    status.webhookVerifiedAt = new Date().toISOString();
    status.step = 3;
    return this.sanitize(await this.save(companyId, status));
  }

  async step3(companyId: number, dto: Step3AccessTokenDto) {
    if (this.encryption.isUsingPlaceholderKey()) {
      throw new ServiceUnavailableException(
        'Server encryption key is not configured — refusing to store secrets. ' +
          'Set ENCRYPTION_KEY in the environment and redeploy.',
      );
    }
    const status = await this.load(companyId);
    status.metaAccessTokenEncrypted = this.encryption.encrypt(dto.accessToken);
    status.step = 4;
    return this.sanitize(await this.save(companyId, status));
  }

  async step4(companyId: number, dto: Step4WabaPhoneDto) {
    const status = await this.load(companyId);
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        waba_id: dto.wabaId,
        phone_number_id: dto.phoneNumberId,
      },
    });
    status.step = 5;
    return this.sanitize(await this.save(companyId, status));
  }

  async step5(companyId: number, dto: Step5TestMessageDto) {
    const status = await this.load(companyId);
    if (!status.metaAccessTokenEncrypted) {
      throw new ServiceUnavailableException(
        'Access token not set — complete step 3 first.',
      );
    }
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { phone_number_id: true },
    });
    if (!company?.phone_number_id) {
      throw new ServiceUnavailableException(
        'Phone number not set — complete step 4 first.',
      );
    }

    try {
      await this.metaClient.sendTemplate(
        companyId,
        company.phone_number_id,
        dto.toPhone,
        dto.templateName,
        dto.languageCode,
      );
    } catch (err) {
      // MetaClientService rejects with
      // `Meta API POST <path> failed (4xx): <raw json>`. Surface Meta's
      // own error message/code so the wizard shows the real reason
      // (template not found, wrong language, recipient not allowed,
      // bad WABA/phone id, token scope) instead of a blank 500.
      const raw = err instanceof Error ? err.message : String(err);
      let detail = raw;
      const brace = raw.indexOf('{');
      if (brace !== -1) {
        try {
          const parsed = JSON.parse(raw.slice(brace)) as {
            error?: {
              message?: string;
              code?: number;
              error_data?: { details?: string };
            };
          };
          const e = parsed.error;
          if (e) {
            detail =
              e.error_data?.details ||
              e.message ||
              detail;
            if (e.code) detail += ` (Meta code ${e.code})`;
          }
        } catch {
          /* keep raw */
        }
      }
      throw new BadRequestException(
        `WhatsApp test message failed: ${detail}. Check the template name + language code (must match the approved template exactly) and the WABA ID / Phone Number ID from Meta → WhatsApp → API Setup.`,
      );
    }

    status.testMessageSentAt = new Date().toISOString();
    status.completed = true;
    status.step = 5;
    return this.sanitize(await this.save(companyId, status));
  }

  async reset(companyId: number) {
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        onboarding_status: { ...EMPTY_STATUS } as unknown as Prisma.InputJsonValue,
        waba_id: null,
        phone_number_id: null,
      },
    });
    return this.sanitize({ ...EMPTY_STATUS });
  }
}
