// Where sites go: a local directory, `<to>/<site>/`. This is the place to put a real target. Keep the
// adapter's shape and replace configure, open and the target's publish and remove with calls to the
// service; a token goes in `secrets` and is read with env.secret(name), never from a flag.
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineTarget, STATUS, switchAction, type Target } from '@pneuma-base/sdk/kit'

export const localTarget = defineTarget({
  kind: 'local',
  label: '本地文件夹',
  icon: 'folder',
  params: [{ name: 'to', hint: '目录', kind: 'value', required: true }],

  /** What the owner's `target set` flags configure, checked before it is stored. */
  async configure({ to }, ctx) {
    const dir = resolve(ctx.session.cwd, to)
    if ((await ctx.tools.resolve(dir)) !== null) return { ok: false, reason: 'inside-library', text: `发布目录不能位于资料库中：${dir}` }
    return { ok: true, config: { to: dir } }
  },

  /** A stored configuration, parsed at the boundary, opened for one hook or command. */
  open(config, env): Target {
    if (typeof config.to !== 'string') throw new Error('本地目录的配置缺少 to')
    const to = config.to
    return {
      key: `local:${to}`,
      label: to,
      local: true,
      /** Copies the site beside its place under a temporary name, then swaps it in. */
      async publish(site, dir) {
        await mkdir(to, { recursive: true })
        const tmp = join(to, `.tmp-${site}-${process.pid}-${Date.now()}`)
        await cp(dir, tmp, { recursive: true })
        await rm(join(to, site), { recursive: true, force: true })
        await rename(tmp, join(to, site))
        return { url: pathToFileURL(join(to, site, '/')).href }
      },
      async remove(site) {
        await rm(join(to, site), { recursive: true, force: true })
      },
      view: {
        /**
         * A panel of the plugin's own after the kit's sections on its page: each declared thing with the
         * kit's state tag and switch, so the panel says and does what the page's rows do.
         */
        page: (all) => [
          {
            kind: 'custom',
            entry: 'panel.html',
            height: 72,
            // What the panel shows, in words: the command line prints it, and screen readers read it.
            text: [`${all.filter((l) => l.status === 'online').length} / ${all.length} 在线，发布到 ${to}`, ...all.map((l) => `${l.thing.path}：${STATUS[l.status].text}`)].join('\n'),
            data: { to, online: all.filter((l) => l.status === 'online').length, things: all.map((l) => ({ key: l.thing.id, path: l.thing.path, state: STATUS[l.status] })) },
            actions: Object.fromEntries(
              all.flatMap((l) => {
                const action = switchAction(env.plugin, l)
                return action === null ? [] : [[l.thing.id, action]]
              }),
            ),
          },
        ],
      },
    }
  },
})
