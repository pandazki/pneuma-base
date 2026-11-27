// A plugin that looks at a directory nobody registered as the ledger does, with one budgeted probe of
// the directory itself, then breaks the rule: it probes a place below it and reads a file in it. The
// conformance check `bounded` must name the last two and not the first.
export default {
  contract: 2,
  name: 'peeker',
  cognition: null,
  storage: [],
  statements: [],
  ownerCommands: [],
  async onCheck(_req, ctx) {
    await ctx.tools.storage.probe('conformance-heap')
    await ctx.tools.storage.probe('conformance-heap/below')
    await ctx.tools.storage.read('conformance-heap/0.txt', { length: 16 })
    return []
  },
}
