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
exports.ContactsController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const platform_express_1 = require("@nestjs/platform-express");
const tenant_guard_1 = require("../../common/guards/tenant.guard");
const plan_guard_1 = require("../../common/guards/plan.guard");
const plan_limit_decorator_1 = require("../../common/decorators/plan-limit.decorator");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const contacts_service_1 = require("./contacts.service");
const csv_import_service_1 = require("./csv-import.service");
const create_contact_dto_1 = require("./dto/create-contact.dto");
const update_contact_dto_1 = require("./dto/update-contact.dto");
const list_contacts_dto_1 = require("./dto/list-contacts.dto");
const CSV_MAX_BYTES = 5 * 1024 * 1024;
let ContactsController = class ContactsController {
    constructor(contactsService, csvImport) {
        this.contactsService = contactsService;
        this.csvImport = csvImport;
    }
    list(user, dto) {
        return this.contactsService.list(user.companyId, dto);
    }
    tags(user) {
        return this.contactsService.distinctTags(user.companyId);
    }
    get(user, id) {
        return this.contactsService.get(user.companyId, id);
    }
    create(user, dto) {
        return this.contactsService.create(user.companyId, dto);
    }
    update(user, id, dto) {
        return this.contactsService.update(user.companyId, id, dto);
    }
    remove(user, id) {
        return this.contactsService.softDelete(user.companyId, id);
    }
    async import(user, file) {
        if (!file?.buffer) {
            throw new common_1.BadRequestException('CSV file is required');
        }
        if (file.size > CSV_MAX_BYTES) {
            throw new common_1.BadRequestException('CSV file exceeds 5MB limit');
        }
        return this.csvImport.import(user.companyId, file.buffer);
    }
};
exports.ContactsController = ContactsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, list_contacts_dto_1.ListContactsDto]),
    __metadata("design:returntype", void 0)
], ContactsController.prototype, "list", null);
__decorate([
    (0, common_1.Get)('tags'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ContactsController.prototype, "tags", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], ContactsController.prototype, "get", null);
__decorate([
    (0, common_1.Post)(),
    (0, common_1.UseGuards)(plan_guard_1.PlanGuard),
    (0, plan_limit_decorator_1.PlanLimit)('contacts'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, create_contact_dto_1.CreateContactDto]),
    __metadata("design:returntype", void 0)
], ContactsController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, update_contact_dto_1.UpdateContactDto]),
    __metadata("design:returntype", void 0)
], ContactsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], ContactsController.prototype, "remove", null);
__decorate([
    (0, common_1.Post)('import'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file', { limits: { fileSize: CSV_MAX_BYTES } })),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ContactsController.prototype, "import", null);
exports.ContactsController = ContactsController = __decorate([
    (0, common_1.Controller)('contacts'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [contacts_service_1.ContactsService,
        csv_import_service_1.CsvImportService])
], ContactsController);
//# sourceMappingURL=contacts.controller.js.map