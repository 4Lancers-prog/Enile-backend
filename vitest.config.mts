import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://localhost:27017/enile_test',
      JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0000',
      JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-000',
      FILE_URL_SECRET: 'test-file-secret-test-file-secret-00000000',
      LOG_LEVEL: 'fatal',
    },
  },
});
