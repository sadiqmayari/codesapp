'use strict';

/**
 * Copies the prebuilt Next.js frontend into backend/web so it ships inside
 * the ONLY directory Hostinger deploys (the backend root). Run AFTER
 * `next build` in ../frontend. No build happens on Hostinger (OOM rule);
 * backend/web/.next is committed, same pattern as backend/dist.
 *
 * Usage:  cd frontend && npx next build && cd ../backend && npm run sync:web
 */
const fs = require('fs');
const path = require('path');

const frontend = path.join(__dirname, '..', '..', 'frontend');
const web = path.join(__dirname, '..', 'web');

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

console.log('[sync:web] frontend build synced to backend/web');
