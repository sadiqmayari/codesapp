"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.numifyDecimals = numifyDecimals;
const client_1 = require("@prisma/client");
function numifyDecimals(value) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === 'bigint') {
        return Number(value);
    }
    if (value instanceof client_1.Prisma.Decimal) {
        return Number(value);
    }
    if (value instanceof Date)
        return value;
    if (Array.isArray(value)) {
        return value.map((v) => numifyDecimals(v));
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = numifyDecimals(v);
        }
        return out;
    }
    return value;
}
//# sourceMappingURL=decimal.js.map