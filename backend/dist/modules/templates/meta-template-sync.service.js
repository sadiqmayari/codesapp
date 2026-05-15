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
var MetaTemplateSyncService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetaTemplateSyncService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const https = require("https");
const prisma_service_1 = require("../../prisma/prisma.service");
const meta_client_service_1 = require("../inbox/meta-client.service");
const REQUEST_TIMEOUT_MS = 10_000;
let MetaTemplateSyncService = MetaTemplateSyncService_1 = class MetaTemplateSyncService {
    constructor(config, prisma, metaClient) {
        this.config = config;
        this.prisma = prisma;
        this.metaClient = metaClient;
        this.logger = new common_1.Logger(MetaTemplateSyncService_1.name);
        this.graphVersion = this.config.get('META_GRAPH_VERSION') ?? 'v19.0';
    }
    async syncFromMeta(companyId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { waba_id: true },
        });
        if (!company?.waba_id) {
            throw new Error('WABA ID not configured for this company');
        }
        const token = await this.metaClient.getAccessToken(companyId);
        if (!token)
            throw new Error('Meta access token missing for company');
        const remote = await this.fetchAllTemplates(company.waba_id, token);
        const remoteIds = new Set(remote.map((t) => t.id));
        let synced = 0;
        await this.prisma.$transaction(async (tx) => {
            for (const t of remote) {
                const category = (t.category ?? 'marketing').toLowerCase();
                const status = this.normalizeStatus(t.status);
                const existing = await tx.template.findFirst({
                    where: { company_id: companyId, meta_template_id: t.id },
                });
                const data = {
                    company_id: companyId,
                    meta_template_id: t.id,
                    name: t.name,
                    category: this.normalizeCategory(category),
                    status,
                    content: {
                        language: t.language,
                        components: t.components ?? [],
                    },
                    rejection_reason: t.rejected_reason ?? null,
                };
                if (existing) {
                    await tx.template.update({
                        where: { id: existing.id },
                        data,
                    });
                }
                else {
                    await tx.template.create({ data });
                }
                synced++;
            }
            const localTemplates = await tx.template.findMany({
                where: {
                    company_id: companyId,
                    meta_template_id: { not: null },
                    deleted_at: null,
                },
                select: { id: true, meta_template_id: true },
            });
            const toDelete = localTemplates.filter((t) => t.meta_template_id && !remoteIds.has(t.meta_template_id));
            for (const t of toDelete) {
                await tx.template.update({
                    where: { id: t.id },
                    data: { status: 'rejected', deleted_at: new Date() },
                });
            }
            return toDelete.length;
        });
        return { synced, deleted: 0 };
    }
    async submitToMeta(companyId, wabaId, payload) {
        const token = await this.metaClient.getAccessToken(companyId);
        if (!token)
            return { id: null, error: 'Meta token not configured' };
        try {
            const body = JSON.stringify(payload);
            const res = await this.postJson(`/${this.graphVersion}/${wabaId}/message_templates`, body, token);
            return { id: res.id ?? null };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { id: null, error: msg };
        }
    }
    async fetchAllTemplates(wabaId, token) {
        const all = [];
        let path = `/${this.graphVersion}/${wabaId}/message_templates?limit=100`;
        while (path) {
            const res = await this.getJson(path, token);
            all.push(...(res.data ?? []));
            if (res.paging?.next) {
                const u = new URL(res.paging.next);
                path = `${u.pathname}${u.search}`;
            }
            else {
                path = null;
            }
        }
        return all;
    }
    normalizeStatus(s) {
        const lower = (s ?? '').toLowerCase();
        if (lower === 'approved')
            return 'approved';
        if (lower === 'rejected')
            return 'rejected';
        if (lower === 'paused' || lower === 'disabled')
            return 'paused';
        return 'pending';
    }
    normalizeCategory(c) {
        if (c === 'utility')
            return 'utility';
        if (c === 'authentication')
            return 'authentication';
        return 'marketing';
    }
    getJson(p, token) {
        return this.request('GET', p, token);
    }
    postJson(p, body, token) {
        return this.request('POST', p, token, body, {
            'content-type': 'application/json',
        });
    }
    request(method, p, token, body, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const req = https.request({
                host: 'graph.facebook.com',
                method,
                path: p,
                headers: { authorization: `Bearer ${token}`, ...extraHeaders },
                timeout: REQUEST_TIMEOUT_MS,
            }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(raw));
                        }
                        catch (err) {
                            reject(err);
                        }
                    }
                    else {
                        this.logger.warn(`Meta template ${method} ${p} → ${res.statusCode} ${raw.slice(0, 500)}`);
                        reject(new Error(`Meta template API failed (${res.statusCode}): ${raw.slice(0, 500)}`));
                    }
                });
            });
            req.on('timeout', () => req.destroy(new Error('Timeout')));
            req.on('error', reject);
            if (body)
                req.write(body);
            req.end();
        });
    }
};
exports.MetaTemplateSyncService = MetaTemplateSyncService;
exports.MetaTemplateSyncService = MetaTemplateSyncService = MetaTemplateSyncService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        prisma_service_1.PrismaService,
        meta_client_service_1.MetaClientService])
], MetaTemplateSyncService);
//# sourceMappingURL=meta-template-sync.service.js.map