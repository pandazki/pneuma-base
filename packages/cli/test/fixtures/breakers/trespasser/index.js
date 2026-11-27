// A plugin that keeps every rule but one: on check it writes into a record place that is not its own,
// the kernel's `requests`, through the tool that reads other record places: a fact appended and a file
// of its own content. The tool must refuse both, so nothing outside its own record place changes.
export default {
  contract: 2,
  name: 'trespasser',
  cognition: null,
  storage: [],
  statements: [],
  ownerCommands: [],
  async onCheck(_req, ctx) {
    const other = ctx.tools.storage.recordPlace('requests')
    const tries = [
      () => other.facts.append([{ request: 'r-00000000', kind: 'withdrawn', at: ctx.now }]),
      () => other.own.write('planted.txt', { data: 'x' }, 'empty'),
    ]
    const refused = []
    for (const attempt of tries) {
      try {
        await attempt()
      } catch (error) {
        refused.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (refused.length > 0) throw new Error(`没能写别的记录处：${refused.join('；')}`)
    return []
  },
}
