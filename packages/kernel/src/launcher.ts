// The one command on this machine: `$PNEUMA_BASE_HOME/bin/pneuma-base`, a small script that runs a
// named node program with a named entry file and exports the home it lives in. Whoever provides the
// command line keeps it current: the app at each launch, `launcher install` from the package. What
// agent connect writes names it by absolute path, so its path never changes, only its content.
// ARCHITECTURE.md sections 6 and 8.
import { realpathSync } from 'node:fs'
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { exists, scratchName } from './files.js'
import { command, done, type KernelCommand } from './kernel-command.js'
import type { Env } from './products.js'

/** How a pneuma-base runs from a program that has no shell profile: the node program and the command line's entry file. */
export type CommandLine = { node: string; entry: string }

/** What the launcher says: the command line it runs and the home it exports. */
export type Launcher = CommandLine & { home: string }

export const launcherPath = (home: string): string => join(home, 'bin', 'pneuma-base')

/** A word as sh takes it literally: single-quoted, a quote inside written as `'\''`. */
const shWord = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

function launcherText({ node, entry, home }: Launcher): string {
  return [
    '#!/bin/sh',
    '# 这台机器上的 pneuma-base。接上的 agent 按这个路径运行它，路径不变，内容由提供命令行的一方保持最新：',
    '# Pneuma Base 应用每次启动时，或 pneuma-base launcher install。',
    `PNEUMA_BASE_HOME=${shWord(home)}`,
    'export PNEUMA_BASE_HOME',
    `exec ${shWord(node)} ${shWord(entry)} "$@"`,
    '',
  ].join('\n')
}

/** The single-quoted words of a line written by `launcherText`; null for a line not written so. */
function shWords(line: string): string[] | null {
  const words = [...line.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => (m[1] as string).replaceAll(`'\\''`, "'"))
  return words.length === 0 ? null : words
}

/** What a launcher's text says, or null for a file this did not write. */
function parseLauncher(text: string): Launcher | null {
  const lines = text.split('\n')
  const home = shWords(lines.find((l) => l.startsWith('PNEUMA_BASE_HOME=')) ?? '')
  const run = shWords(lines.find((l) => l.startsWith('exec ')) ?? '')
  if (home?.length !== 1 || run?.length !== 2) return null
  return { home: home[0] as string, node: run[0] as string, entry: run[1] as string }
}

async function readLauncher(path: string): Promise<Launcher | null | 'missing'> {
  try {
    return parseLauncher(await readFile(path, 'utf8'))
  } catch {
    return 'missing'
  }
}

/**
 * What is wrong with the launcher at `path`, in words: missing, not one this wrote, what it runs gone,
 * or a home exported other than the one it lives in. Empty when it runs.
 */
export async function launcherProblems(path: string): Promise<string[]> {
  const l = await readLauncher(path)
  if (l === 'missing') return [`命令 ${path} 不在了`]
  if (l === null) return [`命令 ${path} 读不懂，不是 pneuma-base 写的`]
  return [
    ...((await exists(l.node)) ? [] : [`命令 ${path} 指向的 node 不在了（${l.node}）`]),
    ...((await exists(l.entry)) ? [] : [`命令 ${path} 指向的命令行不在了（${l.entry}）`]),
    ...(resolve(l.home) === resolve(path, '../..') ? [] : [`命令 ${path} 用的是另一个家目录（${l.home}）`]),
  ]
}

/**
 * This pneuma-base, as it runs now. A `node` on PATH that is this same program is written instead of
 * the program's own path, which a package manager may version and drop on the next upgrade.
 */
export function thisCommandLine(env: Env): CommandLine {
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return null
    }
  }
  const self = real(process.execPath)
  const linked = (env.PATH ?? '').split(delimiter).filter((dir) => dir !== '').map((dir) => join(dir, 'node')).find((path) => real(path) === self)
  return { node: linked ?? process.execPath, entry: resolve(process.argv[1] ?? '') }
}

export type Installed = { launcher: Launcher & { path: string }; changed: boolean }

/** Makes the launcher of `home` run `line`; writes only when it says something else. */
export async function installLauncher(home: string, line: CommandLine): Promise<Installed> {
  const path = launcherPath(home)
  const wanted: Launcher = { ...line, home }
  const text = launcherText(wanted)
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current !== text) {
    // Executable before it is renamed into place: an agent may run it at any moment.
    const tmp = await scratchName(dirname(path))
    try {
      await writeFile(tmp, text, { mode: 0o755 })
      await chmod(tmp, 0o755)
      await rename(tmp, path)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }
  return { launcher: { path, ...wanted }, changed: current !== text }
}

/** The launcher of `home`, left as it is when it runs, else made to run this command line. */
export async function ensureLauncher(home: string, env: Env): Promise<Installed> {
  const path = launcherPath(home)
  const current = await readLauncher(path)
  if (typeof current === 'object' && current !== null && (await launcherProblems(path)).length === 0) return { launcher: { path, ...current }, changed: false }
  return installLauncher(home, thisCommandLine(env))
}

/** The launcher in words: where it is and what it runs. */
export const ranText = ({ launcher: l }: Installed): string => `命令：${l.path}，运行 ${l.node} ${l.entry}`

export const launcherInstall: KernelCommand = command({
  name: 'launcher install',
  summary: '让这台机器上的 pneuma-base 命令（$PNEUMA_BASE_HOME/bin/pneuma-base）指向现在这个命令行；接上的 agent 都按它的路径运行',
  params: {},
  destructive: false,
  ownerOnly: true,
  scope: 'machine',
  async run(_values, call) {
    const installed = await installLauncher(call.ctx.home, thisCommandLine(call.env))
    const { path, node, entry, home } = installed.launcher
    const text = installed.changed ? `已写好 ${path}：运行 ${node} ${entry}，家目录 ${home}。接上的 agent 都按这个路径运行它。` : `${path} 已经指向这个命令行，没有改。`
    return done(text, installed)
  },
})
