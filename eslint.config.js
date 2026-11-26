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
// the kernel's storage.ts, which a plugin reaches as `tools.storage`. Every file of the kernel and of
// the ledger is on storage (step 3): none may read or write the library's folder or record area any
// other way. The files below may still use the file system, each for files that are no library's
// folder or record area, and so are not checked:
const OFF_STORAGE = {
  kernel: {
    'storage.ts': 'the door itself: it starts the storage program and finds its binary',
    'address.ts': "a library's address: the real path of the folder a caller names, and the folder init makes, before storage can answer for it",
    'paths.ts': 'an absolute path a caller wrote, resolved through links to the library path it names; a path already under the root is taken as written',
    'outside.ts': "a put's source outside the library: its kind, size and sha256",
    'contract-v1.ts': 'contract 1, removed next step: an outside file\'s sha256 and the outside directory a copy-out writes into',
    'cognition.ts': "the package's own texts",
    'tool-log.ts': 'the log of what plugins ask storage, at a path outside every library a test harness names in PNEUMA_BASE_TOOL_LOG',
    'machine-files.ts': 'machine state under $PNEUMA_BASE_HOME, and the files of other programs an owner command writes',
    'grants.ts': 'grant files under $PNEUMA_BASE_HOME',
    'endpoint.ts': 'the local endpoint files under $PNEUMA_BASE_HOME',
    'pairing.ts': 'pairings under $PNEUMA_BASE_HOME',
    'secrets.ts': "plugins' secrets under $PNEUMA_BASE_HOME",
    'plugin-table.ts': 'plugins installed under $PNEUMA_BASE_HOME',
    'launcher.ts': 'the launcher under $PNEUMA_BASE_HOME',
    'connections.ts': "agents' configuration files and the connection records under $PNEUMA_BASE_HOME",
    'products.ts': "where each agent product keeps its configuration and its conversations",
    'agent-commands.ts': "agents' configuration files and skill folders",
    'owner-commands.ts': 'the skill file an owner command writes where the owner says, and installed plugins',
  },
  ledger: {
    'conversation.ts': "agents' conversation transcripts, outside the library",
    'cognition.ts': "the package's own texts",
    'export-file.ts': 'the audit export the owner names: one file outside the library, written page by page',
  },
}
const DOOR = 'On storage: read and write the folder and the record area only through the storage door (the kernel\'s storage.ts; a plugin\'s tools.storage). tmp/run-7 architecture.md section 7; eslint.config.js lists the files that may use the file system and why.'
const FS = ['node:fs', 'node:fs/promises', 'fs', 'fs/promises', 'node:child_process', 'child_process'].map((name) => ({ name, message: DOOR }))
const DIRECT = ['abs', 'canonical', 'thingAt', 'libraryFiles', 'listThings', 'bundleFiles', 'bundleManifest', 'fingerprintOf', 'fingerprintOfFile', 'enclosingBundle', 'copyBundle']
const V1_TOOLS = 'abs|thing|things|files|copyOut|manifest|fingerprint|fingerprintOfFile|fingerprintOfManifest|putting'
const TOOLS = { selector: `MemberExpression[property.name=/^(${V1_TOOLS})$/][object.type='MemberExpression'][object.property.name='tools']`, message: `${DOOR} The contract-1 tools are a layer for the plugins not moved yet.` }
const door = (boundary, files, ignores, paths, patterns) => ({
  files,
  ignores,
  rules: {
    'no-restricted-imports': ['error', { paths: [...FS, ...paths], patterns: [...boundary.rules['no-restricted-imports'][1].patterns, ...patterns] }],
    'no-restricted-syntax': ['error', TOOLS],
  },
})
const off = (dir, names) => Object.keys(names).map((f) => `${dir}/${f}`)
const storageDoor = [
  door(kernelBoundary, ['packages/kernel/src/**/*.ts'], off('packages/kernel/src', OFF_STORAGE.kernel), [{ name: './paths.js', importNames: ['abs', 'canonical'], message: DOOR }], [{ regex: '^\\./machine-files(\\.js)?$', message: DOOR }]),
  door(pluginBoundary, ['packages/plugin-ledger/src/**/*.ts'], off('packages/plugin-ledger/src', OFF_STORAGE.ledger), [{ name: '@pneuma-base/kernel', importNames: DIRECT, message: DOOR }], []),
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
