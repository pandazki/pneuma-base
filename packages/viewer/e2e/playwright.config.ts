import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// The management UI in the installed Google Chrome, against real servers started by the command line.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  workers: 2,
  reporter: [['list']],
  outputDir: join(tmpdir(), 'pneuma-base-e2e-results'),
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  },
})
