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
var MetaClientService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetaClientService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const fs = require("fs");
const path = require("path");
const https = require("https");
const uuid_1 = require("uuid");
const encryption_service_1 = require("../../common/services/encryption.service");
const prisma_service_1 = require("../../prisma/prisma.service");
const REQUEST_TIMEOUT_MS = 10_000;
let MetaClientService = MetaClientService_1 = class MetaClientService {
    constructor(config, prisma, encryption) {
        this.config = config;
        this.prisma = prisma;
        this.encryption = encryption;
        this.logger = new common_1.Logger(MetaClientService_1.name);
        this.graphHost = 'graph.facebook.com';
        this.graphVersion = this.config.get('META_GRAPH_VERSION') ?? 'v19.0';
    }
    async getAccessToken(companyId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { onboarding_status: true },
        });
        if (!company)
            return null;
        const onboarding = company.onboarding_status;
        const enc = onboarding?.metaAccessTokenEncrypted ?? onboarding?.metaAccessToken;
        if (!enc)
            return null;
        try {
            return this.encryption.decrypt(enc);
        }
        catch {
            this.logger.error(`Failed to decrypt META token for company ${companyId}`);
            return null;
        }
    }
    async assertOnboarded(companyId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { onboarding_status: true },
        });
        const onboarding = (company?.onboarding_status ?? {});
        if (onboarding.completed !== true) {
            throw new common_1.PreconditionFailedException('WhatsApp Cloud API onboarding is not complete for this company. ' +
                'Finish the onboarding wizard before sending messages.');
        }
    }
    async sendMessage(companyId, phoneNumberId, payload) {
        const token = await this.getAccessToken(companyId);
        if (!token) {
            throw new Error(`Meta access token not configured for company ${companyId}`);
        }
        return this.postJson(`/${this.graphVersion}/${phoneNumberId}/messages`, payload, token);
    }
    async sendTemplate(companyId, phoneNumberId, to, templateName, languageCode, components) {
        return this.sendMessage(companyId, phoneNumberId, {
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: {
                name: templateName,
                language: { code: languageCode },
                components,
            },
        });
    }
    async getMedia(companyId, mediaId) {
        const token = await this.getAccessToken(companyId);
        if (!token)
            throw new Error(`Meta access token missing for company ${companyId}`);
        return this.getJson(`/${this.graphVersion}/${mediaId}`, token);
    }
    async downloadMedia(companyId, mediaId, storageRoot, maxBytes) {
        const meta = await this.getMedia(companyId, mediaId);
        const token = await this.getAccessToken(companyId);
        if (!token)
            throw new Error(`Meta access token missing for company ${companyId}`);
        const now = new Date();
        const dir = path.join(storageRoot, String(companyId), String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'));
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const ext = this.extFromMime(meta.mime_type);
        const filename = `${(0, uuid_1.v4)()}.${ext}`;
        const fullPath = path.join(dir, filename);
        const bytes = await this.streamUrlToFile(meta.url, fullPath, token, maxBytes);
        return { path: fullPath, filename, mime: meta.mime_type, bytes };
    }
    extFromMime(mime) {
        const map = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'audio/ogg': 'ogg',
            'audio/mpeg': 'mp3',
            'audio/opus': 'opus',
            'audio/amr': 'amr',
            'video/mp4': 'mp4',
            'video/3gpp': '3gp',
            'application/pdf': 'pdf',
            'text/plain': 'txt',
        };
        return map[mime] ?? 'bin';
    }
    postJson(p, body, token) {
        return this.request('POST', p, token, JSON.stringify(body), {
            'content-type': 'application/json',
        });
    }
    getJson(p, token) {
        return this.request('GET', p, token);
    }
    request(method, p, token, body, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const req = https.request({
                host: this.graphHost,
                method,
                path: p,
                headers: {
                    authorization: `Bearer ${token}`,
                    ...extraHeaders,
                },
                timeout: REQUEST_TIMEOUT_MS,
            }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(raw));
                        }
                        catch (err) {
                            reject(new Error(`Meta API parse error: ${err instanceof Error ? err.message : String(err)}`));
                        }
                    }
                    else {
                        this.logger.warn(`Meta API ${method} ${p} → ${res.statusCode} ${raw.slice(0, 500)}`);
                        reject(new Error(`Meta API ${method} ${p} failed (${res.statusCode}): ${raw.slice(0, 500)}`));
                    }
                });
            });
            req.on('timeout', () => {
                req.destroy(new Error(`Meta API ${method} ${p} timed out`));
            });
            req.on('error', (err) => reject(err));
            if (body)
                req.write(body);
            req.end();
        });
    }
    streamUrlToFile(url, destPath, token, maxBytes) {
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const req = https.get({
                host: u.host,
                path: `${u.pathname}${u.search}`,
                headers: { authorization: `Bearer ${token}` },
                timeout: REQUEST_TIMEOUT_MS,
            }, (res) => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    reject(new Error(`Media download failed: HTTP ${res.statusCode}`));
                    return;
                }
                let written = 0;
                let aborted = false;
                const out = fs.createWriteStream(destPath);
                res.on('data', (chunk) => {
                    if (aborted)
                        return;
                    written += chunk.length;
                    if (written > maxBytes) {
                        aborted = true;
                        res.destroy();
                        out.destroy();
                        fs.unlink(destPath, () => {
                        });
                        reject(new Error(`Media exceeded max size ${maxBytes} bytes (got ${written})`));
                        return;
                    }
                    out.write(chunk);
                });
                res.on('end', () => {
                    if (aborted)
                        return;
                    out.end(() => resolve(written));
                });
                res.on('error', (err) => {
                    if (!aborted) {
                        aborted = true;
                        out.destroy();
                        fs.unlink(destPath, () => {
                        });
                        reject(err);
                    }
                });
            });
            req.on('timeout', () => req.destroy(new Error('Media download timed out')));
            req.on('error', reject);
        });
    }
};
exports.MetaClientService = MetaClientService;
exports.MetaClientService = MetaClientService = MetaClientService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        prisma_service_1.PrismaService,
        encryption_service_1.EncryptionService])
], MetaClientService);
//# sourceMappingURL=meta-client.service.js.map