import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/dev-server.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
        'src/tools/**': { lines: 85, functions: 85, statements: 85 },
        'src/format/**': { lines: 85, functions: 85, statements: 85 },
        'src/rest/**': { lines: 85, functions: 85, statements: 85 },
      },
    },
  },
});
