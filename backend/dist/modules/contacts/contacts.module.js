"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContactsModule = void 0;
const common_1 = require("@nestjs/common");
const auth_module_1 = require("../auth/auth.module");
const usage_metering_module_1 = require("../usage-metering/usage-metering.module");
const contacts_controller_1 = require("./contacts.controller");
const contacts_service_1 = require("./contacts.service");
const csv_import_service_1 = require("./csv-import.service");
const segments_controller_1 = require("./segments.controller");
const segments_service_1 = require("./segments.service");
let ContactsModule = class ContactsModule {
};
exports.ContactsModule = ContactsModule;
exports.ContactsModule = ContactsModule = __decorate([
    (0, common_1.Module)({
        imports: [auth_module_1.AuthModule, usage_metering_module_1.UsageMeteringModule],
        controllers: [segments_controller_1.SegmentsController, contacts_controller_1.ContactsController],
        providers: [contacts_service_1.ContactsService, csv_import_service_1.CsvImportService, segments_service_1.SegmentsService],
        exports: [contacts_service_1.ContactsService, segments_service_1.SegmentsService],
    })
], ContactsModule);
//# sourceMappingURL=contacts.module.js.map