import { ConfigService } from '@nestjs/config';
export declare class EncryptionService {
    private readonly config;
    private readonly key;
    constructor(config: ConfigService);
    encrypt(text: string): string;
    decrypt(encryptedBase64: string): string;
}
