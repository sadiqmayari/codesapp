"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BroadcastsModule = void 0;
const common_1 = require("@nestjs/common");
const auth_module_1 = require("../auth/auth.module");
const inbox_module_1 = require("../inbox/inbox.module");
const contacts_module_1 = require("../contacts/contacts.module");
const broadcasts_controller_1 = require("./broadcasts.controller");
const broadcasts_service_1 = require("./broadcasts.service");
const broadcast_worker_1 = require("./broadcast.worker");
const broadcast_plan_guard_1 = require("./broadcast-plan.guard");
let BroadcastsModule = class BroadcastsModule {
};
exports.BroadcastsModule = BroadcastsModule;
exports.BroadcastsModule = BroadcastsModule = __decorate([
    (0, common_1.Module)({
        imports: [auth_module_1.AuthModule, inbox_module_1.InboxModule, contacts_module_1.ContactsModule],
        controllers: [broadcasts_controller_1.BroadcastsController],
        providers: [broadcasts_service_1.BroadcastsService, broadcast_worker_1.BroadcastWorker, broadcast_plan_guard_1.BroadcastPlanGuard],
        exports: [broadcasts_service_1.BroadcastsService],
    })
], BroadcastsModule);
//# sourceMappingURL=broadcasts.module.js.map