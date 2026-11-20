// Fast unit-test config for PURE modules (no Nest graph). The default `jest`
// run type-checks the whole app and OOMs; this one transpiles in isolation.
//   npx jest -c jest.unit.config.js
module.exports = {
  rootDir: 'src',
  testRegex: '(team-v4|memory)\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
