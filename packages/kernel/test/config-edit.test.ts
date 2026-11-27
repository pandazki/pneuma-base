// Another program's configuration is edited as text: an entry goes in, every other byte stays, and
// taking the entry out gives back the file as it was, byte for byte.
import { describe, expect, it } from 'vitest'
import { addJsonEntry, appendToml, jsonEntry, removeJsonEntry, removeToml, replaceJsonEntry, tomlBlock, tomlState } from '../src/config-edit.js'

const VALUE = { command: '/opt/node', args: ['/opt/pb/bin.js', '@cursor', 'mcp'], env: { PNEUMA_BASE_HOME: '/h/.pneuma-base' } }

const JSON_FILES: Record<string, string> = {
  'two-space, other servers': '{\n  "mcpServers": {\n    "other": {\n      "command": "x"\n    }\n  }\n}\n',
  'no servers key, four spaces, no final newline': '{\n    "globalShortcut": "",\n    "preferences": { "x": true }\n}',
  'tabs, CRLF': '{\r\n\t"theme": "dark",\r\n\t"mcpServers": {\r\n\t\t"a": {"command": "a"}\r\n\t}\r\n}\r\n',
  'minified with empty servers': '{"mcpServers":{}}',
  'empty object': '{}\n',
  'empty object with inner space': '{  }',
  'servers first of several, odd spacing': '{ "mcpServers" : { "a" : { "command" : "a" } , "b":{"command":"b"} },"z":1 }',
  'numbers JSON.parse would rewrite, integer keys, unicode': '{"big": 12345678901234567890, "f": 2.50, "e": 1e3, "1": "one", "名字": "\\u4e2d", "mcpServers": {\n  "x": {}\n}}\n',
}

describe('a JSON entry', () => {
  it('goes in and comes out leaving the file byte for byte, however the file is written', () => {
    for (const [label, text] of Object.entries(JSON_FILES)) {
      const added = addJsonEntry(text, 'mcpServers', 'pneuma-base-cursor', VALUE)
      if (added.outcome !== 'added') throw new Error(`${label}: ${JSON.stringify(added)}`)
      const parsed = JSON.parse(added.text) as { mcpServers: Record<string, unknown> }
      expect(parsed.mcpServers['pneuma-base-cursor'], label).toEqual(VALUE)
      expect(jsonEntry(added.text, 'mcpServers', 'pneuma-base-cursor'), label).toEqual({ outcome: 'found', value: VALUE })
      // Everything the file had is still there, in the same order.
      expect(Object.keys(parsed).filter((k) => k !== 'mcpServers'), label).toEqual(Object.keys(JSON.parse(text) as object).filter((k) => k !== 'mcpServers'))
      expect(removeJsonEntry(added.text, 'mcpServers', 'pneuma-base-cursor', added), label).toBe(text)
    }
  })

  it('creates a file that did not exist, and taking the entry out leaves an empty object', () => {
    const added = addJsonEntry(null, 'mcpServers', 'pneuma-base-x', VALUE)
    if (added.outcome !== 'added') throw new Error('not added')
    expect(added.created).toBe('file')
    expect(JSON.parse(added.text)).toEqual({ mcpServers: { 'pneuma-base-x': VALUE } })
    expect(removeJsonEntry(added.text, 'mcpServers', 'pneuma-base-x', added)).toBe('{}\n')
  })

  it('takes out only its own entry when the owner added another server after it', () => {
    const added = addJsonEntry(JSON_FILES['empty object'] as string, 'mcpServers', 'mine', VALUE)
    if (added.outcome !== 'added') throw new Error('not added')
    const more = added.text.replace('"mine":', '"theirs": {"command": "t"},\n    "mine":')
    expect(JSON.parse(removeJsonEntry(more, 'mcpServers', 'mine', added))).toEqual({ mcpServers: { theirs: { command: 't' } } })
  })

  it('finds an entry of that name already there instead of adding a second, and refuses a file it cannot read as one JSON object', () => {
    expect(addJsonEntry('{"mcpServers": {"mine": {"command": "z"}}}', 'mcpServers', 'mine', VALUE)).toEqual({ outcome: 'present', value: { command: 'z' } })
    for (const text of ['', '// comment\n{}', '[1]', '{"a": 1,}', '{"mcpServers": []}', '{"mcpServers": {}, "mcpServers": {}}', '{"mcpServers": {"m": 1, "m": 2}}']) {
      expect(addJsonEntry(text, 'mcpServers', 'm', VALUE).outcome, text).toBe('unreadable')
    }
  })

  it('replaces only the value of its entry', () => {
    const text = '{\n  "mcpServers": {\n    "a": 1,\n    "mine": {"command": "old"}\n  },\n  "z": 2\n}\n'
    const replaced = replaceJsonEntry(text, 'mcpServers', 'mine', VALUE)
    expect(JSON.parse(replaced)).toEqual({ mcpServers: { a: 1, mine: VALUE }, z: 2 })
    expect(replaced.startsWith('{\n  "mcpServers": {\n    "a": 1,\n    "mine": ')).toBe(true)
    expect(replaced.endsWith('\n  },\n  "z": 2\n}\n')).toBe(true)
  })
})

const COMMAND = { command: '/opt/node', args: ['/opt/pb/bin.js', '@codex', 'mcp'], env: { PNEUMA_BASE_HOME: '/h/.pneuma-base' } }

describe('a TOML table', () => {
  const block = tomlBlock('mcp_servers', 'pneuma-base-codex', COMMAND)

  it('is written as Codex writes one, appended to whatever the file holds and removed by exact match', () => {
    expect(block).toBe(
      '[mcp_servers.pneuma-base-codex]\ncommand = "/opt/node"\nargs = ["/opt/pb/bin.js", "@codex", "mcp"]\n\n[mcp_servers.pneuma-base-codex.env]\nPNEUMA_BASE_HOME = "/h/.pneuma-base"\n',
    )
    for (const text of [null, '', 'model = "o3"\n', '# a comment\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "x"   # trailing\n', 'model = "o3"']) {
      const label = JSON.stringify(text)
      const added = appendToml(text, 'mcp_servers', 'pneuma-base-codex', block)
      if (added.outcome !== 'added') throw new Error(`${label}: ${JSON.stringify(added)}`)
      expect(added.text.startsWith(text ?? ''), label).toBe(true)
      expect(tomlState(added.text, 'pneuma-base-codex', added.appended), label).toBe('in-place')
      expect(removeToml(added.text, added.appended), label).toBe(text ?? '')
    }
  })

  it('finds its own table already there, and refuses a name or a table it would clash with', () => {
    expect(appendToml(`x = 1\n\n${block}`, 'mcp_servers', 'pneuma-base-codex', block).outcome).toBe('present')
    expect(appendToml('[mcp_servers.pneuma-base-codex]\ncommand = "other"\n', 'mcp_servers', 'pneuma-base-codex', block).outcome).toBe('taken')
    expect(appendToml('mcp_servers = { a = { command = "a" } }\n', 'mcp_servers', 'pneuma-base-codex', block).outcome).toBe('taken')
    expect(appendToml('[mcp_servers.pneuma-base-codex2]\ncommand = "x"\n', 'mcp_servers', 'pneuma-base-codex', block).outcome).toBe('added')
  })

  it('is not removed once the owner changed it', () => {
    const added = appendToml('a = 1\n', 'mcp_servers', 'pneuma-base-codex', block)
    if (added.outcome !== 'added') throw new Error('not added')
    const edited = added.text.replace('"@codex"', '"@codex", "--x"')
    expect(removeToml(edited, added.appended)).toBeNull()
    expect(tomlState(edited, 'pneuma-base-codex', added.appended)).toBe('changed')
    expect(tomlState('a = 1\n', 'pneuma-base-codex', added.appended)).toBe('gone')
  })
})
