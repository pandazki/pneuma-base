// Plugins' credentials on this machine: `$PNEUMA_BASE_HOME/secrets/<plugin>/<name>`, one file per
// secret holding its value, readable only by the user. Outside every library, so no sync carries
// them. ARCHITECTURE "库外的插件与缓存".
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PLUGIN_NAME, SECRET_NAME, type PluginSecrets } from '@pneuma-base/sdk'

/** The most a secret's value may hold, in bytes. */
export const SECRET_LIMIT = 64 * 1024

export const secretsDir = (home: string, plugin: string) => join(home, 'secrets', plugin)

function fileOf(home: string, plugin: string, name: string): string {
  if (!PLUGIN_NAME.test(plugin)) throw new Error(`不是插件名：${plugin}`)
  if (!SECRET_NAME.test(name)) throw new Error(`不是密钥名（小写字母、数字和连字符，字母开头）：${name}`)
  return join(secretsDir(home, plugin), name)
}

export async function readSecret(home: string, plugin: string, name: string): Promise<string | null> {
  return readFile(fileOf(home, plugin, name), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

/** Writes the value under a temporary name, mode 0600 in directories of mode 0700, then renames it into place. */
export async function writeSecret(home: string, plugin: string, name: string, value: string): Promise<string> {
  const file = fileOf(home, plugin, name)
  const dir = secretsDir(home, plugin)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(join(home, 'secrets'), 0o700)
  await chmod(dir, 0o700)
  const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`)
  try {
    await writeFile(tmp, value, { mode: 0o600, flag: 'wx' })
    await chmod(tmp, 0o600)
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
  return file
}

/** The names of the secrets set for `plugin` on this machine, sorted. */
export async function secretNames(home: string, plugin: string): Promise<string[]> {
  if (!PLUGIN_NAME.test(plugin)) return []
  const names = await readdir(secretsDir(home, plugin)).catch(() => [] as string[])
  return names.filter((n) => SECRET_NAME.test(n)).sort()
}

/** Whether there was a value to remove. */
export async function removeSecret(home: string, plugin: string, name: string): Promise<boolean> {
  const file = fileOf(home, plugin, name)
  const had = (await readSecret(home, plugin, name)) !== null
  await rm(file, { force: true })
  return had
}

/**
 * What `ctx.secrets` is for `plugin`: its own secrets, read when asked; kept, only one it `declares`,
 * only in the context of its owner command (`command`), with the limits `secret set` has.
 */
export function pluginSecrets(home: string, plugin: string, declares: readonly string[], command: boolean): PluginSecrets {
  return {
    get: (name) => readSecret(home, plugin, name),
    async set(name, value) {
      if (!command) throw new Error(`插件 ${plugin} 只能在主人命令里存密钥，钩子和视图里不能`)
      if (!declares.includes(name)) throw new Error(`插件 ${plugin} 没有声明叫 ${name} 的密钥，不能存它`)
      if (value === '' || Buffer.byteLength(value) > SECRET_LIMIT) throw new Error(`密钥 ${name} 是空的，或长过 ${SECRET_LIMIT / 1024} KB，没有存`)
      await writeSecret(home, plugin, name, value)
    },
  }
}
