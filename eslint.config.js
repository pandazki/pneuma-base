import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// K4: the kernel depends on no plugin and not on the command line; a plugin reaches the kernel
// only through `@pneuma-base/kernel` and never another plugin or the command line.
const kernelBoundary = {
  files: ['packages/kernel/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        {
          regex: '^@pneuma-base/(cli|plugin-[^/]+)(/.*)?$',
          message: 'K4: the kernel imports no plugin and not the command line. Add an extension point to the kernel and let the plugin implement it.',
        },
        {
          regex: '^(\\.\\./)+(cli|plugin-[^/]+)(/|$)',
          message: 'K4: the kernel imports no plugin and not the command line. Add an extension point to the kernel and let the plugin implement it.',
        },
      ],
    }],
  },
}

const pluginBoundary = {
  files: ['packages/plugin-*/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        {
          regex: '^@pneuma-base/(cli|plugin-[^/]+)(/.*)?$',
          message: 'A plugin imports only @pneuma-base/kernel. Plugins do not call each other or the command line.',
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
)
