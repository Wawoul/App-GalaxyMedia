import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One file at a time: the route tests share a single database and each
    // truncates the tables it owns, so running two in parallel has them delete
    // each other's fixtures mid-run. The suite is fast enough that serialising
    // costs nothing, and it keeps failures meaningful rather than flaky.
    fileParallelism: false,
    // Vite injects BASE_URL="/" into worker env, so config values must be set
    // explicitly here (a `??=` default in a test file won't win).
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      BASE_URL: 'https://test.example.com',
      // Random-looking on purpose: config.ts rejects low-entropy secrets, and a
      // test fixture that couldn't pass real validation would be a poor fixture.
      JWT_SECRET: '9f3b7c21ae845d06f2e19b4c7a83d5e0621fb94c7d3ea85102bc6f47',
      ENCRYPTION_KEY: 'a'.repeat(64),
      MEDIA_DIR: '/tmp/galaxy-test-media',
    },
  },
});
