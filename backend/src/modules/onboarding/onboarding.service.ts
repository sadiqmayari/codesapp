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
import * as crypto from 'crypto';
import { Step1MetaAppDto } from './dtos/step-1-meta-app.dto';
import { Step2WebhookDto } from './dtos/step-2-webhook.dto';
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

  /**
   * Immutable, company-name-seeded, unique webhook key. Generated once and
   * never recomputed (renaming the company must NOT change the URL or Meta
   * config silently breaks). Format: `<slug>-<4 hex>`.
   */
  private async ensureWebhookConfig(
    companyId: number,
  ): Promise<{ key: string; verifyToken: string }> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        company_name: true,
        webhook_key: true,
        webhook_verify_token: true,
      },
    });
    if (!company) throw new NotFoundException('Company not found');

    let key = company.webhook_key ?? null;
    if (!key) {
      const slug =
        company.company_name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'company';
      key = `${slug}-${crypto.randomBytes(6).toString('hex')}`;
      for (let attempt = 0; attempt < 6; attempt++) {
        const candidate =
          attempt === 0
            ? `${slug}-${crypto.randomBytes(2).toString('hex')}`
            : `${slug}-${crypto.randomBytes(4).toString('hex')}`;
        const clash = await this.prisma.company.findFirst({
          where: { webhook_key: candidate },
          select: { id: true },
        });
        if (!clash) {
          key = candidate;
          break;
        }
      }
    }

    // Auto-generated verify token (one less thing for the client to invent).
    // Generate once if missing; never overwrite an existing one (a live Meta
    // config may already use it — same immutability rule as the key).
    const verifyToken =
      company.webhook_verify_token ??
      `vt_${crypto.randomBytes(16).toString('hex')}`;

    if (!company.webhook_key || !company.webhook_verify_token) {
      await this.prisma.company.update({
        where: { id: companyId },
        data: { webhook_key: key, webhook_verify_token: verifyToken },
      });
    }
    return { key, verifyToken };
  }

  async getStatus(companyId: number) {
    const { key, verifyToken } = await this.ensureWebhookConfig(companyId);
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        webhook_app_secret_encrypted: true,
        waba_id: true,
        phone_number_id: true,
      },
    });
    return {
      ...this.sanitize(await this.load(companyId)),
      webhookKey: key,
      webhookVerifyToken: verifyToken,
      webhookSecretSet: !!company?.webhook_app_secret_encrypted,
      wabaId: company?.waba_id ?? null,
      phoneNumberId: company?.phone_number_id ?? null,
    };
  }

  async step1(companyId: number, dto: Step1MetaAppDto) {
    const status = await this.load(companyId);
    status.metaAppId = dto.metaAppId;
    status.step = 2;
    return this.sanitize(await this.save(companyId, status));
  }

  async step2(companyId: number, dto: Step2WebhookDto) {
    if (this.encryption.isUsingPlaceholderKey()) {
      throw new ServiceUnavailableException(
        'Server encryption key is not configured — refusing to store secrets. ' +
          'Set ENCRYPTION_KEY in the environment and redeploy.',
      );
    }
    // Ensures the unique webhook key + auto-generated verify token exist.
    await this.ensureWebhookConfig(companyId);
    const existing = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { webhook_app_secret_encrypted: true },
    });
    const newSecret = dto.appSecret?.trim();
    if (!newSecret && !existing?.webhook_app_secret_encrypted) {
      throw new BadRequestException(
        'Meta app secret is required (find it in your Meta app → Settings → Basic).',
      );
    }
    if (newSecret && newSecret.length < 10) {
      throw new BadRequestException('Meta app secret looks too short.');
    }
    if (newSecret) {
      await this.prisma.company.update({
        where: { id: companyId },
        data: {
          webhook_app_secret_encrypted: this.encryption.encrypt(newSecret),
        },
      });
    }
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
    const newToken = dto.accessToken?.trim();
    if (!newToken && !status.metaAccessTokenEncrypted) {
      throw new BadRequestException(
        'Access token is required (paste a permanent System User token).',
      );
    }
    if (newToken) {
      if (newToken.length < 10) {
        throw new BadRequestException('Access token looks too short.');
      }
      status.metaAccessTokenEncrypted = this.encryption.encrypt(newToken);
    }
    // else: keep the previously stored encrypted token
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

    const components =
      dto.bodyParams && dto.bodyParams.length
        ? [
            {
              type: 'body',
              parameters: dto.bodyParams.map((text) => ({
                type: 'text',
                text,
              })),
            },
          ]
        : undefined;

    try {
      await this.metaClient.sendTemplate(
        companyId,
        company.phone_number_id,
        dto.toPhone,
        dto.templateName,
        dto.languageCode,
        components,
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

  /**
   * Owner-only escape hatch: mark onboarding complete WITHOUT sending a test
   * message. Justified when the connection is already proven (token + WABA +
   * phone number id validated) but every approved template requires
   * variables, so the parameter-less test send can never succeed. Requires
   * steps 3 + 4 to have been completed.
   */
  async completeWithoutTest(companyId: number) {
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
