import { ConfigService } from '@nestjs/config';
export declare class EncryptionService {
    private readonly config;
    private readonly logger;
    private readonly key;
    private readonly usingPlaceholder;
    constructor(config: ConfigService);
    isUsingPlaceholderKey(): boolean;
    encrypt(text: string): string;
    decrypt(encryptedBase64: string): string;
}
