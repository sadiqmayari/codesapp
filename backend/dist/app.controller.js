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
const BOOT_ID = Math.random().toString(36).slice(2, 10);
const BOOT_AT = Date.now();
let AppController = class AppController {
    health() {
        const mem = process.memoryUsage();
        const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;
        let activeResources;
        let resourceBreakdown;
        try {
            const info = process.getActiveResourcesInfo?.();
            if (info) {
                activeResources = info.length;
                resourceBreakdown = info.reduce((acc, r) => {
                    acc[r] = (acc[r] ?? 0) + 1;
                    return acc;
                }, {});
            }
            else {
                activeResources = 'unavailable';
            }
        }
        catch {
            activeResources = 'unavailable';
        }
        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            pid: process.pid,
            bootId: BOOT_ID,
            bootAt: new Date(BOOT_AT).toISOString(),
            uptimeSec: Math.round(process.uptime()),
            memoryMb: {
                rss: mb(mem.rss),
                heapUsed: mb(mem.heapUsed),
                heapTotal: mb(mem.heapTotal),
                external: mb(mem.external),
                arrayBuffers: mb(mem.arrayBuffers),
            },
            activeResources,
            ...(resourceBreakdown ? { resourceBreakdown } : {}),
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
exports.AppController = AppController = __decorate([
    (0, common_1.Controller)()
], AppController);
//# sourceMappingURL=app.controller.js.map