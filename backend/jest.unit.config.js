// Fast unit-test config for PURE modules (no Nest graph). The default `jest`
// run type-checks the whole app and OOMs; this one transpiles in isolation.
//   npx jest -c jest.unit.config.js
module.exports = {
  rootDir: 'src',
  testRegex: '(team-v4|memory|roles-modules|inventory-core|completed-entities|tcs.adapter|order-lines|external-bookings|tiktok.adapter|tiktok-comments.client|tiktok.writer|google-ads|youtube.client|dashboard-math|meta-social-parse)\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
