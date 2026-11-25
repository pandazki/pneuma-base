import { defineConfig } from 'vitest/config'

// Tests that install from the registry and build whole projects: `pnpm test:slow`, a CI job of their own.
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.slow.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    globalSetup: ['./vitest.global-setup.ts'],
  },
})
