import { NestFactory, Reflector } from '@nestjs/core';
import {
  ValidationPipe,
  ClassSerializerInterceptor,
  RequestMethod,
} from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import * as cookieParser from 'cookie-parser';
import * as path from 'path';
import * as fs from 'fs';
import { AppModule } from './app.module';

// CommonJS interop (this tsconfig has no esModuleInterop — match the
// `import * as` pattern used for cookie-parser).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const createNextApp = require('next');

// Backend route roots. Everything NOT under one of these is served by the
// Next.js frontend (same origin, single process — see ARCHITECTURE.md
// "Single-process: Next.js mounted inside NestJS").
const BACKEND_ROOTS = [
  '/api',
  '/health',
  '/webhooks',
  '/integrations',
  '/cron',
  '/socket.io',
  '/storage',
];
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

  // ── Prepare the prebuilt Next.js app ──────────────────────────────
  // Hostinger deploys ONLY the backend dir → the built frontend ships at
  // backend/web (synced via `npm run sync:web`). __dirname = backend/dist
  // → ../web = backend/web. Resilient: if Next can't init, the API /
  // /health / webhooks still come up (degraded mode, diagnostics exposed).
  const frontendDir = path.join(__dirname, '..', 'web');
  let nextHandle:
    | ((req: unknown, res: unknown) => unknown)
    | null = null;
  const diag = {
    frontendDir,
    cwd: process.cwd(),
    dirname: __dirname,
    frontendExists: fs.existsSync(frontendDir),
    nextDirExists: fs.existsSync(path.join(frontendDir, '.next')),
    pkgExists: fs.existsSync(path.join(frontendDir, 'package.json')),
    nodeModulesExists: fs.existsSync(
      path.join(frontendDir, 'node_modules'),
    ),
    reason: '' as string,
  };
  try {
    const nextApp = createNextApp({ dev: false, dir: frontendDir });
    await nextApp.prepare();
    nextHandle = nextApp.getRequestHandler();
    console.log('[next] frontend mounted from', frontendDir);
  } catch (err) {
    diag.reason = (err as Error)?.stack ?? String(err);
    console.error('[next] FAILED to initialize. Diagnostics:', diag);
  }

  // ── Express server: backend roots → NestJS, everything else → Next ─
  // This middleware is registered BEFORE NestFactory wires its router, so
  // it runs first in the Express stack. Page routes never reach Nest's
  // JSON 404; API/webhook/cron paths fall through to Nest untouched.
  const server = express();
  server.use((req: any, res: any, next: any) => {
    const p: string = req.path || req.url || '/';
    const isBackend = BACKEND_ROOTS.some(
      (r) => p === r || p.startsWith(r + '/'),
    );
    if (isBackend) return next();
    if (!nextHandle) {
      // Degraded mode: surface the reason in the browser so it can be
      // diagnosed without Hostinger log access.
      res.status(503).type('application/json').send(
        JSON.stringify(
          {
            error: 'frontend_unavailable',
            note: 'Next.js failed to initialize — API still works under /api',
            diag,
          },
          null,
          2,
        ),
      );
      return;
    }
    return nextHandle(req, res);
  });

  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(server),
    { rawBody: true }, // needed for Shopify webhook HMAC verification
  );

  // All app/API routes move under /api. External integration endpoints are
  // EXCLUDED so their public URLs do not change (Meta webhook, Shopify
  // webhook, UptimeRobot cron, health, media) — no re-registration needed.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'webhooks/meta', method: RequestMethod.ALL },
      { path: 'webhooks/meta/(.*)', method: RequestMethod.ALL },
      { path: 'integrations/shopify', method: RequestMethod.ALL },
      { path: 'integrations/shopify/(.*)', method: RequestMethod.ALL },
      { path: 'cron', method: RequestMethod.ALL },
      { path: 'cron/(.*)', method: RequestMethod.ALL },
    ],
  });

  // Trust Hostinger's reverse proxy so req.ip reflects the real client IP
  // (otherwise SuperAdminIpGuard sees Hostinger's edge IP, not the user's)
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', true);

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
