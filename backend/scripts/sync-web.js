'use strict';

/**
 * Copies the prebuilt Next.js frontend into backend/dist/web. Hostinger
 * deploys ONLY the Output directory (`dist`) + node_modules + package.json,
 * NOT arbitrary backend/ siblings — so the frontend must live INSIDE dist.
 *
 * `nest build` has deleteOutDir:true (wipes dist), so the required order is:
 *   1. cd backend  && npm run build:local   (compiles src -> dist)
 *   2. cd frontend && npx next build         (produces frontend/.next)
 *   3. cd backend  && npm run sync:web       (copies build into dist/web)
 * Commit backend/dist (incl. dist/web). No build runs on Hostinger.
 */
const fs = require('fs');
const path = require('path');

const frontend = path.join(__dirname, '..', '..', 'frontend');
const web = path.join(__dirname, '..', 'dist', 'web');

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const builtNext = path.join(frontend, '.next');
if (!fs.existsSync(path.join(builtNext, 'BUILD_ID'))) {
  console.error(
    '[sync:web] No production build found at frontend/.next — run `next build` first.',
  );
  process.exit(1);
}

rmrf(web);
fs.mkdirSync(web, { recursive: true });
copyDir(builtNext, path.join(web, '.next'));
rmrf(path.join(web, '.next', 'cache')); // dev/build cache — not for runtime
fs.copyFileSync(
  path.join(frontend, 'next.config.js'),
  path.join(web, 'next.config.js'),
);
fs.copyFileSync(
  path.join(frontend, 'package.json'),
  path.join(web, 'package.json'),
);

const pub = path.join(frontend, 'public');
if (fs.existsSync(pub)) copyDir(pub, path.join(web, 'public'));

console.log('[sync:web] frontend build synced to backend/dist/web');
