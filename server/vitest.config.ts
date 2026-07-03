import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vite injects BASE_URL="/" into worker env, so config values must be set
    // explicitly here (a `??=` default in a test file won't win).
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      BASE_URL: 'https://test.example.com',
      JWT_SECRET: 'test-secret-test-secret-test-secret-test',
      ENCRYPTION_KEY: 'a'.repeat(64),
      MEDIA_DIR: '/tmp/galaxy-test-media',
    },
  },
});
