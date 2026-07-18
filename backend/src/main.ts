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
import {
  mediaWebPathToDisk,
  generateImageThumbnail,
} from './common/utils/media-path';

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
  // Only the Meta webhook lives at the root (excluded from the /api
  // prefix so Meta's configured callback URL is fixed). The webhook
  // ENDPOINT-CRUD API is under /api/webhooks/*, and the Next.js
  // `/webhooks` page must stay reachable — so DON'T reserve all of
  // `/webhooks`, only `/webhooks/meta`.
  '/webhooks/meta',
  '/webhooks/shopify',
  '/integrations',
  '/cron',
  '/socket.io',
  '/storage',
];
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';

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

// Install process-level error handlers BEFORE anything async fires.
// Hostinger Cloud Apps restarts the process on any unhandled rejection,
// which produces a "0→N→0" CPU spike loop and the per-request 503 / loader-
// stuck-running symptoms throughout the app. Log, never exit.
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[process] uncaughtException — keeping process alive:', err);
});
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[process] unhandledRejection — keeping process alive:', reason);
});

async function bootstrap() {
  logEnvStatus();

  // ── Prepare the prebuilt Next.js app ──────────────────────────────
  // Hostinger deploys ONLY the Output dir (dist) → the built frontend ships
  // at backend/dist/web (synced via `npm run sync:web`). __dirname =
  // <deploy>/dist → ./web. Resilient: if Next can't init, the API /
  // /health / webhooks still come up (degraded mode, diagnostics exposed).
  const frontendDir = path.join(__dirname, 'web');
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

  // Serve downloaded WhatsApp media. Files are written by MediaService to
  // <cwd>/../storage/media/<companyId>/<yyyy>/<mm>/<uuid>.<ext> and stored
  // in messages.media_url as the web path /storage/media/...; this mount
  // maps that URL back to disk. Filenames are random UUIDs (capability
  // URLs). Registered before the Next/backend router so it short-circuits.
  const storageDir = path.join(process.cwd(), '..', 'storage');

  // Lazy thumbnail generation. New media gets a `<name>.thumb.jpg` at save time,
  // but media that predates thumbnails has none. Rather than a heavy one-shot
  // backfill over the whole (multi-GB) store, generate a missing thumb from its
  // sibling original on first request, then let the static mount below serve it
  // (and every later request) from disk. The cost is spread across actual views
  // and paid once per image. Any failure just falls through → static 404 →
  // the client's <img> onError shows the full-res original.
  server.get('/storage/media/*', (req: any, res: any, next: any) => {
    void (async () => {
      try {
        const reqPath = decodeURIComponent(req.path || '');
        if (!reqPath.endsWith('.thumb.jpg')) return next();
        const abs = mediaWebPathToDisk(reqPath);
        if (!abs || fs.existsSync(abs)) return next(); // absent-guard or cached
        const base = abs.slice(0, -'.thumb.jpg'.length);
        let original: string | null = null;
        for (const e of ['jpg', 'jpeg', 'png', 'webp']) {
          if (fs.existsSync(`${base}.${e}`)) {
            original = `${base}.${e}`;
            break;
          }
        }
        if (original) await generateImageThumbnail(original);
      } catch {
        /* fall through — static will 404 and the client falls back */
      }
      return next();
    })();
  });

  server.use(
    '/storage',
    express.static(storageDir, {
      index: false,
      fallthrough: false,
      maxAge: '7d',
    }),
    // A missing media file (e.g. pre-migration media never copied, or expired
    // by the 7-day cleanup) is a normal 404 — answer it quietly instead of
    // letting it bubble to the global filter and spam ERROR logs.
    (err: any, _req: any, res: any, next: any) => {
      if (
        err &&
        (err.statusCode === 404 || err.status === 404 || err.code === 'ENOENT')
      ) {
        if (!res.headersSent) res.status(404).end();
        return;
      }
      next(err);
    },
  );

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
      { path: 'webhooks/shopify', method: RequestMethod.ALL },
      { path: 'webhooks/shopify/(.*)', method: RequestMethod.ALL },
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

  // ── Socket.io scaling (opt-in) ────────────────────────────────────────
  // With a single app container the default in-memory socket adapter is
  // correct, so we leave it alone. When REDIS_URL is set (horizontal scaling:
  // 2+ containers behind Traefik), install the Redis adapter so broadcasts
  // reach clients connected to sibling containers. Fail-safe: if the adapter
  // can't connect we log and fall back to in-memory rather than blocking boot.
  const redisUrl = config.get<string>('REDIS_URL');
  if (redisUrl) {
    try {
      const redisAdapter = new RedisIoAdapter(app, redisUrl);
      await redisAdapter.connectToRedis();
      app.useWebSocketAdapter(redisAdapter);
      console.log('[socket] Redis adapter enabled (multi-container mode)');
    } catch (err) {
      console.error(
        '[socket] Redis adapter failed — falling back to in-memory:',
        (err as Error)?.message,
      );
    }
  }

  const port = Number(config.get<string>('PORT') ?? process.env.PORT ?? 3001);
  await app.listen(port);

  console.log(`CodesApp backend running on port ${port}`);
}

bootstrap().catch((err) => {
  console.error('[bootstrap] FATAL ERROR:', err);
  process.exit(1);
});
