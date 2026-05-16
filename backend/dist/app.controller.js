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
    async superAdminStatus() {
        const email = this.config.get('SUPER_ADMIN_EMAIL') ?? '';
        const password = this.config.get('SUPER_ADMIN_PASSWORD') ?? '';
        const pwTrimmed = password.trim();
        const surroundingWhitespace = password !== pwTrimmed;
        const quoted = (password.startsWith('"') && password.endsWith('"')) ||
            (password.startsWith("'") && password.endsWith("'"));
        let dbReachable = true;
        let rowExistsForEnvEmail = false;
        let role = null;
        let status = null;
        let passwordMatchesEnv = false;
        let passwordMatchesTrimmed = false;
        let superAdminRowCount = 0;
        let error = null;
        try {
            superAdminRowCount = await this.prisma.user.count({
                where: { role: 'super_admin' },
            });
            if (email) {
                const row = await this.prisma.user.findUnique({ where: { email } });
                if (row) {
                    rowExistsForEnvEmail = true;
                    role = row.role;
                    status = row.status;
                    if (password) {
                        passwordMatchesEnv = await bcrypt.compare(password, row.password_hash);
                        passwordMatchesTrimmed = await bcrypt.compare(pwTrimmed, row.password_hash);
                    }
                }
            }
        }
        catch (e) {
            dbReachable = false;
            error = e instanceof Error ? e.message : String(e);
        }
        return {
            envEmailSet: email.length > 0,
            envEmailLength: email.length,
            emailHasSurroundingWhitespace: email !== email.trim(),
            envPasswordLength: password.length,
            envPasswordTrimmedLength: pwTrimmed.length,
            passwordHasSurroundingWhitespace: surroundingWhitespace,
            passwordLooksQuoted: quoted,
            dbReachable,
            superAdminRowCount,
            rowExistsForEnvEmail,
            role,
            status,
            passwordMatchesEnv,
            passwordMatchesTrimmed,
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