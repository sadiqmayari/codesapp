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
exports.InboxController = void 0;
const common_1 = require("@nestjs/common");
const platform_express_1 = require("@nestjs/platform-express");
const passport_1 = require("@nestjs/passport");
const inbox_service_1 = require("./inbox.service");
const tenant_guard_1 = require("../../common/guards/tenant.guard");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const assign_dto_1 = require("./dto/assign.dto");
const add_label_dto_1 = require("./dto/add-label.dto");
const add_note_dto_1 = require("./dto/add-note.dto");
const send_message_dto_1 = require("./dto/send-message.dto");
const list_conversations_dto_1 = require("./dto/list-conversations.dto");
let InboxController = class InboxController {
    constructor(inboxService) {
        this.inboxService = inboxService;
    }
    list(user, dto) {
        return this.inboxService.listConversations(user.companyId, dto);
    }
    get(user, id) {
        return this.inboxService.getConversation(user.companyId, id);
    }
    assign(user, id, dto) {
        return this.inboxService.assign(user.companyId, id, dto.userId);
    }
    resolve(user, id) {
        return this.inboxService.setStatus(user.companyId, id, 'resolved');
    }
    reopen(user, id) {
        return this.inboxService.setStatus(user.companyId, id, 'open');
    }
    addLabel(user, id, dto) {
        return this.inboxService.addLabel(user.companyId, id, dto.label);
    }
    removeLabel(user, id, label) {
        return this.inboxService.removeLabel(user.companyId, id, label);
    }
    addNote(user, id, dto) {
        return this.inboxService.addNote(user.companyId, id, user.userId, dto.body);
    }
    listNotes(user, id) {
        return this.inboxService.listNotes(user.companyId, id);
    }
    messages(user, id, cursor, limit) {
        const cursorNum = cursor ? Number(cursor) : undefined;
        const limitNum = limit ? Number(limit) : 50;
        return this.inboxService.listMessages(user.companyId, id, cursorNum, limitNum);
    }
    send(user, id, dto) {
        return this.inboxService.sendMessage(user.companyId, id, dto);
    }
    sendMedia(user, id, file, caption, contextMessageId) {
        if (!file)
            throw new common_1.BadRequestException('file is required');
        const ctxId = contextMessageId ? Number(contextMessageId) : undefined;
        return this.inboxService.sendMedia({
            companyId: user.companyId,
            conversationId: id,
            file,
            caption,
            contextMessageId: ctxId !== undefined && Number.isFinite(ctxId) ? ctxId : undefined,
        });
    }
    markRead(user, id) {
        return this.inboxService.markRead(user.companyId, id, user.userId);
    }
};
exports.InboxController = InboxController;
__decorate([
    (0, common_1.Get)('conversations'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, list_conversations_dto_1.ListConversationsDto]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "list", null);
__decorate([
    (0, common_1.Get)('conversations/:id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "get", null);
__decorate([
    (0, common_1.Post)('conversations/:id/assign'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, assign_dto_1.AssignDto]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "assign", null);
__decorate([
    (0, common_1.Post)('conversations/:id/resolve'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "resolve", null);
__decorate([
    (0, common_1.Post)('conversations/:id/reopen'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "reopen", null);
__decorate([
    (0, common_1.Post)('conversations/:id/labels'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, add_label_dto_1.AddLabelDto]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "addLabel", null);
__decorate([
    (0, common_1.Delete)('conversations/:id/labels/:label'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Param)('label')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, String]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "removeLabel", null);
__decorate([
    (0, common_1.Post)('conversations/:id/notes'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, add_note_dto_1.AddNoteDto]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "addNote", null);
__decorate([
    (0, common_1.Get)('conversations/:id/notes'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "listNotes", null);
__decorate([
    (0, common_1.Get)('conversations/:id/messages'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('cursor')),
    __param(3, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, String, String]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "messages", null);
__decorate([
    (0, common_1.Post)('conversations/:id/send'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, send_message_dto_1.SendMessageDto]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "send", null);
__decorate([
    (0, common_1.Post)('conversations/:id/send-media'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file', {
        limits: { fileSize: 25 * 1024 * 1024 },
    })),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.UploadedFile)()),
    __param(3, (0, common_1.Body)('caption')),
    __param(4, (0, common_1.Body)('contextMessageId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, Object, String, String]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "sendMedia", null);
__decorate([
    (0, common_1.Post)('conversations/:id/mark-read'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], InboxController.prototype, "markRead", null);
exports.InboxController = InboxController = __decorate([
    (0, common_1.Controller)('inbox'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [inbox_service_1.InboxService])
], InboxController);
//# sourceMappingURL=inbox.controller.js.map