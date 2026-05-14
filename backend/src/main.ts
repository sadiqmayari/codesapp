import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, ClassSerializerInterceptor, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

// Print env var presence (NEVER values) before NestJS DI runs.
// This lets us diagnose missing env in Hostinger before the app throws.
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
    if (!v) return `${k}=MISSING`;
    return `${k}=set(len=${v.length})`;
  });
  console.log('[env-check]', status.join('  '));
}

async function bootstrap() {
  logEnvStatus();

  const app = await NestFactory.create(AppModule, {
    rawBody: true, // needed for Shopify webhook HMAC verification
  });

  const config = app.get(ConfigService);

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(reflector),
    new ResponseInterceptor(),
  );

  app.enableCors({
    origin: config.get('APP_URL'),
    credentials: true,
  });

  const port = Number(config.get<string>('PORT') ?? process.env.PORT ?? 3001);
  await app.listen(port);

  console.log(`CodesApp backend running on port ${port}`);
}

bootstrap().catch((err) => {
  console.error('[bootstrap] FATAL ERROR:', err);
  process.exit(1);
});
