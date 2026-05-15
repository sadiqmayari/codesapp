"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BotsModule = void 0;
const common_1 = require("@nestjs/common");
const auth_module_1 = require("../auth/auth.module");
const inbox_module_1 = require("../inbox/inbox.module");
const bots_controller_1 = require("./bots.controller");
const bots_service_1 = require("./bots.service");
const bot_engine_service_1 = require("./bot-engine.service");
let BotsModule = class BotsModule {
};
exports.BotsModule = BotsModule;
exports.BotsModule = BotsModule = __decorate([
    (0, common_1.Module)({
        imports: [auth_module_1.AuthModule, (0, common_1.forwardRef)(() => inbox_module_1.InboxModule)],
        controllers: [bots_controller_1.BotsController],
        providers: [bots_service_1.BotsService, bot_engine_service_1.BotEngineService],
        exports: [bot_engine_service_1.BotEngineService, bots_service_1.BotsService],
    })
], BotsModule);
//# sourceMappingURL=bots.module.js.map