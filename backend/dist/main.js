"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const cookieParser = require("cookie-parser");
const app_module_1 = require("./app.module");
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
async function bootstrap() {
    logEnvStatus();
    const app = await core_1.NestFactory.create(app_module_1.AppModule, {
        rawBody: true,
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