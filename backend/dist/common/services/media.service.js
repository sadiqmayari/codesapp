"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var MediaService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediaService = void 0;
const common_1 = require("@nestjs/common");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const uuid_1 = require("uuid");
let MediaService = MediaService_1 = class MediaService {
    constructor() {
        this.logger = new common_1.Logger(MediaService_1.name);
        this.storageRoot = path.join(process.cwd(), '..', 'storage', 'media');
    }
    getCompanyMediaDir(companyId, date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        return path.join(this.storageRoot, String(companyId), String(year), month);
    }
    ensureDir(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
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
            'video/mp4': 'mp4',
            'application/pdf': 'pdf',
        };
        return map[mime] ?? 'bin';
    }
    saveBuffer(buffer, mime, companyId) {
        const dir = this.getCompanyMediaDir(companyId);
        this.ensureDir(dir);
        const filename = `${(0, uuid_1.v4)()}.${this.extFromMime(mime)}`;
        const fullPath = path.join(dir, filename);
        fs.writeFileSync(fullPath, buffer);
        return { path: fullPath, filename };
    }
    downloadFromUrl(url, companyId) {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http;
            protocol.get(url, (res) => {
                const chunks = [];
                const mime = res.headers['content-type'] ?? 'application/octet-stream';
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    try {
                        const result = this.saveBuffer(buffer, mime, companyId);
                        resolve(result);
                    }
                    catch (err) {
                        reject(err);
                    }
                });
                res.on('error', reject);
            });
        });
    }
    saveBrandingLogo(buffer, ext, companyId) {
        const brandingRoot = path.join(this.storageRoot, '..', 'branding', String(companyId));
        this.ensureDir(brandingRoot);
        for (const e of ['jpg', 'jpeg', 'png', 'webp', 'svg']) {
            const prior = path.join(brandingRoot, `logo.${e}`);
            if (e !== ext && fs.existsSync(prior)) {
                try {
                    fs.unlinkSync(prior);
                }
                catch {
                }
            }
        }
        fs.writeFileSync(path.join(brandingRoot, `logo.${ext}`), buffer);
        return { webPath: `/storage/branding/${companyId}/logo.${ext}` };
    }
    deleteBrandingLogos(companyId) {
        const brandingRoot = path.join(this.storageRoot, '..', 'branding', String(companyId));
        for (const e of ['jpg', 'jpeg', 'png', 'webp', 'svg']) {
            const f = path.join(brandingRoot, `logo.${e}`);
            try {
                if (fs.existsSync(f))
                    fs.unlinkSync(f);
            }
            catch (err) {
                this.logger.warn(`Could not delete branding logo ${f}: ${err}`);
            }
        }
    }
    async deleteFile(absolutePath) {
        try {
            await fs.promises.unlink(absolutePath);
        }
        catch (err) {
            this.logger.warn(`Could not delete file ${absolutePath}: ${err}`);
        }
    }
};
exports.MediaService = MediaService;
exports.MediaService = MediaService = MediaService_1 = __decorate([
    (0, common_1.Injectable)()
], MediaService);
//# sourceMappingURL=media.service.js.map