import type { Config } from 'tailwindcss';

/**
 * Design tokens (UI foundation — Phase A).
 * Colours resolve to CSS variables defined in `src/app/globals.css` as RGB
 * channels, so opacity modifiers (`bg-brand-600/20`) work and a future dark
 * theme only has to redefine the variables. `brand` currently equals
 * Tailwind's green scale, so swapping `green-*` → `brand-*` is visually
 * identical. Use `brand-*` + the semantic names for all NEW code.
 */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  // Follow the app's theme (lib/theme.ts puts .dark on <html>), NOT the OS —
  // the default 'media' applied every dark: class on a light app for OS-dark users.
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: v('brand-50'),
          100: v('brand-100'),
          200: v('brand-200'),
          300: v('brand-300'),
          400: v('brand-400'),
          500: v('brand-500'),
          600: v('brand-600'),
          700: v('brand-700'),
          800: v('brand-800'),
          900: v('brand-900'),
        },
        surface: v('surface'),
        sunken: v('sunken'),
        line: v('line'),
        ink: v('ink'),
        muted: v('muted'),
        // CodesApp brand tile (dashboard heroes): navy + cyan accent.
        navy: { DEFAULT: v('navy'), 2: v('navy-2'), line: v('navy-line') },
        accent: v('accent'),
      },
      fontFamily: {
        sans: [
          'var(--font-sans)',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
      },
      keyframes: {
        shimmer: { to: { backgroundPosition: '-200% 0' } },
      },
      animation: {
        shimmer: 'shimmer 1.4s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
