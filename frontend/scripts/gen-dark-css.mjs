#!/usr/bin/env node
/**
 * Generates src/app/dark-overrides.css — the dark-mode layer for LEGACY
 * Tailwind utilities (bg-white, gray-*, coloured -50/-100 tints, …) that were
 * written before the design tokens existed. New code should use the token
 * classes (surface/sunken/line/ink/muted/brand-*), which go dark via the CSS
 * vars in globals.css and need nothing here.
 *
 * Scans src/ for the classes actually used, so the output stays small.
 * Re-run after adding new legacy colour classes:
 *     node scripts/gen-dark-css.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src');
const OUT = path.join(SRC, 'app', 'dark-overrides.css');

// ── dark palette ─────────────────────────────────────────────────────────────
const BG = {
  white: '#121a17',
  'gray-50': '#0e1513',
  'gray-100': '#1a231f',
  'gray-200': '#243029',
  'gray-300': '#313d37',
  'gray-400': '#46534d',
  // gray-500+ backgrounds are already dark (buttons, tooltips) — untouched.
};
const HOVER_BG = {
  white: '#18211d',
  'gray-50': '#18211d',
  'gray-100': '#202a25',
  'gray-200': '#2a3530',
  'gray-300': '#35423c',
};
const TEXT = {
  'gray-900': '#e8efeb',
  'gray-800': '#dbe3df',
  'gray-700': '#c4cec9',
  'gray-600': '#a6b2ac',
  'gray-500': '#8c9993',
  'gray-400': '#717f79',
  'gray-300': '#56635d',
  black: '#e8efeb',
};
const BORDER = {
  'gray-50': '#1a231f',
  'gray-100': '#1f2924',
  'gray-200': '#29342f',
  'gray-300': '#36433d',
  'gray-400': '#4a5852',
  white: '#29342f',
};
// Tailwind 500 (rgb) for tints + 300/400 hex for readable text on dark.
const HUES = {
  green: ['34,197,94', '#86efac', '#4ade80'],
  emerald: ['16,185,129', '#6ee7b7', '#34d399'],
  teal: ['20,184,166', '#5eead4', '#2dd4bf'],
  cyan: ['6,182,212', '#67e8f9', '#22d3ee'],
  sky: ['14,165,233', '#7dd3fc', '#38bdf8'],
  blue: ['59,130,246', '#93c5fd', '#60a5fa'],
  indigo: ['99,102,241', '#a5b4fc', '#818cf8'],
  violet: ['139,92,246', '#c4b5fd', '#a78bfa'],
  purple: ['168,85,247', '#d8b4fe', '#c084fc'],
  fuchsia: ['217,70,239', '#f0abfc', '#e879f9'],
  pink: ['236,72,153', '#f9a8d4', '#f472b6'],
  rose: ['244,63,94', '#fda4af', '#fb7185'],
  red: ['239,68,68', '#fca5a5', '#f87171'],
  orange: ['249,115,22', '#fdba74', '#fb923c'],
  amber: ['245,158,11', '#fcd34d', '#fbbf24'],
  yellow: ['234,179,8', '#fde047', '#facc15'],
  lime: ['132,204,22', '#bef264', '#a3e635'],
  slate: ['100,116,139', '#cbd5e1', '#94a3b8'],
};
const TINT_ALPHA = { 50: 0.1, 100: 0.16, 200: 0.26, 300: 0.36 };
// Arbitrary light colours used by chat bubbles / mock phones.
const ARBITRARY_BG = {
  '#efeae2': '#0b1411', // WhatsApp chat wallpaper
  '#d9fdd3': '#14432f', // outbound bubble
  '#f0f2f5': '#16201c',
  '#e7fce3': '#14432f',
  '#dcf8c6': '#14432f',
  '#f7f8fa': '#0e1513',
  '#fafafa': '#0e1513',
  '#f9fafb': '#0e1513',
};

// ── scan ─────────────────────────────────────────────────────────────────────
const used = new Set();
const RX =
  /(?<![\w:-])((?:hover|focus|group-hover|focus-within):)?(bg|text|border|border-[trblxy]|divide|ring|from|via|to|placeholder)-(white|black|gray-\d{2,3}|[a-z]+-\d{2,3}|\[#[0-9a-fA-F]{3,8}\])(\/\d{1,3})?(?![\w-])/g;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?)$/.test(e.name)) {
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(RX)) used.add(m[0]);
    }
  }
}
walk(SRC);

const esc = (c) => c.replace(/([:/\[\]#.])/g, '\\$1');

function tintFor(color, opacity) {
  const m = /^([a-z]+)-(\d{2,3})$/.exec(color);
  if (!m || !HUES[m[1]]) return null;
  const [rgb, t300, t400] = HUES[m[1]];
  const shade = Number(m[2]);
  return { rgb, t300, t400, shade, opacity };
}

function decl(prop, color, op) {
  // returns a CSS declaration string or null
  const opacity = op ? Number(op.slice(1)) / 100 : null;
  if (prop === 'bg' || prop === 'from' || prop === 'via' || prop === 'to') {
    let v = null;
    const arb = /^\[(#[0-9a-fA-F]+)\]$/.exec(color);
    if (arb) v = ARBITRARY_BG[arb[1].toLowerCase()] ?? null;
    else if (BG[color]) v = BG[color];
    else {
      const t = tintFor(color);
      if (t && TINT_ALPHA[t.shade] !== undefined)
        v = `rgba(${t.rgb},${TINT_ALPHA[t.shade]})`;
    }
    if (!v) return null;
    if (opacity !== null && v.startsWith('#')) {
      const n = parseInt(v.slice(1), 16);
      v = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${opacity})`;
    }
    if (prop === 'bg') return `background-color:${v}`;
    if (prop === 'from') return `--tw-gradient-from:${v} var(--tw-gradient-from-position);--tw-gradient-to:transparent var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)`;
    if (prop === 'via') return `--tw-gradient-to:transparent var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),${v} var(--tw-gradient-via-position),var(--tw-gradient-to)`;
    return `--tw-gradient-to:${v} var(--tw-gradient-to-position)`;
  }
  if (prop === 'text' || prop === 'placeholder') {
    let v = TEXT[color] ?? null;
    if (!v) {
      const t = tintFor(color);
      if (t && t.shade >= 700) v = t.t300;
      else if (t && t.shade === 600) v = t.t400;
    }
    if (!v) return null;
    return `color:${v}`;
  }
  if (prop.startsWith('border') || prop === 'divide' || prop === 'ring') {
    let v = BORDER[color] ?? null;
    if (!v) {
      const t = tintFor(color);
      if (t && t.shade <= 300) v = `rgba(${t.rgb},0.35)`;
    }
    if (!v) return null;
    if (prop === 'ring') return `--tw-ring-color:${v}`;
    const side = { 'border-t': 'top', 'border-b': 'bottom', 'border-l': 'left', 'border-r': 'right' }[prop];
    if (side) return `border-${side}-color:${v}`;
    if (prop === 'border-x') return `border-left-color:${v};border-right-color:${v}`;
    if (prop === 'border-y') return `border-top-color:${v};border-bottom-color:${v}`;
    return `border-color:${v}`;
  }
  return null;
}

const rules = [];
for (const cls of [...used].sort()) {
  RX.lastIndex = 0;
  const m = RX.exec(cls);
  if (!m) continue;
  const [, variant, prop, color, op] = m;
  let d;
  if (variant && prop === 'bg' && !op && HOVER_BG[color]) d = `background-color:${HOVER_BG[color]}`;
  else d = decl(prop, color, op);
  if (!d) continue;
  const sel = `.${esc(cls)}`;
  let full;
  const v = variant?.slice(0, -1);
  if (v === 'hover') full = `.dark ${sel}:hover`;
  else if (v === 'focus') full = `.dark ${sel}:focus`;
  else if (v === 'focus-within') full = `.dark ${sel}:focus-within`;
  else if (v === 'group-hover') full = `.dark .group:hover ${sel}`;
  else full = `.dark ${sel}`;
  if (prop === 'divide') full += ' > :not([hidden]) ~ :not([hidden])';
  if (prop === 'placeholder') full += '::placeholder';
  rules.push(`${full}{${d}}`);
}

const header = `/* AUTO-GENERATED by scripts/gen-dark-css.mjs — do not edit by hand.
   Dark-mode layer for legacy Tailwind colour utilities (${rules.length} rules).
   Active only under <html class="dark"> (lib/theme.ts). */
.dark body{background-color:#0e1513;color:#e8efeb}
.dark :where(input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),textarea,select){background-color:#0e1513;border-color:#29342f;color:#e8efeb}
.dark .shadow,.dark .shadow-sm,.dark .shadow-md,.dark .shadow-lg,.dark .shadow-xl,.dark .shadow-2xl{--tw-shadow-color:rgba(0,0,0,.6)}
.dark .ring-offset-1,.dark .ring-offset-2{--tw-ring-offset-color:#121a17}
.dark .from-gray-100.via-gray-200.to-gray-100{--tw-gradient-from:#1a231f var(--tw-gradient-from-position)}
`;
fs.writeFileSync(OUT, header + rules.join('\n') + '\n');
console.log(`wrote ${path.relative(root, OUT)} — ${rules.length} rules from ${used.size} classes`);
