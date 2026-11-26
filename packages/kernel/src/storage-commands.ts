// The storage commands, owner-only and of this machine: which providers it has, installing one from a
// repository's releases, removing one, updating one (tmp/run-7 architecture.md, 「存储的实现是可以安装的」;
// PROVIDERS.md). And the section of the configuration page that shows them, with their forms.
import { formOf, type Action, type Block, type Call, type Context, type Instant, type OwnerParams, type TableRow } from '@pneuma-base/sdk'
import { command, done, refused, type KernelCommand, type Outcome } from './kernel-command.js'
import type { OwnerCall } from './owner.js'
import { candidateOf, fetchManifest, installCandidate, parseRelease, RELEASE, type Candidate, type Refusal } from './provider-install.js'
import { installedProvider, librariesUsing, machineProviders, officialProviders, platformKey, providerOf, removeInstalled, type OfficialProvider, type Provider } from './providers.js'

const NAME = { name: 'name', hint: '提供者的名字', required: true } as const
const CHECKSUM = { name: 'checksum', hint: '看过、认下的程序的 sha256', kind: 'value', pattern: '(sha256:)?[0-9a-f]{64}' } as const
const REPOSITORY = { name: 'repository', hint: 'owner/repo[@版本]', required: true, pattern: RELEASE.source.slice(1, -1) } as const

const INSTALL_PARAMS = { positional: [REPOSITORY], flags: [CHECKSUM] } as const
const UPDATE_PARAMS = { positional: [NAME], flags: [CHECKSUM] } as const

const originText = (p: Provider) => (p.origin.kind === 'built-in' ? '自带' : `来自 ${p.origin.repository}`)

/** One provider in words: its name and version, where it came from, the addresses it answers; its program and checksum below. */
const providerLines = (p: Provider, usedHere: boolean) => [
  `${p.name} ${p.version} · ${[originText(p), ...(p.official ? ['官方'] : []), `地址：${p.addresses.join('、')}`, `契约 ${p.contract}`, ...(usedHere ? ['这个库用的'] : [])].join(' · ')}`,
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
  `存储提供者是一个以你的身份运行的程序，看得到库里的全部内容。${replacing ? `要把 ${replacing.name} ${replacing.version} 换成` : '要装的是'} ${repository} 的 ${version}，校验和 sha256:${sha256}。`

/**
 * Installs a candidate, or replaces the one installed. Third-party: the owner accepts the trust
 * statement first, in person, or by giving the checksum they were shown (`--checksum`); a refusal
 * otherwise carries the statement and the call that accepts it. Official: no statement.
 */
async function acquire(call: OwnerCall, c: Candidate, checksum: string | null, replacing: Provider | null, accept: (sha256: string) => { label: string; call: OwnerCallOf }): Promise<Outcome> {
  const { manifest, executable } = c
  const shown = statement(c.repository, manifest.version, executable.sha256, replacing)
  if (checksum !== null && checksum.replace(/^sha256:/, '') !== executable.sha256) {
    return refused('checksum-changed', `--checksum 写的是 ${checksum}，${c.repository} 的 ${manifest.version} 现在是 sha256:${executable.sha256}。`)
  }
  if (!c.official && checksum === null && !(await call.confirm(`${shown}确认吗？`))) {
    const offer = accept(executable.sha256)
    const typed = [offer.call.command, ...offer.call.args.positional, '--checksum', executable.sha256].join(' ')
    return {
      answer: { outcome: 'refused', reason: 'not-confirmed', text: `${shown}\n认下了就运行：pneuma-base ${typed}`, offer: { label: offer.label, tone: 'default', confirm: shown, inputs: [], call: offer.call } },
    }
  }
  const r = await installCandidate(call.ctx.home, call.env, c, new Date().toISOString() as Instant)
  if ('reason' in r) return refused(r.reason, `没有${replacing ? '换' : '装'}：${r.text}`)
  const p = r.provider
  const suite = `契约测试：${r.vetted.met} 项过${r.vetted.notExercised > 0 ? `，${r.vetted.notExercised} 项这台机器上试不出` : ''}。`
  const head = replacing ? `已把存储提供者 ${p.name} 从 ${replacing.version} 换成 ${p.version}` : `已装上存储提供者 ${p.name} ${p.version}`
  return done(`${head}（来自 ${c.repository}，地址：${p.addresses.join('、')}，契约 ${p.contract}）。${suite}`, { provider: p, vetted: r.vetted })
}

/** The official entry for a repository, when the list names one that is not built in. */
const officialFor = (repository: string): OfficialProvider | undefined => officialProviders().find((o) => !o.builtIn && o.repository.toLowerCase() === repository.toLowerCase())

/** The release an official provider pins: the list's version, with the list's checksum for this platform, which the manifest must carry too. */
function officialCandidate(o: OfficialProvider, c: Candidate | Refusal): Candidate | Refusal {
  if ('reason' in c) return c
  const listed = o.sha256[platformKey()]
  if (listed === undefined) return { reason: 'no-executable', text: `官方名单里的 ${o.name} 没有给这台机器（${platformKey()}）的程序` }
  if (listed !== c.executable.sha256) return { reason: 'checksum', text: `${o.repository} 的 ${c.manifest.version} 写的校验和是 sha256:${c.executable.sha256}，官方名单写的是 sha256:${listed}` }
  return c
}

const storageInstall = command({
  name: 'storage install',
  summary: '从一个 GitHub 仓库的发布装一个存储提供者到这台机器：取本平台的程序，钉在一个版本上，对校验和，过了契约测试才装',
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
    if (own) return refused('built-in', `${own.name} 是这个 pneuma-base 自带的，随它更新。`)
    const official = officialFor(release.repository)
    const pinned = official && (release.tag === null || release.tag === official.version) ? official : undefined
    const manifest = await fetchManifest(call.env, pinned ? { repository: release.repository, tag: pinned.version } : release)
    if ('reason' in manifest) return refused(manifest.reason, `没有装：${manifest.text}`)
    const c = pinned ? officialCandidate(pinned, candidateOf(release.repository, manifest, true)) : candidateOf(release.repository, manifest, false)
    if ('reason' in c) return refused(c.reason, `没有装：${c.text}`)
    const builtIn = officialProviders().find((o) => o.builtIn && o.name === manifest.name)
    if (builtIn) return refused('built-in', `${manifest.name} 是这个 pneuma-base 自带的提供者的名字。`)
    const there = installedProvider(call.ctx.home, manifest.name)
    if (there?.origin.kind === 'repository' && there.origin.repository.toLowerCase() !== release.repository.toLowerCase()) {
      return refused('name-taken', `这台机器上已有叫 ${manifest.name} 的存储提供者，来自 ${there.origin.repository}。先 pneuma-base storage remove ${manifest.name}。`)
    }
    if (there?.version === manifest.version) return done(`${there.name} ${there.version} 已经装着。`, { provider: there })
    const tagged = `${release.repository}@${manifest.version}`
    return acquire(call, c, checksum, there, (sha256) => ({ label: '安装', call: ownerForm('storage install', INSTALL_PARAMS, { repository: tagged, checksum: sha256 }) }))
  },
})

const storageUpdate = command({
  name: 'storage update',
  summary: '把一个装上来的存储提供者换成新的版本：第三方的取仓库最新的发布，官方的取名单里的版本；同样先对校验和、过契约测试',
  params: UPDATE_PARAMS,
  destructive: false,
  ownerOnly: true,
  setup: true,
  askable: false,
  scope: 'machine',
  async run({ name, checksum }, call) {
    if (officialProviders().some((o) => o.builtIn && o.name === name)) return refused('built-in', `${name} 是这个 pneuma-base 自带的，随它更新。`)
    const there = installedProvider(call.ctx.home, name)
    if (there === null || there.origin.kind !== 'repository') return refused('not-installed', `这台机器没装叫 ${name} 的存储提供者。`)
    const { repository } = there.origin
    const official = there.official ? officialFor(repository) : undefined
    const manifest = await fetchManifest(call.env, { repository, tag: official ? official.version : null })
    if ('reason' in manifest) return refused(manifest.reason, `没有换：${manifest.text}`)
    if (manifest.name !== name) return refused('name-changed', `没有换：${repository} 现在的发布是 ${manifest.name}，不是 ${name}。`)
    if (manifest.version === there.version) return done(`${name} 已经是 ${there.version}。`, { provider: there })
    const c = official ? officialCandidate(official, candidateOf(repository, manifest, true)) : candidateOf(repository, manifest, false)
    if ('reason' in c) return refused(c.reason, `没有换：${c.text}`)
    return acquire(call, c, checksum, there, (sha256) => ({ label: '换上', call: ownerForm('storage update', UPDATE_PARAMS, { name, checksum: sha256 }) }))
  },
})

const storageRemove = command({
  name: 'storage remove',
  summary: '从这台机器卸掉一个装上来的存储提供者',
  params: { positional: [NAME] },
  destructive: false,
  ownerOnly: true,
  setup: true,
  scope: 'machine',
  async run({ name }, call) {
    if (officialProviders().some((o) => o.builtIn && o.name === name)) return refused('built-in', `${name} 是这个 pneuma-base 自带的，卸不掉。`)
    const there = installedProvider(call.ctx.home, name)
    if (there === null) {
      const names = (await machineProviders(call.ctx.home)).filter((p) => p.origin.kind === 'repository').map((p) => p.name)
      return refused('not-installed', `这台机器没装叫 ${name} 的存储提供者。装上来的：${names.join('、') || '无'}`)
    }
    const users = librariesUsing(call.ctx.home, name)
    await removeInstalled(call.ctx.home, name)
    return done(`已卸下存储提供者 ${name} ${there.version}。${users.length === 0 ? '' : `\n用它的库：${users.join('、')}`}`, { provider: there, libraries: users })
  },
})

const storageList = command({
  name: 'storage list',
  summary: '这台机器上的存储提供者：自带的和装上来的，各自的版本、来历、答哪种地址、程序和校验和；还有官方的、没装的',
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
      ...(official.length === 0 ? [] : ['官方的、没装的：', ...official.map((o) => `  ${o.name} ${o.version ?? ''} · 地址：${o.addresses.join('、')} · ${installLine(o)}`)]),
    ]
    return done(lines.join('\n'), { providers, official, library })
  },
})

export const STORAGE_COMMANDS: readonly KernelCommand[] = [storageList, storageInstall, storageRemove, storageUpdate]

/** The configuration page's section: this machine's providers, the one this library uses, the official ones not installed, each with the command that changes it as a form. */
export async function storageSection(ctx: Context): Promise<Block> {
  const providers = await machineProviders(ctx.home)
  const used = providerOf(ctx.library.root, ctx.home).name
  const rows: TableRow[] = providers.map((p) => ({
    key: p.name,
    cells: {
      name: { text: p.name, mono: true },
      version: { text: p.version, mono: true },
      origin: { text: originText(p) },
      addresses: { text: p.addresses.join('、'), mono: true },
      state: { text: '', tag: p.name === used ? { text: '这个库用的', tone: 'good' } : { text: '装着', tone: 'neutral' } },
    },
    link: null,
    actions:
      p.origin.kind === 'built-in'
        ? []
        : [
            { label: '换新版本', tone: 'default', confirm: null, inputs: [], call: ownerForm('storage update', UPDATE_PARAMS, { name: p.name }) },
            { label: '卸掉', tone: 'danger', confirm: `从这台机器卸掉存储提供者 ${p.name}？用它的库要再装上它才能打开。`, inputs: [], call: ownerForm('storage remove', { positional: [NAME] }, { name: p.name }) },
          ],
  }))
  const official: TableRow[] = notInstalled(providers).map((o) => ({
    key: `official:${o.name}`,
    cells: {
      name: { text: o.name, mono: true },
      version: o.version === null ? { text: '—', muted: true } : { text: o.version, mono: true },
      origin: { text: `官方，${o.repository}` },
      addresses: { text: o.addresses.join('、'), mono: true },
      state: { text: '', tag: { text: '没装', tone: 'neutral' } },
    },
    link: null,
    actions: [{ label: '装上', tone: 'default', confirm: null, inputs: [], call: ownerForm('storage install', INSTALL_PARAMS, { repository: o.repository }) }],
  }))
  const { inputs, call } = formOf({ name: 'storage install', params: INSTALL_PARAMS })
  const other: Action = { label: '安装别的存储…', tone: 'default', confirm: null, inputs: inputs.filter((i) => i.name === 'repository'), call: { ...call, args: { positional: call.args.positional, flags: {} } } }
  return {
    kind: 'section',
    title: '存储',
    note: '存储提供者是一个以你的身份运行的程序，看得到库里的全部内容。库用哪一个，记在这台机器上。',
    count: providers.length,
    blocks: [
      {
        kind: 'table',
        columns: [{ key: 'name', label: '名字' }, { key: 'version', label: '版本', optional: true }, { key: 'origin', label: '来历' }, { key: 'addresses', label: '地址', optional: true }, { key: 'state', label: '状态' }],
        rows: [...rows, ...official],
        empty: '',
      },
    ],
    actions: [other],
  }
}
