"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStoredUsage = getStoredUsage;
async function getStoredUsage(prisma, companyId) {
    const [contacts, templates, users] = await Promise.all([
        prisma.contact.count({
            where: { company_id: companyId, deleted_at: null },
        }),
        prisma.template.count({
            where: { company_id: companyId, deleted_at: null },
        }),
        prisma.user.count({
            where: { company_id: companyId, status: 'active' },
        }),
    ]);
    return { contacts, templates, users };
}
//# sourceMappingURL=usage-counts.js.map