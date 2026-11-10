import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include:
      process.env.NEXUS_CONTRACT === '1'
        ? ['packages/**/*.contract.test.ts']
        : ['packages/**/*.test.{ts,tsx}'],
    // Contract tests drive real harness CLIs and spend quota: only via `pnpm test:contract`.
    exclude: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      ...(process.env.NEXUS_CONTRACT === '1' ? [] : ['**/*.contract.test.ts']),
    ],
    environment: 'node',
    passWithNoTests: false,
  },
});
