# CodesApp — production image for the VPS (single process: NestJS API + mounted Next.js).
# Mirrors the local build ritual exactly: nest build -> next build -> sync:web.
# Two stages so the final image ships only what runtime needs.

# ---------- Stage 1: build ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app
# libssl for Prisma engine; ca-certs for npm/prisma downloads.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install deps first (Docker layer cache). Backend postinstall runs `prisma generate`,
# so the schema must be present before `npm ci`.
COPY backend/package*.json backend/
COPY backend/prisma backend/prisma
RUN cd backend && npm ci --legacy-peer-deps
COPY frontend/package*.json frontend/
RUN cd frontend && npm ci --legacy-peer-deps

# Copy source and build (order matters: nest build wipes dist, so sync:web runs last).
COPY backend backend
COPY frontend frontend
RUN cd /app/backend  && npm run build:local \
 && cd /app/frontend && npx next build \
 && cd /app/backend  && npm run sync:web \
 && test -f /app/backend/dist/web/.next/BUILD_ID

# ---------- Stage 2: runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app/backend
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# Only the backend dir is needed at runtime; the built frontend lives inside dist/web,
# and next/react resolve from backend/node_modules (same as Hostinger).
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/prisma ./prisma
COPY --from=build /app/backend/package.json ./package.json
COPY --from=build /app/backend/server.js ./server.js
# process.cwd() is /app/backend, so main.ts serves /storage from /app/storage (bind-mounted).
EXPOSE 3001
# Apply any pending migrations (no-op if the imported DB is already current), then start.
CMD ["sh","-lc","npx prisma migrate deploy || echo '[start] migrate skipped'; node dist/main.js"]
