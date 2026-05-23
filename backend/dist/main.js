"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const platform_express_1 = require("@nestjs/platform-express");
const config_1 = require("@nestjs/config");
const cookieParser = require("cookie-parser");
const path = require("path");
const fs = require("fs");
const app_module_1 = require("./app.module");
const express = require('express');
const createNextApp = require('next');
const BACKEND_ROOTS = [
    '/api',
    '/health',
    '/webhooks/meta',
    '/webhooks/shopify',
    '/integrations',
    '/cron',
    '/socket.io',
    '/storage',
];
const http_exception_filter_1 = require("./common/filters/http-exception.filter");
const response_interceptor_1 = require("./common/interceptors/response.interceptor");
function logEnvStatus() {
    const required = [
        'NODE_ENV',
        'PORT',
        'APP_URL',
        'DATABASE_URL',
        'JWT_SECRET',
        'JWT_REFRESH_SECRET',
        'ENCRYPTION_KEY',
        'CRON_SECRET',
        'SUPER_ADMIN_EMAIL',
        'SUPER_ADMIN_PASSWORD',
    ];
    const status = required.map((k) => {
        const v = process.env[k];
        if (!v)
            return `${k}=MISSING`;
        return `${k}=set(len=${v.length})`;
    });
    console.log('[env-check]', status.join('  '));
}
process.on('uncaughtException', (err) => {
    console.error('[process] uncaughtException — keeping process alive:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[process] unhandledRejection — keeping process alive:', reason);
});
async function bootstrap() {
    logEnvStatus();
    const frontendDir = path.join(__dirname, 'web');
    let nextHandle = null;
    const diag = {
        frontendDir,
        cwd: process.cwd(),
        dirname: __dirname,
        frontendExists: fs.existsSync(frontendDir),
        nextDirExists: fs.existsSync(path.join(frontendDir, '.next')),
        pkgExists: fs.existsSync(path.join(frontendDir, 'package.json')),
        nodeModulesExists: fs.existsSync(path.join(frontendDir, 'node_modules')),
        reason: '',
    };
    try {
        const nextApp = createNextApp({ dev: false, dir: frontendDir });
        await nextApp.prepare();
        nextHandle = nextApp.getRequestHandler();
        console.log('[next] frontend mounted from', frontendDir);
    }
    catch (err) {
        diag.reason = err?.stack ?? String(err);
        console.error('[next] FAILED to initialize. Diagnostics:', diag);
    }
    const server = express();
    const storageDir = path.join(process.cwd(), '..', 'storage');
    server.use('/storage', express.static(storageDir, {
        index: false,
        fallthrough: false,
        maxAge: '7d',
    }));
    server.use((req, res, next) => {
        const p = req.path || req.url || '/';
        const isBackend = BACKEND_ROOTS.some((r) => p === r || p.startsWith(r + '/'));
        if (isBackend)
            return next();
        if (!nextHandle) {
            res.status(503).type('application/json').send(JSON.stringify({
                error: 'frontend_unavailable',
                note: 'Next.js failed to initialize — API still works under /api',
                diag,
            }, null, 2));
            return;
        }
        return nextHandle(req, res);
    });
    const app = await core_1.NestFactory.create(app_module_1.AppModule, new platform_express_1.ExpressAdapter(server), { rawBody: true });
    app.setGlobalPrefix('api', {
        exclude: [
            { path: 'health', method: common_1.RequestMethod.ALL },
            { path: 'webhooks/meta', method: common_1.RequestMethod.ALL },
            { path: 'webhooks/meta/(.*)', method: common_1.RequestMethod.ALL },
            { path: 'webhooks/shopify', method: common_1.RequestMethod.ALL },
            { path: 'webhooks/shopify/(.*)', method: common_1.RequestMethod.ALL },
            { path: 'integrations/shopify', method: common_1.RequestMethod.ALL },
            { path: 'integrations/shopify/(.*)', method: common_1.RequestMethod.ALL },
            { path: 'cron', method: common_1.RequestMethod.ALL },
            { path: 'cron/(.*)', method: common_1.RequestMethod.ALL },
        ],
    });
    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.set('trust proxy', true);
    const config = app.get(config_1.ConfigService);
    app.use(cookieParser());
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
    }));
    app.useGlobalFilters(new http_exception_filter_1.HttpExceptionFilter());
    const reflector = app.get(core_1.Reflector);
    app.useGlobalInterceptors(new common_1.ClassSerializerInterceptor(reflector), new response_interceptor_1.ResponseInterceptor());
    app.enableCors({
        origin: config.get('APP_URL'),
        credentials: true,
    });
    const port = Number(config.get('PORT') ?? process.env.PORT ?? 3001);
    await app.listen(port);
    console.log(`CodesApp backend running on port ${port}`);
}
bootstrap().catch((err) => {
    console.error('[bootstrap] FATAL ERROR:', err);
    process.exit(1);
});
//# sourceMappingURL=main.js.map