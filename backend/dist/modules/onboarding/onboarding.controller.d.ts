import { OnboardingService } from './onboarding.service';
import { Step1MetaAppDto } from './dtos/step-1-meta-app.dto';
import { Step2WebhookDto } from './dtos/step-2-webhook.dto';
import { Step3AccessTokenDto } from './dtos/step-3-access-token.dto';
import { Step4WabaPhoneDto } from './dtos/step-4-waba-phone.dto';
import { Step5TestMessageDto } from './dtos/step-5-test-message.dto';
export declare class OnboardingController {
    private readonly onboarding;
    constructor(onboarding: OnboardingService);
    status(user: {
        companyId: number;
    }): Promise<{
        webhookKey: string;
        webhookVerifyToken: string;
        webhookSecretSet: boolean;
        wabaId: string | null;
        phoneNumberId: string | null;
        step: 2 | 1 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 2 | 1 | 3 | 5 | 4;
    }>;
    step1(user: {
        companyId: number;
    }, dto: Step1MetaAppDto): Promise<{
        step: 2 | 1 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 2 | 1 | 3 | 5 | 4;
    }>;
    step2(user: {
        companyId: number;
    }, dto: Step2WebhookDto): Promise<{
        step: 2 | 1 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 2 | 1 | 3 | 5 | 4;
    }>;
    step3(user: {
        companyId: number;
    }, dto: Step3AccessTokenDto): Promise<{
        step: 2 | 1 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 2 | 1 | 3 | 5 | 4;
    }>;
    step4(user: {
        companyId: number;
    }, dto: Step4WabaPhoneDto): Promise<{
        step: 2 | 1 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 2 | 1 | 3 | 5 | 4;
    }>;
    step5(user: {
        companyId: number;
    }, dto: Step5TestMessageDto): Promise<{
        step: 2 | 1 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 2 | 1 | 3 | 5 | 4;
    }>;
    complete(user: {
        companyId: number;
    }): Promise<{
        step: 2 | 1 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 2 | 1 | 3 | 5 | 4;
    }>;
    reset(user: {
        companyId: number;
    }): Promise<{
        step: 2 | 1 | 3 | 5 | 4;
        completed: boolean;
        metaAppId: string | null;
        metaAccessToken: string | null;
        webhookVerifiedAt: string | null;
        testMessageSentAt: string | null;
        currentStep: 2 | 1 | 3 | 5 | 4;
    }>;
}
