import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'packages/*/test/**/*.slow.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: ['./vitest.global-setup.ts'],
  },
})
