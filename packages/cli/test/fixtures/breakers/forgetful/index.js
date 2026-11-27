// A plugin that keeps every rule but one: it learns what is registered only from the puts it hears and
// has no `catchUp`, so in a library it is added to later it knows nothing of what was put before it.
// The conformance check `catchup` must name it.
async function heardOf(records, path) {
  for (let cursor = null; ; ) {
    const page = await records.since(cursor, 1000)
    if (page === null) return false
    if (page.facts.some((f) => f.fact.heard === path)) return true
    if (!page.more) return false
    cursor = page.cursor
  }
}

export default {
  contract: 2,
  name: 'forgetful',
  cognition: null,
  storage: [{ dir: 'facts', kind: 'body' }],
  statements: [],
  ownerCommands: [],
  async onPut(req, ctx) {
    const paths = req.kind === 'register-files' ? req.files.map((f) => f.path) : [req.path]
    await ctx.tools.storage.records.append(paths.map((path) => ({ heard: path })))
    return null
  },
  async onItemView(path, ctx) {
    const heard = await heardOf(ctx.tools.storage.records, path)
    return { title: '听到过', blocks: [{ kind: 'text', text: heard ? '听到过它被放进来' : '没听到过它', tone: 'neutral' }] }
  },
}
