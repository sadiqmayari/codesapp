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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppController = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const bcrypt = require("bcryptjs");
const prisma_service_1 = require("./prisma/prisma.service");
let AppController = class AppController {
    constructor(prisma, config) {
        this.prisma = prisma;
        this.config = config;
    }
    health() {
        return { status: 'ok', timestamp: new Date().toISOString() };
    }
    clientIp(req) {
        return {
            ip: req.ip,
            ips: req.ips,
            xForwardedFor: req.headers['x-forwarded-for'] ?? null,
            remoteAddress: req.socket?.remoteAddress ?? null,
        };
    }
    async superAdminStatus() {
        const email = this.config.get('SUPER_ADMIN_EMAIL') ?? '';
        const password = this.config.get('SUPER_ADMIN_PASSWORD') ?? '';
        const envEmailSet = email.length > 0;
        const envPasswordSet = password.length > 0;
        let rowExistsForEnvEmail = false;
        let role = null;
        let status = null;
        let passwordMatchesEnv = false;
        let superAdminRowCount = 0;
        let dbReachable = true;
        let error = null;
        try {
            superAdminRowCount = await this.prisma.user.count({
                where: { role: 'super_admin' },
            });
            if (envEmailSet) {
                const row = await this.prisma.user.findUnique({
                    where: { email },
                });
                if (row) {
                    rowExistsForEnvEmail = true;
                    role = row.role;
                    status = row.status;
                    if (envPasswordSet) {
                        passwordMatchesEnv = await bcrypt.compare(password, row.password_hash);
                    }
                }
            }
        }
        catch (e) {
            dbReachable = false;
            error = e instanceof Error ? e.message : String(e);
        }
        return {
            envEmailSet,
            envPasswordSet,
            envEmailLength: email.length,
            envPasswordLength: password.length,
            dbReachable,
            superAdminRowCount,
            rowExistsForEnvEmail,
            role,
            status,
            passwordMatchesEnv,
            error,
        };
    }
};
exports.AppController = AppController;
__decorate([
    (0, common_1.Get)('health'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AppController.prototype, "health", null);
__decorate([
    (0, common_1.Get)('_debug/ip'),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AppController.prototype, "clientIp", null);
__decorate([
    (0, common_1.Get)('_debug/superadmin'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AppController.prototype, "superAdminStatus", null);
exports.AppController = AppController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        config_1.ConfigService])
], AppController);
//# sourceMappingURL=app.controller.js.map