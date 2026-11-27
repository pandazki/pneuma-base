// A plugin that keeps every rule but one: on check it pages through every directory of the library to
// find what is there, as no plugin may. The conformance check `bounded` must name it.
async function walk(storage, dir) {
  for (let after; ; ) {
    const page = await storage.overview(dir, { limit: 1000, ...(after === undefined ? {} : { after }) })
    if (page.entries === undefined) return
    for (const e of page.entries) if (e.kind === 'dir') await walk(storage, e.place)
    if (page.more === null) return
    after = page.more.after
  }
}

export default {
  contract: 2,
  name: 'walker',
  cognition: null,
  storage: [],
  statements: [],
  ownerCommands: [],
  async onCheck(_req, ctx) {
    await walk(ctx.tools.storage, '')
    return []
  },
}
