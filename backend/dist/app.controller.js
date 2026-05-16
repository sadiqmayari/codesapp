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
const nodemailer = require("nodemailer");
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
    async mailTest(to) {
        const host = this.config.get('SMTP_HOST') ?? '';
        const port = Number(this.config.get('SMTP_PORT') ?? 587);
        const secureEnv = (this.config.get('SMTP_SECURE') ?? '').toLowerCase();
        const secure = secureEnv === 'true'
            ? true
            : secureEnv === 'false'
                ? false
                : port === 465;
        const user = this.config.get('SMTP_USER') ?? '';
        const from = this.config.get('SMTP_FROM') ?? '';
        const result = {
            config: {
                hostSet: !!host,
                host,
                port,
                secure,
                userSet: !!user,
                user,
                passSet: !!this.config.get('SMTP_PASS'),
                from,
            },
            verifyOk: false,
            verifyError: null,
            sendOk: false,
            sendError: null,
            sentTo: to ?? null,
        };
        const transport = nodemailer.createTransport({
            host,
            port,
            secure,
            auth: {
                user,
                pass: this.config.get('SMTP_PASS'),
            },
            connectionTimeout: 10000,
            greetingTimeout: 10000,
        });
        try {
            await transport.verify();
            result.verifyOk = true;
        }
        catch (e) {
            result.verifyError = `${e?.code ?? ''} ${e?.message ?? String(e)}`.trim();
        }
        if (to) {
            try {
                const info = await transport.sendMail({
                    from,
                    to,
                    subject: 'CodesApp SMTP test',
                    text: 'If you received this, SMTP works.',
                });
                result.sendOk = true;
                result.messageId = info.messageId ?? null;
                result.response = info.response ?? null;
            }
            catch (e) {
                result.sendError = `${e?.code ?? ''} ${e?.message ?? String(e)}`.trim();
            }
        }
        return result;
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
__decorate([
    (0, common_1.Get)('_debug/mail'),
    __param(0, (0, common_1.Query)('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "mailTest", null);
exports.AppController = AppController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        config_1.ConfigService])
], AppController);
//# sourceMappingURL=app.controller.js.map