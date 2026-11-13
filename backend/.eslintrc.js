/**
 * Backend lint config (ESLint 8 + @typescript-eslint). Type-aware rules that
 * catch real bugs are errors; stylistic / legacy-noise rules are warnings so
 * the existing codebase lints clean while new code gets the feedback.
 * Run: `npm run lint:check` (CI-safe, no --fix) or `npm run lint` (fixes).
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, jest: true },
  ignorePatterns: ['.eslintrc.js', 'dist/', 'node_modules/', 'coverage/', 'prisma/'],
  rules: {
    // Real bugs: an un-awaited promise silently swallows errors / races.
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
    'no-constant-condition': ['error', { checkLoops: false }],
    // Legacy noise — keep visible, don't fail the build.
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    '@typescript-eslint/no-require-imports': 'off',
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-namespace': 'off',
    '@typescript-eslint/ban-types': 'warn',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-useless-escape': 'warn',
    'no-case-declarations': 'warn',
    'no-control-regex': 'off',
    'prefer-const': 'warn',
  },
};
