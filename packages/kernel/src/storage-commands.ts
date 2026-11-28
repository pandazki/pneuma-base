// The storage commands, owner-only and of this machine: which providers it has, installing one from a
// repository's releases, removing one, updating one (ARCHITECTURE.md「存储」;
// PROVIDERS.md). And the section of the configuration page that shows them, with their forms.
import { formOf, type Action, type Block, type Call, type Context, type Instant, type ListItem, type OwnerParams } from '@pneuma-base/sdk'
import { command, done, refused, type KernelCommand, type Outcome } from './kernel-command.js'
import type { OwnerCall } from './owner.js'
import { candidateOf, fetchManifest, installCandidate, parseRelease, RELEASE, type Candidate, type Refusal } from './provider-install.js'
import { installedProvider, librariesUsing, machineProviders, officialProviders, platformKey, providerOf, removeInstalled, type OfficialProvider, type Provider } from './providers.js'

const NAME = { name: 'name', hint: '提供者名称', required: true } as const
const CHECKSUM = { name: 'checksum', hint: '已核对并确认的程序 sha256', kind: 'value', pattern: '(sha256:)?[0-9a-f]{64}' } as const
const REPOSITORY = { name: 'repository', hint: 'owner/repo[@版本]', required: true, pattern: RELEASE.source.slice(1, -1) } as const

const INSTALL_PARAMS = { positional: [REPOSITORY], flags: [CHECKSUM] } as const
const UPDATE_PARAMS = { positional: [NAME], flags: [CHECKSUM] } as const

const originText = (p: Provider) => (p.origin.kind === 'built-in' ? '内置' : `来自 ${p.origin.repository}`)

/** One provider in words: its name and version, where it came from, the addresses it answers; its program and checksum below. */
const providerLines = (p: Provider, usedHere: boolean) => [
  `${p.name} ${p.version} · ${[originText(p), ...(p.official ? ['官方'] : []), `地址：${p.addresses.join('、')}`, `契约 ${p.contract}`, ...(usedHere ? ['此资料库使用中'] : [])].join(' · ')}`,
  `    程序：${p.executable}`,
  `    校验和：sha256:${p.sha256}`,
]

/** The official providers this machine does not have, as the list in the package names them. */
const notInstalled = (providers: readonly Provider[]): OfficialProvider[] => officialProviders().filter((o) => !o.builtIn && !providers.some((p) => p.name === o.name))

const installLine = (o: OfficialProvider) => `pneuma-base storage install ${o.repository}`

/** Which provider the library at hand uses, when there is one; null for a provider this machine does not have. */
function libraryOf(call: OwnerCall): { address: string; provider: string | null } | null {
  const library = call.ctx.library
  if (library === null) return null
  try {
    return { address: library.root, provider: providerOf(library.root, call.ctx.home).name }
  } catch {
    return { address: library.root, provider: null }
  }
}

type OwnerCallOf = Extract<Call, { face: 'owner' }>

/** The call of a kernel command with every value given, as its form makes it: no input is left to fill. */
function ownerForm(name: string, params: OwnerParams, fixed: Record<string, string>): OwnerCallOf {
  const { call } = formOf({ name, params }, { fixed })
  const flags = Object.fromEntries(Object.entries(call.args.flags).filter(([flag]) => flag in fixed))
  return { ...call, args: { positional: call.args.positional, flags } }
}

const statement = (repository: string, version: string, sha256: string, replacing: Provider | null) =>
  `存储提供者是以当前用户身份运行的程序，可访问资料库中的全部内容。${replacing ? `将 ${replacing.name} ${replacing.version} 更新为` : '将安装'} ${repository} 的 ${version}，校验和 sha256:${sha256}。`

/**
 * Installs a candidate, or replaces the one installed. Third-party: the owner accepts the trust
 * statement first, in person, or by giving the checksum they were shown (`--checksum`); a refusal
 * otherwise carries the statement and the call that accepts it. Official: no statement.
 */
async function acquire(call: OwnerCall, c: Candidate, checksum: string | null, replacing: Provider | null, accept: (sha256: string) => { label: string; call: OwnerCallOf }): Promise<Outcome> {
  const { manifest, executable } = c
  const shown = statement(c.repository, manifest.version, executable.sha256, replacing)
  if (checksum !== null && checksum.replace(/^sha256:/, '') !== executable.sha256) {
    return refused('checksum-changed', `--checksum 为 ${checksum}，${c.repository} 的 ${manifest.version} 当前为 sha256:${executable.sha256}。`)
  }
  if (!c.official && checksum === null && !(await call.confirm(`${shown}确认？`))) {
    const offer = accept(executable.sha256)
    const typed = [offer.call.command, ...offer.call.args.positional, '--checksum', executable.sha256].join(' ')
    return {
      answer: { outcome: 'refused', reason: 'not-confirmed', text: `${shown}\n确认后运行：pneuma-base ${typed}`, offer: { label: offer.label, tone: 'default', confirm: shown, inputs: [], call: offer.call } },
    }
  }
  const r = await installCandidate(call.ctx.home, call.env, c, new Date().toISOString() as Instant)
  if ('reason' in r) return refused(r.reason, `${replacing ? '更新' : '安装'}失败：${r.text}`)
  const p = r.provider
  const suite = `契约测试：${r.vetted.met} 项通过${r.vetted.notExercised > 0 ? `，${r.vetted.notExercised} 项无法在本机测试` : ''}。`
  const head = replacing ? `已将存储提供者 ${p.name} 从 ${replacing.version} 更新为 ${p.version}` : `已安装存储提供者 ${p.name} ${p.version}`
  return done(`${head}（来自 ${c.repository}，地址：${p.addresses.join('、')}，契约 ${p.contract}）。${suite}`, { provider: p, vetted: r.vetted })
}

/** The official entry for a repository, when the list names one that is not built in. */
const officialFor = (repository: string): OfficialProvider | undefined => officialProviders().find((o) => !o.builtIn && o.repository.toLowerCase() === repository.toLowerCase())

/** The release an official provider pins: the list's version, with the list's checksum for this platform, which the manifest must carry too. */
function officialCandidate(o: OfficialProvider, c: Candidate | Refusal): Candidate | Refusal {
  if ('reason' in c) return c
  const listed = o.sha256[platformKey()]
  if (listed === undefined) return { reason: 'no-executable', text: `官方名单中的 ${o.name} 没有适用于本机（${platformKey()}）的程序` }
  if (listed !== c.executable.sha256) return { reason: 'checksum', text: `${o.repository} 的 ${c.manifest.version} 声明的校验和为 sha256:${c.executable.sha256}，官方名单中为 sha256:${listed}` }
  return c
}

const storageInstall = command({
  name: 'storage install',
  act: { kind: 'installed', object: 'repository' },
  summary: '从 GitHub 仓库的发布版本安装存储提供者到本机：下载本平台的程序，固定版本，核对校验和，通过契约测试后安装',
  params: INSTALL_PARAMS,
  destructive: false,
  ownerOnly: true,
  setup: true,
  // The trust statement is the owner's to read and accept, in person.
  askable: false,
  scope: 'machine',
  async run({ repository: spec, checksum }, call) {
    const release = parseRelease(spec) as NonNullable<ReturnType<typeof parseRelease>>
    const own = officialProviders().find((o) => o.builtIn && o.repository.toLowerCase() === release.repository.toLowerCase())
    if (own) return refused('built-in', `${own.name} 是此 pneuma-base 内置的存储提供者，随 pneuma-base 更新。`)
    const official = officialFor(release.repository)
    const pinned = official && (release.tag === null || release.tag === official.version) ? official : undefined
    const manifest = await fetchManifest(call.env, pinned ? { repository: release.repository, tag: pinned.version } : release)
    if ('reason' in manifest) return refused(manifest.reason, `安装失败：${manifest.text}`)
    const c = pinned ? officialCandidate(pinned, candidateOf(release.repository, manifest, true)) : candidateOf(release.repository, manifest, false)
    if ('reason' in c) return refused(c.reason, `安装失败：${c.text}`)
    const builtIn = officialProviders().find((o) => o.builtIn && o.name === manifest.name)
    if (builtIn) return refused('built-in', `${manifest.name} 是此 pneuma-base 内置存储提供者的名称。`)
    const there = installedProvider(call.ctx.home, manifest.name)
    if (there?.origin.kind === 'repository' && there.origin.repository.toLowerCase() !== release.repository.toLowerCase()) {
      return refused('name-taken', `本机已有名为 ${manifest.name} 的存储提供者，来自 ${there.origin.repository}。请先运行 pneuma-base storage remove ${manifest.name}。`)
    }
    if (there?.version === manifest.version) return done(`${there.name} ${there.version} 已安装。`, { provider: there })
    const tagged = `${release.repository}@${manifest.version}`
    return acquire(call, c, checksum, there, (sha256) => ({ label: '安装', call: ownerForm('storage install', INSTALL_PARAMS, { repository: tagged, checksum: sha256 }) }))
  },
})

const storageUpdate = command({
  name: 'storage update',
  act: { kind: 'changed', object: 'name' },
  summary: '将已安装的存储提供者更新到新版本：第三方提供者取仓库的最新发布版本，官方提供者取名单中的版本；同样先核对校验和并通过契约测试',
  params: UPDATE_PARAMS,
  destructive: false,
  ownerOnly: true,
  setup: true,
  askable: false,
  scope: 'machine',
  async run({ name, checksum }, call) {
    if (officialProviders().some((o) => o.builtIn && o.name === name)) return refused('built-in', `${name} 是此 pneuma-base 内置的存储提供者，随 pneuma-base 更新。`)
    const there = installedProvider(call.ctx.home, name)
    if (there === null || there.origin.kind !== 'repository') return refused('not-installed', `本机未安装名为 ${name} 的存储提供者。`)
    const { repository } = there.origin
    const official = there.official ? officialFor(repository) : undefined
    const manifest = await fetchManifest(call.env, { repository, tag: official ? official.version : null })
    if ('reason' in manifest) return refused(manifest.reason, `更新失败：${manifest.text}`)
    if (manifest.name !== name) return refused('name-changed', `更新失败：${repository} 当前的发布版本为 ${manifest.name}，而非 ${name}。`)
    if (manifest.version === there.version) return done(`${name} 已是 ${there.version}。`, { provider: there })
    const c = official ? officialCandidate(official, candidateOf(repository, manifest, true)) : candidateOf(repository, manifest, false)
    if ('reason' in c) return refused(c.reason, `更新失败：${c.text}`)
    return acquire(call, c, checksum, there, (sha256) => ({ label: '更新', call: ownerForm('storage update', UPDATE_PARAMS, { name, checksum: sha256 }) }))
  },
})

const storageRemove = command({
  name: 'storage remove',
  act: { kind: 'uninstalled', object: 'name' },
  summary: '从本机卸载已安装的存储提供者',
  params: { positional: [NAME] },
  destructive: false,
  ownerOnly: true,
  setup: true,
  scope: 'machine',
  async run({ name }, call) {
    if (officialProviders().some((o) => o.builtIn && o.name === name)) return refused('built-in', `${name} 是此 pneuma-base 内置的存储提供者，无法卸载。`)
    const there = installedProvider(call.ctx.home, name)
    if (there === null) {
      const names = (await machineProviders(call.ctx.home)).filter((p) => p.origin.kind === 'repository').map((p) => p.name)
      return refused('not-installed', `本机未安装名为 ${name} 的存储提供者。已安装：${names.join('、') || '无'}`)
    }
    const users = librariesUsing(call.ctx.home, name)
    await removeInstalled(call.ctx.home, name)
    return done(`已卸载存储提供者 ${name} ${there.version}。${users.length === 0 ? '' : `\n使用该提供者的资料库：${users.join('、')}`}`, { provider: there, libraries: users })
  },
})

const storageList = command({
  name: 'storage list',
  summary: '本机的存储提供者：内置和已安装的提供者，及其版本、来源、支持的地址类型、程序和校验和；以及未安装的官方提供者',
  params: {},
  destructive: false,
  ownerOnly: true,
  readOnly: true,
  scope: 'machine',
  async run(_values, call) {
    const providers = await machineProviders(call.ctx.home)
    const library = libraryOf(call)
    const official = notInstalled(providers)
    const lines = [
      ...providers.flatMap((p) => providerLines(p, library?.provider === p.name)),
      ...(official.length === 0 ? [] : ['官方（未安装）：', ...official.map((o) => `  ${o.name} ${o.version ?? ''} · 地址：${o.addresses.join('、')} · ${installLine(o)}`)]),
    ]
    return done(lines.join('\n'), { providers, official, library })
  },
})

export const STORAGE_COMMANDS: readonly KernelCommand[] = [storageList, storageInstall, storageRemove, storageUpdate]

/**
 * The configuration page's section: one row saying where this library is kept, its folder on this
 * machine and the provider in use; behind the row's 「···」 the other providers' actions (an official
 * one not installed, updating or removing an installed one) and installing another from a repository.
 * Installing a third-party provider is refused until the owner accepts the trust statement, which the
 * refusal carries as an offer with the checksum. `inside` goes under the row, such as the library's noise.
 */
export async function storageSection(ctx: Context, inside: Block[] = []): Promise<Block> {
  const providers = await machineProviders(ctx.home)
  const official = officialProviders()
  let used: string | null = null
  try {
    used = providerOf(ctx.library.root, ctx.home).name
  } catch {
    used = null
  }
  const install = (o: OfficialProvider): Action => ({ label: `安装 ${o.summary}`, tone: 'default', confirm: null, inputs: [], call: ownerForm('storage install', INSTALL_PARAMS, { repository: o.repository }), as: 'menu', icon: 'plus' })
  const installed = providers.filter((p) => p.origin.kind !== 'built-in')
  const { inputs, call } = formOf({ name: 'storage install', params: INSTALL_PARAMS })
  const actions: Action[] = [
    ...notInstalled(providers).map(install),
    ...installed.map((p): Action => ({ label: `更新 ${p.name}`, tone: 'default', confirm: null, inputs: [], call: ownerForm('storage update', UPDATE_PARAMS, { name: p.name }), as: 'menu', icon: 'arrow-down-to-line' })),
    { label: '安装其他存储…', tone: 'default', confirm: null, inputs: inputs.filter((i) => i.name === 'repository'), call: { ...call, args: { positional: call.args.positional, flags: {} } }, as: 'menu', icon: 'folder-plus' },
    ...installed.map((p): Action => ({ label: `卸载 ${p.name}`, tone: 'danger', confirm: `卸载存储提供者 ${p.name}？使用该提供者的资料库在本机将无法打开，直到重新安装。`, inputs: [], call: ownerForm('storage remove', { positional: [NAME] }, { name: p.name }), icon: 'trash-2' })),
  ]
  const where: ListItem = {
    cell: { text: ctx.library.root, local: true, icon: 'folder' },
    note: used === null ? null : (official.find((o) => o.name === used)?.summary ?? used),
    actions,
  }
  return {
    kind: 'section',
    title: '存储',
    note: null,
    about: '存储提供者以当前用户身份运行，可访问资料库中的全部内容。资料库使用的存储提供者记录在本机。',
    count: null,
    blocks: [{ kind: 'list', items: [where] }, ...inside],
    actions: [],
  }
}
