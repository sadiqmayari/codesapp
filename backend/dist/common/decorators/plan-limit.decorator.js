"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlanLimit = exports.PLAN_LIMIT_KEY = void 0;
const common_1 = require("@nestjs/common");
exports.PLAN_LIMIT_KEY = 'plan_limit';
const PlanLimit = (resource) => (0, common_1.SetMetadata)(exports.PLAN_LIMIT_KEY, resource);
exports.PlanLimit = PlanLimit;
//# sourceMappingURL=plan-limit.decorator.js.map