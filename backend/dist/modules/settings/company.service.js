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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompanyService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const media_service_1 = require("../../common/services/media.service");
const MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
};
const MAX_BYTES = 2 * 1024 * 1024;
let CompanyService = class CompanyService {
    constructor(prisma, media) {
        this.prisma = prisma;
        this.media = media;
    }
    async uploadLogo(companyId, file) {
        if (!file)
            throw new common_1.BadRequestException('No file uploaded');
        const ext = MIME_EXT[file.mimetype];
        if (!ext) {
            throw new common_1.BadRequestException('Unsupported image type. Use JPEG, PNG, WebP or SVG.');
        }
        if (file.size > MAX_BYTES) {
            throw new common_1.BadRequestException('Logo must be 2MB or smaller');
        }
        const { webPath } = this.media.saveBrandingLogo(file.buffer, ext, companyId);
        await this.prisma.company.update({
            where: { id: companyId },
            data: { logo_url: webPath },
        });
        return { logo_url: webPath };
    }
    async deleteLogo(companyId) {
        await this.prisma.company.update({
            where: { id: companyId },
            data: { logo_url: null },
        });
        this.media.deleteBrandingLogos(companyId);
        return { logo_url: null };
    }
};
exports.CompanyService = CompanyService;
exports.CompanyService = CompanyService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        media_service_1.MediaService])
], CompanyService);
//# sourceMappingURL=company.service.js.map