import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../../common/services/encryption.service';
import { OnboardingService } from './onboarding.service';

function makePrisma() {
  const state: { onboarding_status: Record<string, unknown> } = {
    onboarding_status: {},
  };
  return {
    state,
    company: {
      findUnique: jest.fn().mockImplementation(() =>
        Promise.resolve({
          onboarding_status: state.onboarding_status,
          phone_number_id: 'PNID',
        }),
      ),
      update: jest.fn().mockImplementation(({ data }) => {
        if (data.onboarding_status) {
          state.onboarding_status = data.onboarding_status;
        }
        return Promise.resolve({});
      }),
    },
  };
}

describe('OnboardingService', () => {
  it('step3 throws 503 when ENCRYPTION_KEY is the placeholder', async () => {
    const enc = new EncryptionService({
      get: () => undefined,
    } as unknown as ConfigService);
    expect(enc.isUsingPlaceholderKey()).toBe(true);

    const prisma = makePrisma();
    const svc = new OnboardingService(
      prisma as never,
      enc,
      {} as never,
    );

    await expect(
      svc.step3(1, { accessToken: 'EAAG-real-token-value' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('happy path: step3 stores an encrypted token that round-trips', async () => {
    const enc = new EncryptionService({
      get: () => 'a-real-32-char-encryption-key!!!',
    } as unknown as ConfigService);
    expect(enc.isUsingPlaceholderKey()).toBe(false);

    const prisma = makePrisma();
    const svc = new OnboardingService(prisma as never, enc, {} as never);

    const result = await svc.step3(1, { accessToken: 'EAAG-secret-123' });
    expect(result.metaAccessToken).toBe('(set)');
    expect(result.step).toBe(4);

    const stored = prisma.state.onboarding_status
      .metaAccessTokenEncrypted as string;
    expect(stored).toBeTruthy();
    expect(stored).not.toContain('EAAG-secret-123');
    expect(enc.decrypt(stored)).toBe('EAAG-secret-123');
  });
});
