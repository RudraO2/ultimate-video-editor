import { describe, expect, it } from 'vitest'
import { addRecent, mediaPathsIn, parseRecent, projectFileName, RECENT_LIMIT, withProjectExtension } from './project'

describe('project file names', () => {
  it('makes a safe file name from the project name', () => {
    expect(projectFileName('My: promo?')).toBe('My promo.uve')
    expect(projectFileName(' ..')).toBe('Untitled project.uve')
  })

  it('adds the extension only when it is missing', () => {
    expect(withProjectExtension('C:/a/b.UVE')).toBe('C:/a/b.UVE')
    expect(withProjectExtension('C:/a/b.json')).toBe('C:/a/b.json.uve')
  })
})

describe('recent projects', () => {
  it('moves a project to the front once, without case-sensitive duplicates, and keeps a limit', () => {
    let list = addRecent([], { path: 'C:\\a\\One.uve', name: 'One', at: 1 })
    list = addRecent(list, { path: 'C:/a/two.uve', name: 'Two', at: 2 })
    list = addRecent(list, { path: 'c:/A/one.uve', name: 'One', at: 3 })
    expect(list.map((r) => r.name)).toEqual(['One', 'Two'])
    for (let i = 0; i < 20; i++) list = addRecent(list, { path: `C:/p${i}.uve`, name: `P${i}`, at: i })
    expect(list).toHaveLength(RECENT_LIMIT)
  })

  it('drops malformed entries read from disk', () => {
    expect(parseRecent([{ path: 'C:/a.uve', name: 'A', at: 1 }, { path: 3 }, null, 'x'])).toEqual([{ path: 'C:/a.uve', name: 'A', at: 1 }])
    expect(parseRecent({})).toEqual([])
  })
})

describe('mediaPathsIn', () => {
  it('lists media paths and tolerates anything else', () => {
    expect(mediaPathsIn(JSON.stringify({ document: { media: [{ path: 'C:/v.mp4' }, { path: 1 }, null] } }))).toEqual(['C:/v.mp4'])
    expect(mediaPathsIn('nope')).toEqual([])
  })
})
