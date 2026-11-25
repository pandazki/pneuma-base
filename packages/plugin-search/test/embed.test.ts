// The two embedders. hash: deterministic feature hashing, 256 dimensions, unit length. http: an
// OpenAI-compatible /v1/embeddings at the owner's address, with the key read from the variable the
// owner named, vectors in input order, and every failure a rejection that names what went wrong.
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { embedderFor, HASH_DIMENSIONS, httpEmbedder } from '../src/embed.js'

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * (b[i] as number), 0)

describe('the hash embedder', () => {
  const hash = embedderFor({ kind: 'hash' }, {})

  it('gives the same unit vector of 256 dimensions for the same text', async () => {
    const [a, b] = await hash.embed(['手冲咖啡豆和拿铁', '手冲咖啡豆和拿铁'])
    expect(a).toHaveLength(HASH_DIMENSIONS)
    expect(HASH_DIMENSIONS).toBe(256)
    expect(dot(a as Float32Array, a as Float32Array)).toBeCloseTo(1, 5)
    expect(a).toEqual(b)
  })

  it('puts a text nearer to one that shares its words or character pairs than to one that shares none', async () => {
    const [query, coffee, pets] = await hash.embed(['哪里能买到咖啡', '本店供应手冲咖啡豆，每周烘焙', '猫狗疫苗接种和日常体检'])
    expect(dot(query as Float32Array, coffee as Float32Array)).toBeGreaterThan(dot(query as Float32Array, pets as Float32Array))
  })
})

describe('the http embedder', () => {
  let server: Server | null = null
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())))

  async function serve(handler: (body: any, headers: Record<string, unknown>) => { status: number; body: unknown } | null): Promise<string> {
    server = createServer((req, res) => {
      let text = ''
      req.setEncoding('utf8').on('data', (d: string) => (text += d))
      req.on('end', () => {
        const answer = handler({ url: req.url, ...JSON.parse(text) }, req.headers)
        if (answer) res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body))
      })
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    return typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  }

  it('posts the model and the texts with the key from the named variable, and gives the vectors in input order', async () => {
    const seen: any[] = []
    const url = await serve((body, headers) => {
      seen.push({ url: body.url, model: body.model, input: body.input, authorization: headers.authorization })
      return { status: 200, body: { data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 4] }] } }
    })
    const embedder = embedderFor({ kind: 'http', url: `${url}/v1/`, model: 'm-1', keyEnv: 'MY_KEY' }, { MY_KEY: 'k-9' })
    const [first, second] = await embedder.embed(['one', 'two'])
    expect(seen).toEqual([{ url: '/v1/embeddings', model: 'm-1', input: ['one', 'two'], authorization: 'Bearer k-9' }])
    const rounded = (v: Float32Array | undefined) => [...(v ?? [])].map((x) => Number(x.toFixed(6)))
    expect(rounded(first)).toEqual([0.6, 0.8])
    expect(rounded(second)).toEqual([0, 1])
  })

  it('sends no request when the named key variable is not set', async () => {
    let asked = false
    const url = await serve(() => ((asked = true), { status: 200, body: { data: [] } }))
    await expect(embedderFor({ kind: 'http', url, model: 'm', keyEnv: 'MISSING_KEY' }, {}).embed(['x'])).rejects.toThrow('MISSING_KEY')
    expect(asked).toBe(false)
  })

  it('rejects an error status, an answer of the wrong shape, a server that is down, and one that does not answer in time', async () => {
    const url = await serve((body) => (body.input[0] === 'slow' ? null : body.input[0] === 'bad' ? { status: 200, body: { data: [{ index: 0 }] } } : { status: 401, body: { error: 'no' } }))
    const config = { kind: 'http' as const, url, model: 'm', keyEnv: null }
    await expect(embedderFor(config, {}).embed(['x'])).rejects.toThrow('401')
    await expect(embedderFor(config, {}).embed(['bad'])).rejects.toThrow('嵌入')
    await expect(httpEmbedder(config, {}, 200).embed(['slow'])).rejects.toThrow('没有答复')
    await expect(embedderFor({ ...config, url: 'http://127.0.0.1:9' }, {}).embed(['x'])).rejects.toThrow('连不上')
  })

  it('names its vectors by address and model, so changing either changes the embedder', () => {
    const a = embedderFor({ kind: 'http', url: 'http://127.0.0.1:1/v1', model: 'm', keyEnv: 'A' }, {})
    expect(embedderFor({ kind: 'http', url: 'http://127.0.0.1:1', model: 'm', keyEnv: 'B' }, {}).id).toBe(a.id)
    expect(embedderFor({ kind: 'http', url: 'http://127.0.0.1:1', model: 'n', keyEnv: 'A' }, {}).id).not.toBe(a.id)
    expect(embedderFor({ kind: 'hash' }, {}).id).not.toBe(a.id)
  })
})
