// What the item panel says of a place's facets and what the files page says of a directory nobody
// looked into: the words for people, from what storage gave. A placeholder cannot be made in a test
// folder (the content would have to be evicted by a sync service), so its words are checked here.
import { describe, expect, it } from 'vitest'
import { facetFields } from '../src/item-page.js'
import { probeWords } from '../src/places.js'

describe('the facets of a place, for people', () => {
  it('say where a file was downloaded from, which program brought it, its tags and when it was made', () => {
    const fields = facetFields({
      fs: { inode: 1, device: 2, created: '2026-11-20T08:00:00.000Z', mode: 33188 },
      macos: { where_from: ['https://example.com/report.pdf', 'https://example.com/'], quarantine: 'Safari', tags: ['红色', '工作'] },
    })
    expect(fields).toEqual([
      { label: '建于', value: { text: '2026-11-20 08:00Z', at: '2026-11-20T08:00:00.000Z' } },
      { label: '下载自', value: { text: 'https://example.com/report.pdf', href: 'https://example.com/report.pdf' } },
      { label: '下载自', value: { text: 'https://example.com/', href: 'https://example.com/' } },
      { label: '带进来的程序', value: { text: 'Safari' } },
      { label: '标签', value: { text: '红色、工作', icon: 'tag' } },
    ])
  })

  it('say that only a placeholder is on this machine, where the content is and how big it is there', () => {
    expect(facetFields({ placeholder: { provider: 'icloud', size_elsewhere: 2_400_000 } })).toEqual([
      { label: '这台机器上', value: { text: '内容在 iCloud 上，2.3 MB', icon: 'cloud-off', tag: { text: '只有占位', tone: 'warn' } } },
    ])
    expect(facetFields({ placeholder: { size_elsewhere: 900 } })[0]?.value.text).toBe('内容不在这台机器上，900 B')
  })

  it('give every field of a facet the page does not know as it is, and leave out what is not a facet', () => {
    expect(facetFields({ git: { object: 'abc123', tracked: true }, broken: 'x' })).toEqual([
      { label: 'git.object', value: { text: 'abc123', mono: true, muted: true } },
      { label: 'git.tracked', value: { text: 'true', mono: true, muted: true } },
    ])
    expect(facetFields(undefined)).toEqual([])
  })
})

describe('what a budgeted look into a directory found, in words', () => {
  it('counts its files, at least that many when the look stopped at its budget, and says when it looks like a project', () => {
    expect(probeWords({ files: 31, dirs: 2, bytes: 1, exceeded: false, markers: ['package.json', '.git'] })).toBe('31 个文件，像一个项目（package.json、.git）')
    expect(probeWords({ files: 500, dirs: 40, bytes: 1, exceeded: true, markers: [] })).toBe('至少 500 个文件')
    expect(probeWords({ files: 0, dirs: 3, bytes: 0, exceeded: false, markers: [] })).toBe('没有文件，3 个目录')
    expect(probeWords({ files: 0, dirs: 0, bytes: 0, exceeded: false, markers: [] })).toBe('空的')
  })
})
