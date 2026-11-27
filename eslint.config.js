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

// The storage door, over every package (ARCHITECTURE.md「六层」 and 「不变式」): the records say
// what is in the library, and nothing above storage reads or writes the library's folder or its record
// area but through the kernel's one door, packages/kernel/src/storage.ts, which a plugin reaches as
// `ctx.tools`. Checked in the runtime sources of every package: packages/*/src, plugins/*/src and the
// scaffold's templates. There a file may not start a program (node:child_process), may use the file
// system only to read its own package's files (`readFileSync(new URL(…, import.meta.url))`, such as a
// cognition text), and may not use the kernel's helpers that touched the folder nor the tools of plugin
// contract 1. Not checked, because they are no runtime of the library: tests (they stand for the world
// outside, such as an agent's own tools writing into a library), and build, test and demonstration
// scripts (`scripts/` of the repository and of each plugin).
//
// The files below may use the file system and start programs, each for what is no library's folder or
// record area, and say what: machine state under $PNEUMA_BASE_HOME, paths outside the library that a
// person or a plugin names, and the files of other programs.
const MAY_TOUCH_FILES = {
  'packages/kernel/src/storage.ts': 'the door itself: it starts the storage program and finds its binary',
  'packages/kernel/src/address.ts': "a library's address: the real path of the folder a caller names, and the folder init makes, before storage can answer for it",
  'packages/kernel/src/paths.ts': 'an absolute path a caller wrote, resolved through links to the library path it names; a path already under the root is taken as written',
  'packages/kernel/src/outside.ts': "a put's source outside the library: its kind, size and sha256",
  'packages/kernel/src/cognition.ts': "the package's own texts",
  'packages/kernel/src/tool-log.ts': 'the log of what plugins ask storage, at a path outside every library a test harness names in PNEUMA_BASE_TOOL_LOG',
  'packages/kernel/src/machine-files.ts': 'machine state under $PNEUMA_BASE_HOME, and the files of other programs an owner command writes',
  'packages/kernel/src/grants.ts': 'grant files under $PNEUMA_BASE_HOME',
  'packages/kernel/src/endpoint.ts': 'the local endpoint files under $PNEUMA_BASE_HOME',
  'packages/kernel/src/pairing.ts': 'pairings under $PNEUMA_BASE_HOME',
  'packages/kernel/src/secrets.ts': "plugins' secrets under $PNEUMA_BASE_HOME",
  'packages/kernel/src/plugin-table.ts': 'plugins installed under $PNEUMA_BASE_HOME',
  'packages/kernel/src/launcher.ts': 'the launcher under $PNEUMA_BASE_HOME',
  'packages/kernel/src/connections.ts': "agents' configuration files and the connection records under $PNEUMA_BASE_HOME",
  'packages/kernel/src/products.ts': 'where each agent product keeps its configuration and its conversations',
  'packages/kernel/src/agent-commands.ts': "agents' configuration files and skill folders",
  'packages/kernel/src/owner-commands.ts': 'the skill file an owner command writes where the owner says, and installed plugins',
  'packages/kernel/src/providers.ts': "the storage providers on this machine: the registry under $PNEUMA_BASE_HOME, the programs of this installation, and a provider's describe, run on an empty folder of its own",
  'packages/kernel/src/provider-install.ts': "a provider taken from a repository's releases into $PNEUMA_BASE_HOME, and the contract suite run on it before it is used",
  'packages/plugin-ledger/src/conversation.ts': "agents' conversation transcripts, outside the library",
  'packages/plugin-ledger/src/export-file.ts': 'the audit export the owner names: one file outside the library, written page by page',
  'packages/viewer/src/server/index.ts': "the built pages and the files of a plugin's ui folder, outside every library",
  'packages/viewer/src/server/files.ts': "the files of a plugin's ui folder, and a stamp of this machine's pairings under $PNEUMA_BASE_HOME",
  'packages/cli/src/main.ts': 'whether the first word a person typed names a folder, to open the management UI on it',
  'packages/cli/src/verbs.ts': "whether a path an agent typed names a file or a folder, before the kernel parses it",
  'packages/cli/src/scaffold.ts': 'the plugin project plugin new writes where the person says, outside every library, and the standard it points to',
  'packages/sdk/src/testkit/run.ts': 'the test kit: it starts the command line on sandbox libraries',
  'packages/sdk/src/testkit/sandbox.ts': 'the test kit: it makes sandbox libraries in a temporary folder and starts the command line and the UI server on them',
  'packages/sdk/src/testkit/conformance.ts': "the test kit: it looks at a sandbox library from outside, as a person's file manager does, to see what a plugin changed",
  'packages/sdk/src/kit/deploy/content.ts': "the stage folder in the plugin's cache under $PNEUMA_BASE_HOME, where a thing's files are read out to before a target takes them",
  'packages/plugin-version/src/outside.ts': 'where a version is exported to: the destination the owner names, or the temporary folder a restore puts back from, outside the library',
  'packages/plugin-search/src/store.ts': "the search index, a sqlite file in the plugin's cache under $PNEUMA_BASE_HOME",
  'packages/plugin-sync/src/target.ts': 'the sync target, a folder outside the library (sync refuses one that overlaps it), and the copies staged in its .pneuma-sync/tmp',
  'packages/plugin-sync/src/baseline.ts': "what sync saw last on both sides, a file in the plugin's cache under $PNEUMA_BASE_HOME",
  'packages/plugin-deploy/src/targets.ts': 'the dir target writes the folder outside the library the owner names; the command target runs the commands the owner set',
  'plugins/space/src/cloudflare.ts': 'the credentials file the owner names, outside the library',
  'plugins/space/src/space.ts': "the staged site files the deploy kit read out into the plugin's cache",
  'plugins/space/src/package.ts': "the staged site files the deploy kit read out into the plugin's cache",
  'packages/cli/templates/deploy/src/target.ts': 'the folder outside the library the owner names as the target',
}
/** Projects of their own in this repository, which only the storage door covers. */
const OWN_PROJECTS = ['plugins/**', 'packages/cli/templates/**']
const DOOR = "The storage door: the library is read and written only through packages/kernel/src/storage.ts (a plugin: ctx.tools); other file access is listed in MAY_TOUCH_FILES with its reason."
const FS = /^(node:)?fs(\/promises)?$/.source
const CHILD = ['node:child_process', 'child_process'].map((name) => ({ name, message: DOOR }))
const DIRECT = ['abs', 'canonical', 'thingAt', 'libraryFiles', 'listThings', 'bundleFiles', 'bundleManifest', 'fingerprintOf', 'fingerprintOfFile', 'enclosingBundle', 'copyBundle']
const V1_TOOLS = 'abs|thing|things|files|copyOut|manifest|fingerprint|fingerprintOfFile|fingerprintOfManifest|putting'
const SYNTAX = [
  { selector: `ImportDeclaration[source.value=/${FS}/] > :matches(ImportSpecifier[imported.name!='readFileSync'], ImportDefaultSpecifier, ImportNamespaceSpecifier)`, message: `${DOOR} Of the file system, a package reads only its own files with readFileSync.` },
  { selector: `CallExpression[callee.name='readFileSync']:not([arguments.0.type='NewExpression'][arguments.0.callee.name='URL'][arguments.0.arguments.1.object.type='MetaProperty'])`, message: `${DOOR} readFileSync reads only the package's own files: readFileSync(new URL(…, import.meta.url)).` },
  { selector: `ImportExpression[source.value=/^(node:)?(fs|child_process)/]`, message: DOOR },
  { selector: `CallExpression[callee.property.name='getBuiltinModule'][arguments.0.value=/^(node:)?(fs|child_process)/]`, message: DOOR },
  { selector: `CallExpression[callee.name='require'][arguments.0.value=/^(node:)?(fs|child_process)/]`, message: DOOR },
  { selector: `MemberExpression[property.name=/^(${V1_TOOLS})$/][object.type='MemberExpression'][object.property.name='tools']`, message: `${DOOR} The tools of plugin contract 1 are gone; PLUGINS.md says what replaces each.` },
  { selector: `MemberExpression[property.name='dir'][object.name=/^(ctx|pctx)$/]`, message: `${DOOR} A plugin's context has no dir in contract 2: its record place is tools.storage.own and tools.storage.records.` },
]
const allowed = Object.keys(MAY_TOUCH_FILES)
/** The door on `files`, keeping the import rules of the boundary those files already have. */
const door = (files, patterns = [], paths = []) => ({
  files,
  ignores: allowed,
  rules: {
    'no-restricted-imports': ['error', { paths: [...CHILD, ...paths], patterns }],
    'no-restricted-syntax': ['error', ...SYNTAX],
  },
})
const patternsOf = (boundary) => boundary.rules['no-restricted-imports'][1].patterns
const SOURCES = ['**/*.ts', '**/*.js', '**/*.mjs'].map((ext) => ext.replace('**', 'src/**'))
const under = (...dirs) => dirs.flatMap((dir) => SOURCES.map((src) => `${dir}/${src}`))
const storageDoor = [
  door(under('packages/kernel'), [...patternsOf(kernelBoundary), { regex: '^\\./machine-files(\\.js)?$', message: DOOR }], [{ name: './paths.js', importNames: ['abs', 'canonical'], message: DOOR }]),
  door(under('packages/sdk'), patternsOf(sdkBoundary)),
  door(under('packages/plugin-*'), patternsOf(pluginBoundary), [{ name: '@pneuma-base/kernel', importNames: DIRECT, message: DOOR }]),
  { ...door(under('packages/viewer'), patternsOf(viewerBoundary)), ignores: [...allowed, 'packages/viewer/src/server/agent.ts'] },
  door(['packages/viewer/src/server/agent.ts'], agentRoutesBoundary.rules['no-restricted-imports'][1].patterns, agentRoutesBoundary.rules['no-restricted-imports'][1].paths),
  door(under('packages/cli')),
  door(under('plugins/*', 'packages/cli/templates/*')),
]

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'tmp/**', 'dist-packages/**', '**/.local/**'] },
  // The plugins under plugins/ and the scaffold's templates are projects of their own, built and tested
  // where they run: only the storage door is checked here (and the parser for their TypeScript).
  ...[js.configs.recommended, ...tseslint.configs.recommended].map((c, i) => (i === 1 ? c : { ...c, ignores: [...(c.ignores ?? []), ...OWN_PROJECTS] })),
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
