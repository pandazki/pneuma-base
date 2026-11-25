import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// K4: the kernel depends on no plugin, not on the command line and not on the viewer; a plugin
// reaches the kernel only through `@pneuma-base/kernel` and never another plugin, the command line
// or the viewer. The viewer is a client of the kernel that knows no plugin: it gets the plugin
// table from its caller, and its page takes only types from the kernel.
const kernelBoundary = {
  files: ['packages/kernel/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        {
          regex: '^@pneuma-base/(cli|viewer|plugin-[^/]+)(/.*)?$',
          message: 'K4: the kernel imports no plugin, not the command line and not the viewer. Add an extension point to the kernel and let the plugin implement it.',
        },
        {
          regex: '^(\\.\\./)+(cli|viewer|plugin-[^/]+)(/|$)',
          message: 'K4: the kernel imports no plugin, not the command line and not the viewer. Add an extension point to the kernel and let the plugin implement it.',
        },
      ],
    }],
  },
}

const viewerBoundary = {
  files: ['packages/viewer/**/*.ts', 'packages/viewer/**/*.tsx'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        {
          regex: '^@pneuma-base/(cli|plugin-[^/]+)(/.*)?$',
          message: 'The viewer knows no plugin and not the command line. It renders the blocks views give; the caller passes the plugin table to startServer.',
        },
        {
          regex: '^(\\.\\./)+(kernel|cli|plugin-[^/]+)(/|$)',
          message: 'The viewer reaches the kernel only through the package @pneuma-base/kernel, and knows no plugin and not the command line.',
        },
      ],
    }],
  },
}

const webBoundary = {
  files: ['packages/viewer/web/**/*.ts', 'packages/viewer/web/**/*.tsx'],
  rules: {
    '@typescript-eslint/no-restricted-imports': ['error', {
      paths: [{
        name: '@pneuma-base/kernel',
        allowTypeImports: true,
        message: 'The page runs in the browser and talks to the server over /api: it takes only types from the kernel.',
      }],
    }],
  },
}

const pluginBoundary = {
  files: ['packages/plugin-*/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        {
          regex: '^@pneuma-base/(cli|viewer|plugin-[^/]+)(/.*)?$',
          message: 'A plugin imports only @pneuma-base/kernel. Plugins do not call each other, the command line or the viewer.',
        },
        {
          regex: '^(\\.\\./)+(kernel|cli|plugin-[^/]+)(/|$)',
          message: 'A plugin reaches the kernel only through the package @pneuma-base/kernel, not its files.',
        },
      ],
    }],
  },
}

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'tmp/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
  {
    // Tests read JSON printed by the command line; typing every shape there adds nothing.
    files: ['packages/*/test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  kernelBoundary,
  pluginBoundary,
  viewerBoundary,
  webBoundary,
)
