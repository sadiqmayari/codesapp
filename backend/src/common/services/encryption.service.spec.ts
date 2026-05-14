import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from './encryption.service';

describe('EncryptionService', () => {
  let service: EncryptionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EncryptionService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => 'test-encryption-key-32-chars-long!',
          },
        },
      ],
    }).compile();

    service = module.get<EncryptionService>(EncryptionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should encrypt and decrypt a string (round trip)', () => {
    const plain = 'secret-whatsapp-token-12345';
    const encrypted = service.encrypt(plain);
    expect(encrypted).not.toEqual(plain);
    const decrypted = service.decrypt(encrypted);
    expect(decrypted).toEqual(plain);
  });

  it('should produce different ciphertexts for the same input (random IV)', () => {
    const plain = 'same-input';
    const enc1 = service.encrypt(plain);
    const enc2 = service.encrypt(plain);
    expect(enc1).not.toEqual(enc2);
    expect(service.decrypt(enc1)).toEqual(plain);
    expect(service.decrypt(enc2)).toEqual(plain);
  });

  it('should encrypt empty string', () => {
    const plain = '';
    const encrypted = service.encrypt(plain);
    expect(service.decrypt(encrypted)).toEqual(plain);
  });

  it('should encrypt unicode strings', () => {
    const plain = 'تست رمزنگاری 🔒';
    const encrypted = service.encrypt(plain);
    expect(service.decrypt(encrypted)).toEqual(plain);
  });
});
