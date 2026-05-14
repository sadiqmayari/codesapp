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
var SuperAdminBootstrap_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SuperAdminBootstrap = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const bcrypt = require("bcryptjs");
const prisma_service_1 = require("../../prisma/prisma.service");
let SuperAdminBootstrap = SuperAdminBootstrap_1 = class SuperAdminBootstrap {
    constructor(prisma, config) {
        this.prisma = prisma;
        this.config = config;
        this.logger = new common_1.Logger(SuperAdminBootstrap_1.name);
    }
    async onModuleInit() {
        const email = this.config.get('SUPER_ADMIN_EMAIL');
        const password = this.config.get('SUPER_ADMIN_PASSWORD');
        if (!email || !password) {
            this.logger.warn('SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD not set — skipping bootstrap');
            return;
        }
        try {
            const existing = await this.prisma.user.findUnique({ where: { email } });
            if (existing) {
                this.logger.log(`Super admin already exists: ${email}`);
                return;
            }
            const hash = await bcrypt.hash(password, 12);
            await this.prisma.user.create({
                data: {
                    company_id: null,
                    name: 'Super Admin',
                    email,
                    password_hash: hash,
                    role: 'super_admin',
                    status: 'active',
                },
            });
            this.logger.log(`Super admin bootstrapped: ${email}`);
        }
        catch (err) {
            this.logger.error(`Super admin bootstrap skipped — DB unreachable or table missing: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
};
exports.SuperAdminBootstrap = SuperAdminBootstrap;
exports.SuperAdminBootstrap = SuperAdminBootstrap = SuperAdminBootstrap_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        config_1.ConfigService])
], SuperAdminBootstrap);
//# sourceMappingURL=super-admin.bootstrap.js.map