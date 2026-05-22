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
var SuperAdminService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SuperAdminService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const bcrypt = require("bcryptjs");
const prisma_service_1 = require("../../prisma/prisma.service");
const decimal_1 = require("../../common/utils/decimal");
const platform_setting_service_1 = require("../../common/services/platform-setting.service");
let SuperAdminService = SuperAdminService_1 = class SuperAdminService {
    constructor(prisma, jwt, config, platformSetting) {
        this.prisma = prisma;
        this.jwt = jwt;
        this.config = config;
        this.platformSetting = platformSetting;
        this.logger = new common_1.Logger(SuperAdminService_1.name);
    }
    async getSettings() {
        return {
            usageLimitAction: await this.platformSetting.getUsageLimitAction(),
        };
    }
    async updateSettings(usageLimitAction) {
        await this.platformSetting.setUsageLimitAction(usageLimitAction);
        return { usageLimitAction };
    }
    async login(email, password, res) {
        const user = await this.prisma.user.findUnique({ where: { email } });
        if (!user || user.role !== 'super_admin') {
            throw new common_1.UnauthorizedException('Invalid credentials');
        }
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid)
            throw new common_1.UnauthorizedException('Invalid credentials');
        const payload = {
            sub: user.id,
            companyId: null,
            role: 'super_admin',
            email: user.email,
        };
        const accessToken = this.jwt.sign(payload, {
            secret: this.config.get('JWT_SECRET'),
            expiresIn: '2h',
        });
        const refreshToken = this.jwt.sign(payload, {
            secret: this.config.get('JWT_REFRESH_SECRET'),
            expiresIn: '1d',
        });
        res.cookie('sa_refresh_token', refreshToken, {
            httpOnly: true,
            secure: this.config.get('NODE_ENV') === 'production',
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000,
            path: '/',
        });
        return { accessToken };
    }
    async refresh(refreshToken, res) {
        if (!refreshToken)
            throw new common_1.UnauthorizedException('No session');
        let payload;
        try {
            payload = this.jwt.verify(refreshToken, {
                secret: this.config.get('JWT_REFRESH_SECRET'),
            });
        }
        catch {
            throw new common_1.UnauthorizedException('Invalid session');
        }
        const user = await this.prisma.user.findUnique({
            where: { id: payload.sub },
        });
        if (!user || user.role !== 'super_admin') {
            throw new common_1.UnauthorizedException('Invalid session');
        }
        const newPayload = {
            sub: user.id,
            companyId: null,
            role: 'super_admin',
            email: user.email,
        };
        const accessToken = this.jwt.sign(newPayload, {
            secret: this.config.get('JWT_SECRET'),
            expiresIn: '2h',
        });
        const newRefresh = this.jwt.sign(newPayload, {
            secret: this.config.get('JWT_REFRESH_SECRET'),
            expiresIn: '1d',
        });
        res.cookie('sa_refresh_token', newRefresh, {
            httpOnly: true,
            secure: this.config.get('NODE_ENV') === 'production',
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000,
            path: '/',
        });
        return { accessToken };
    }
    logout(res) {
        res.clearCookie('sa_refresh_token', {
            httpOnly: true,
            secure: this.config.get('NODE_ENV') === 'production',
            sameSite: 'lax',
            path: '/',
        });
        return { message: 'Logged out' };
    }
    async getDashboard() {
        const [totalCompanies, totalUsers, pendingCompanies] = await Promise.all([
            this.prisma.company.count(),
            this.prisma.user.count({ where: { role: { not: 'super_admin' } } }),
            this.prisma.company.count({ where: { activation_status: 'pending' } }),
        ]);
        return { totalCompanies, totalUsers, pendingCompanies };
    }
    async getClients(page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [items, total] = await Promise.all([
            this.prisma.company.findMany({
                skip,
                take: limit,
                include: { subscription: true },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.company.count(),
        ]);
        return (0, decimal_1.numifyDecimals)({ items, meta: { page, limit, total } });
    }
    async getClient(id) {
        const company = await this.prisma.company.findUnique({
            where: { id },
            include: {
                subscription: true,
                users: { select: { id: true, name: true, email: true, role: true, status: true } },
            },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        return (0, decimal_1.numifyDecimals)(company);
    }
    async activateClient(id) {
        return this.prisma.$transaction(async (tx) => {
            const existing = await tx.company.findUnique({
                where: { id },
                select: { activated_at: true },
            });
            const company = await tx.company.update({
                where: { id },
                data: {
                    activation_status: 'active',
                    ...(existing?.activated_at ? {} : { activated_at: new Date() }),
                    suspended_at: null,
                },
            });
            await tx.user.updateMany({
                where: { company_id: id, role: 'owner' },
                data: { status: 'active' },
            });
            return company;
        });
    }
    async suspendClient(id) {
        return this.prisma.company.update({
            where: { id },
            data: { activation_status: 'suspended', suspended_at: new Date() },
        });
    }
    async grantGrace(id, until) {
        const company = await this.prisma.company.findUnique({
            where: { id },
            select: { activation_status: true, suspended_at: true },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        const reactivate = until !== null &&
            until > new Date() &&
            company.activation_status === 'suspended' &&
            !!company.suspended_at;
        return this.prisma.company.update({
            where: { id },
            data: {
                grace_until: until,
                ...(reactivate
                    ? { activation_status: 'active', suspended_at: null }
                    : {}),
            },
        });
    }
    async setUsageLimitAction(id, action) {
        return this.prisma.company.update({
            where: { id },
            data: { usage_limit_action: action },
        });
    }
    async deleteClient(id) {
        const company = await this.prisma.company.findUnique({ where: { id } });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        await this.prisma.$transaction([
            this.prisma.message.deleteMany({ where: { company_id: id } }),
            this.prisma.conversation.deleteMany({ where: { company_id: id } }),
            this.prisma.contact.deleteMany({ where: { company_id: id } }),
            this.prisma.template.deleteMany({ where: { company_id: id } }),
            this.prisma.bot.deleteMany({ where: { company_id: id } }),
            this.prisma.broadcast.deleteMany({ where: { company_id: id } }),
            this.prisma.webhookLog.deleteMany({ where: { company_id: id } }),
            this.prisma.webhookEndpoint.deleteMany({ where: { company_id: id } }),
            this.prisma.invoice.deleteMany({ where: { company_id: id } }),
            this.prisma.auditLog.deleteMany({ where: { company_id: id } }),
            this.prisma.usageMetering.deleteMany({ where: { company_id: id } }),
            this.prisma.shopifyIntegration.deleteMany({ where: { company_id: id } }),
            this.prisma.user.deleteMany({ where: { company_id: id } }),
            this.prisma.company.delete({ where: { id } }),
        ]);
        return { message: 'Company deleted' };
    }
    async getPlans() {
        return (0, decimal_1.numifyDecimals)(await this.prisma.subscription.findMany());
    }
    async createPlan(data) {
        return (0, decimal_1.numifyDecimals)(await this.prisma.subscription.create({ data }));
    }
    async updatePlan(id, data) {
        return (0, decimal_1.numifyDecimals)(await this.prisma.subscription.update({ where: { id }, data: data }));
    }
    async getInvoices(page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [items, total] = await Promise.all([
            this.prisma.invoice.findMany({
                skip,
                take: limit,
                include: { company: { select: { company_name: true } } },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.invoice.count(),
        ]);
        return (0, decimal_1.numifyDecimals)({ items, meta: { page, limit, total } });
    }
    async getUsage() {
        const period = new Date().toISOString().slice(0, 7);
        return (0, decimal_1.numifyDecimals)(await this.prisma.usageMetering.findMany({
            where: { period },
            include: {
                company: { select: { company_name: true, subscription: true } },
            },
        }));
    }
    async getAuditLogs(page = 1, limit = 50) {
        const skip = (page - 1) * limit;
        const [items, total] = await Promise.all([
            this.prisma.auditLog.findMany({
                skip,
                take: limit,
                include: { user: { select: { name: true, email: true } } },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.auditLog.count(),
        ]);
        return { items, meta: { page, limit, total } };
    }
    async impersonate(companyId, actingAdminId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            include: { users: { where: { role: 'owner' }, take: 1 } },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        const owner = company.users[0];
        const payload = {
            sub: owner.id,
            companyId,
            role: owner.role,
            email: owner.email,
            impersonated: true,
        };
        await this.prisma.auditLog.create({
            data: {
                user_id: actingAdminId,
                company_id: null,
                action: 'super_admin.impersonate',
                entity: 'company',
                entity_id: companyId,
                metadata: { targetCompanyId: companyId },
            },
        }).catch((err) => this.logger.warn(`impersonate audit log failed (non-fatal): ${err.message}`));
        const token = this.jwt.sign(payload, {
            secret: this.config.get('JWT_SECRET'),
            expiresIn: '1h',
        });
        return { impersonationToken: token };
    }
};
exports.SuperAdminService = SuperAdminService;
exports.SuperAdminService = SuperAdminService = SuperAdminService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        jwt_1.JwtService,
        config_1.ConfigService,
        platform_setting_service_1.PlatformSettingService])
], SuperAdminService);
//# sourceMappingURL=super-admin.service.js.map