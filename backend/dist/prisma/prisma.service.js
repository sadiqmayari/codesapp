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
var PrismaService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const config_1 = require("@nestjs/config");
let PrismaService = PrismaService_1 = class PrismaService extends client_1.PrismaClient {
    constructor(config) {
        super({
            log: config.get('NODE_ENV') === 'development'
                ? ['warn', 'error']
                : ['error'],
        });
        this.logger = new common_1.Logger(PrismaService_1.name);
        this.isDev = config.get('NODE_ENV') === 'development';
    }
    async onModuleInit() {
        try {
            await this.$connect();
            this.logger.log('Prisma connected to database');
        }
        catch (err) {
            this.logger.error(`Prisma failed to connect — app will start anyway: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (this.isDev) {
            this.$use(async (params, next) => {
                const start = Date.now();
                const result = await next(params);
                const duration = Date.now() - start;
                if (duration > 500) {
                    this.logger.warn(`Slow query [${params.model}.${params.action}] ${duration}ms`);
                }
                return result;
            });
        }
    }
    async onModuleDestroy() {
        await this.$disconnect();
    }
};
exports.PrismaService = PrismaService;
exports.PrismaService = PrismaService = PrismaService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], PrismaService);
//# sourceMappingURL=prisma.service.js.map