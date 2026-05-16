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
export declare class OnboardingService {
    private readonly prisma;
    private readonly encryption;
    private readonly metaClient;
    constructor(prisma: PrismaService, encryption: EncryptionService, metaClient: MetaClientService);
    private load;
    private save;
    private sanitize;
    getStatus(companyId: number): Promise<{
        step: 1 | 2 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 1 | 2 | 3 | 5 | 4;
    }>;
    step1(companyId: number, dto: Step1MetaAppDto): Promise<{
        step: 1 | 2 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 1 | 2 | 3 | 5 | 4;
    }>;
    step2(companyId: number): Promise<{
        step: 1 | 2 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 1 | 2 | 3 | 5 | 4;
    }>;
    step3(companyId: number, dto: Step3AccessTokenDto): Promise<{
        step: 1 | 2 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 1 | 2 | 3 | 5 | 4;
    }>;
    step4(companyId: number, dto: Step4WabaPhoneDto): Promise<{
        step: 1 | 2 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 1 | 2 | 3 | 5 | 4;
    }>;
    step5(companyId: number, dto: Step5TestMessageDto): Promise<{
        step: 1 | 2 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 1 | 2 | 3 | 5 | 4;
    }>;
    reset(companyId: number): Promise<{
        step: 1 | 2 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 1 | 2 | 3 | 5 | 4;
    }>;
}
