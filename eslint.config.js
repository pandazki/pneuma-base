import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// The sdk is the plugin contract alone: a plugin outside the repository depends on it, so it imports
// nothing of the kernel, the command line, the viewer or any plugin.
const sdkBoundary = {
  files: ['packages/sdk/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        {
          regex: '^@pneuma-base/(kernel|cli|viewer|plugin-[^/]+)(/.*)?$',
          message: 'The sdk is the plugin contract alone: it imports nothing of the kernel, the command line, the viewer or a plugin. The kernel gives plugins its helpers through PluginContext.tools.',
        },
        {
          regex: '^(\\.\\./)+(kernel|cli|viewer|plugin-[^/]+)(/|$)',
          message: 'The sdk is the plugin contract alone: it imports nothing of the kernel, the command line, the viewer or a plugin. The kernel gives plugins its helpers through PluginContext.tools.',
        },
      ],
    }],
  },
}

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

// The agent routes are open to any program on this machine: they reach neither the owner's routes
// (api.ts holds the calls and init) nor a face that acts in a library.
const agentRoutesBoundary = {
  files: ['packages/viewer/src/server/agent.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: [{
        name: '@pneuma-base/kernel',
        importNames: ['ownerFace', 'initLibrary', 'agentFace', 'viewerFace'],
        message: 'The agent routes never act in a library: the owner acts through /api, a connected agent through its grant.',
      }],
      patterns: [
        ...viewerBoundary.rules['no-restricted-imports'][1].patterns,
        { regex: '^\\./(api|index)(\\.js)?$', message: 'The agent routes never reach the owner\'s routes or the token.' },
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
          message: 'A plugin imports only @pneuma-base/kernel and @pneuma-base/sdk, with its kit. Plugins do not call each other, the command line or the viewer.',
        },
        {
          regex: '^(\\.\\./)+(kernel|cli|plugin-[^/]+)(/|$)',
          message: 'A plugin reaches the kernel only through the package @pneuma-base/kernel, not its files.',
        },
      ],
    }],
  },
}

// tmp/run-7: the records say what is in the library, and storage is looked at only through one door,
// the kernel's storage.ts, which a plugin reaches as `tools.storage`. The files rebuilt on it are listed
// here and may not read the library's folder or record area any other way; each step adds the ones it moves.
const ON_STORAGE = {
  kernel: ['home.ts', 'places.ts', 'plugin-views.ts', 'start.ts', 'noise-commands.ts'],
  ledger: ['facts.ts', 'feeds.ts', 'fold.ts', 'reconcile.ts', 'since.ts', 'sparse.ts', 'start-find.ts', 'state.ts', 'unowned.ts', 'views.ts'],
  viewer: ['src/server/api.ts'],
}
const DOOR = 'Rebuilt on storage: read the folder and the record area only through the storage door (the kernel\'s storage.ts; a plugin\'s tools.storage). tmp/run-7 architecture.md section 7.'
const FS = ['node:fs', 'node:fs/promises', 'fs', 'fs/promises'].map((name) => ({ name, message: DOOR }))
const DIRECT = ['abs', 'thingAt', 'libraryFiles', 'listThings', 'bundleFiles', 'bundleManifest', 'fingerprintOf', 'fingerprintOfFile', 'enclosingBundle', 'copyBundle']
const TOOLS = { selector: "MemberExpression[property.name=/^(abs|thing|things|files|copyOut|manifest)$/][object.type='MemberExpression'][object.property.name='tools']", message: DOOR }
const door = (boundary, files, paths, patterns) => ({
  files,
  rules: {
    'no-restricted-imports': ['error', { paths: [...FS, ...paths], patterns: [...boundary.rules['no-restricted-imports'][1].patterns, ...patterns] }],
    'no-restricted-syntax': ['error', TOOLS],
  },
})
const storageDoor = [
  door(kernelBoundary, ON_STORAGE.kernel.map((f) => `packages/kernel/src/${f}`), [{ name: './paths.js', importNames: ['abs', 'canonical'], message: DOOR }], [{ regex: '^\\./(things|files|content|putting)(\\.js)?$', message: DOOR }]),
  door(pluginBoundary, ON_STORAGE.ledger.map((f) => `packages/plugin-ledger/src/${f}`), [{ name: '@pneuma-base/kernel', importNames: DIRECT, message: DOOR }], [{ regex: '^\\./disk(\\.js)?$', message: DOOR }]),
  door(viewerBoundary, ON_STORAGE.viewer.map((f) => `packages/viewer/${f}`), [{ name: '@pneuma-base/kernel', importNames: DIRECT, message: DOOR }], [{ regex: '^\\./files(\\.js)?$', message: DOOR }]),
]

export default tseslint.config(
  // The plugin project templates are checked where they run: the scaffold's test builds and tests a generated project.
  { ignores: ['**/dist/**', '**/node_modules/**', 'tmp/**', 'dist-packages/**', 'packages/cli/templates/**', 'plugins/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
  {
    // The frame kit runs as a plain script in a plugin's page, in the browser.
    files: ['packages/viewer/web/kit/**/*.js'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly', ResizeObserver: 'readonly' } },
  },
  {
    // The Mac app injects this script into the page it shows.
    files: ['app/Resources/shell.js'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly', requestAnimationFrame: 'readonly', MutationObserver: 'readonly', Element: 'readonly' } },
  },
  {
    files: ['app/experiments/*.mjs'],
    languageOptions: { globals: { Buffer: 'readonly', performance: 'readonly', setTimeout: 'readonly' } },
  },
  {
    // Tests read JSON printed by the command line; typing every shape there adds nothing.
    files: ['packages/*/test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  sdkBoundary,
  kernelBoundary,
  pluginBoundary,
  viewerBoundary,
  agentRoutesBoundary,
  webBoundary,
  ...storageDoor,
)
