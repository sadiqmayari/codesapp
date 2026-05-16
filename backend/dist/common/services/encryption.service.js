"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var EncryptionService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EncryptionService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto = require("crypto");
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PLACEHOLDER_KEY = 'INSECURE_PLACEHOLDER_KEY_32CHARS';
let EncryptionService = EncryptionService_1 = class EncryptionService {
    constructor(config) {
        this.config = config;
        this.logger = new common_1.Logger(EncryptionService_1.name);
        const encKey = this.config.get('ENCRYPTION_KEY');
        if (!encKey) {
            this.usingPlaceholder = true;
            this.key = Buffer.from(PLACEHOLDER_KEY, 'utf8');
            this.logger.warn('[encryption] ⚠️  ENCRYPTION_KEY missing — using insecure placeholder, refuse to store new secrets');
            return;
        }
        this.usingPlaceholder = encKey === PLACEHOLDER_KEY;
        if (this.usingPlaceholder) {
            this.logger.warn('[encryption] ⚠️  ENCRYPTION_KEY missing — using insecure placeholder, refuse to store new secrets');
        }
        this.key = Buffer.from(encKey.padEnd(32).slice(0, 32), 'utf8');
    }
    isUsingPlaceholderKey() {
        return this.usingPlaceholder;
    }
    encrypt(text) {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
        const encrypted = Buffer.concat([
            cipher.update(text, 'utf8'),
            cipher.final(),
        ]);
        const authTag = cipher.getAuthTag();
        return Buffer.concat([iv, authTag, encrypted]).toString('base64');
    }
    decrypt(encryptedBase64) {
        const buf = Buffer.from(encryptedBase64, 'base64');
        const iv = buf.subarray(0, IV_LENGTH);
        const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
        const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
        const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
        decipher.setAuthTag(authTag);
        return decipher.update(ciphertext) + decipher.final('utf8');
    }
};
exports.EncryptionService = EncryptionService;
exports.EncryptionService = EncryptionService = EncryptionService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], EncryptionService);
//# sourceMappingURL=encryption.service.js.map