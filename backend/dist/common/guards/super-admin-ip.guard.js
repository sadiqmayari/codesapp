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
var SuperAdminIpGuard_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SuperAdminIpGuard = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
let SuperAdminIpGuard = SuperAdminIpGuard_1 = class SuperAdminIpGuard {
    constructor(config) {
        this.config = config;
        this.logger = new common_1.Logger(SuperAdminIpGuard_1.name);
    }
    canActivate(context) {
        const nodeEnv = this.config.get('NODE_ENV');
        if (nodeEnv === 'development')
            return true;
        const req = context.switchToHttp().getRequest();
        let ip = req.ip ?? req.connection?.remoteAddress ?? '';
        if (ip.startsWith('::ffff:'))
            ip = ip.slice(7);
        const whitelist = (this.config.get('SUPER_ADMIN_IP_WHITELIST') ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        if (whitelist.includes('*')) {
            this.logger.warn('SUPER_ADMIN_IP_WHITELIST="*" — IP restriction DISABLED (owner opt-out).');
            return true;
        }
        const allowed = whitelist.some((entry) => entry.includes('/') ? this.inCidr(ip, entry) : entry === ip);
        if (!allowed) {
            throw new common_1.ForbiddenException(`Access denied: IP not whitelisted. Detected IP: "${ip}". ` +
                `Add it to SUPER_ADMIN_IP_WHITELIST (exact IP, a CIDR range like ` +
                `${this.suggestCidr(ip)}, or "*" to disable), then restart.`);
        }
        return true;
    }
    inCidr(ip, cidr) {
        const [range, bitsStr] = cidr.split('/');
        const bits = Number(bitsStr);
        const a = this.toLong(ip);
        const b = this.toLong(range);
        if (a === null || b === null || !(bits >= 0 && bits <= 32))
            return false;
        if (bits === 0)
            return true;
        const mask = bits === 32 ? 0xffffffff : ~(0xffffffff >>> bits) >>> 0;
        return (a & mask) === (b & mask);
    }
    toLong(ip) {
        const parts = ip.split('.');
        if (parts.length !== 4)
            return null;
        let out = 0;
        for (const p of parts) {
            const n = Number(p);
            if (!Number.isInteger(n) || n < 0 || n > 255)
                return null;
            out = (out << 8) | n;
        }
        return out >>> 0;
    }
    suggestCidr(ip) {
        const parts = ip.split('.');
        return parts.length === 4
            ? `${parts[0]}.${parts[1]}.0.0/16`
            : 'x.x.0.0/16';
    }
};
exports.SuperAdminIpGuard = SuperAdminIpGuard;
exports.SuperAdminIpGuard = SuperAdminIpGuard = SuperAdminIpGuard_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], SuperAdminIpGuard);
//# sourceMappingURL=super-admin-ip.guard.js.map