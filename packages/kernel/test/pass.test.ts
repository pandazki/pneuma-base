// A named whole pass as a plugin gets it: its own reports go through as they are, and what storage
// says of a read or write under way joins the last of them, keeping the plugin's count.
import { describe, expect, it } from 'vitest'
import type { PassProgress } from '../src/index.js'
import { relayedPass } from '../src/tools.js'

describe('the channel of a named whole pass', () => {
  it('passes the plugin’s reports on, and adds storage’s progress on a directory to the last of them', () => {
    const heard: PassProgress[] = []
    let stop = false
    const { pass, heard: storage } = relayedPass({ report: (p) => void heard.push(p), stopped: () => stop })
    pass.report({ done: 0, total: 3, text: '要按内容读整个库：3 样登记过的东西。' })
    storage('site', '读', { files: 120, bytes: 0, total_files: 900, total_bytes: null })
    // One file read says nothing a person needs; the plugin's own count stays.
    storage('a.md', '读', { files: 1, bytes: 10, total_files: 1, total_bytes: 10 })
    pass.report({ done: 1, total: 3, atLeast: true, text: '已查 1 / 3 样' })
    storage('notes', '写', { files: 2, bytes: 0, total_files: 4, total_bytes: null })
    expect(heard).toEqual([
      { done: 0, total: 3, text: '要按内容读整个库：3 样登记过的东西。' },
      { done: 0, total: 3, text: '要按内容读整个库：3 样登记过的东西。 · 正在读 site：120 / 900 个文件' },
      { done: 1, total: 3, atLeast: true, text: '已查 1 / 3 样' },
      { done: 1, total: 3, atLeast: true, text: '已查 1 / 3 样 · 正在写 notes：2 / 4 个文件' },
    ])
    expect(pass.stopped()).toBe(false)
    stop = true
    expect(pass.stopped()).toBe(true)
  })
})
