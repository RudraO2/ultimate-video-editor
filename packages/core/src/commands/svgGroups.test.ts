import { describe, expect, it } from 'vitest'
import { createDefaultProject } from '../doc'
import { sequentialIds } from '../ids'
import type { Comp, Layer } from '../schema'
import { Session } from '../session'

type Entry = { id: string; name: string; kind: string; children?: Entry[] }

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(name + ' failed: ' + result.error)
    return result.value
  }
  const layers = () => (session.project.comps[0] as Comp).tracks.flatMap((t) => t.layers)
  const find = (id: string) => layers().find((l) => l.id === id) as Layer
  /** The names of a group's direct members, front-most first. */
  const membersOf = (id: string): string[] => {
    const comp = session.project.comps[0] as Comp
    return comp.tracks.filter((t) => t.groupId === id).flatMap((t) => t.layers.map((l) => l.name))
  }
  return { session, ok, find, layers, membersOf }
}

// A miniature of an Open Peeps file: Sketch's wrappers, categories as groups, a group with nothing in it.
const PEEP = `<svg viewBox="0 0 240 324"><g id="Introduction" fill="none"><g id="variations" transform="translate(-10, -10)"><g id="images" transform="translate(10, 10)"><g id="a-person/bust">
  <g id="body/Dress"><path id="🎨-Background" fill="#FFFFFF" d="M0 200h100v100H0z"/><path id="🖍-Ink" fill="#000000" d="M10 210h80v80H10z"/></g>
  <g id="head/Bangs"><path id="🎨-Background" fill="#FFFFFF" d="M30 40h40v40H30z"/><path id="🖍-Ink" fill="#000000" d="M35 45h30v30H35z"/></g>
  <g id="face/Monster" fill="#000000"><path id="🖍-Ink" d="M40 60h20v10H40z"/></g>
  <g id="facial-hair/*-None"></g>
  <g id="accessories/Glasses-3" fill="#000000"><path id="🖍-Ink" d="M38 55h24v4H38z"/></g>
</g></g></g></g></svg>`

const names = (entries: Entry[] | undefined) => (entries ?? []).map((c) => c.name)

describe('svg.place groups', () => {
  it("builds the SVG's named groups as nested groups: wrappers skipped, empty groups not made, layers under their group", async () => {
    const { ok, find, membersOf } = setup()
    const result = await ok('svg.place', { svg: PEEP, name: 'Peep', groups: true, size: 300 })
    expect(result.tree).toHaveLength(1)
    const top: Entry = result.tree[0]
    expect(top).toMatchObject({ name: 'Peep', kind: 'group' })
    expect(result.groupId).toBe(top.id)
    // Tree is in drawing order (back to front); the stack lists the front-most first.
    expect(names(top.children)).toEqual(['body', 'head', 'face', 'accessories'])
    expect(membersOf(top.id)).toEqual(['accessories', 'face', 'head', 'body'])
    const byName = (n: string) => top.children?.find((c) => c.name === n) as Entry
    expect(names(byName('body').children)).toEqual(['Background', 'Ink'])
    expect(membersOf(byName('body').id)).toEqual(['Ink', 'Background'])
    expect(membersOf(byName('face').id)).toEqual(['Ink'])
    expect(names(top.children)).not.toContain('facial hair')
    expect(result.layers).toBe(6)
    expect(result.ids).toHaveLength(6)
    for (const id of result.ids) expect(find(id).kind).toBe('path')
    expect(find(byName('head').id).kind).toBe('group')
  })

  it('merges outlines only inside one group, and leaves groups off by default', async () => {
    const { ok } = setup()
    const svg =
      '<svg viewBox="0 0 10 10"><g id="left"><rect width="2" height="2" fill="#f00"/><rect x="3" width="2" height="2" fill="#f00"/></g><g id="right"><rect x="6" width="2" height="2" fill="#f00"/></g></svg>'
    const apart = await ok('svg.place', { svg, groups: true })
    expect(apart.layers).toBe(2)
    expect(names(apart.tree[0].children)).toEqual(['left', 'right'])
    const flat = await ok('svg.place', { svg })
    expect(flat.layers).toBe(1)
    expect(flat.tree).toHaveLength(1)
    const unmerged = await ok('svg.place', { svg, groups: true, merge: false })
    expect(unmerged.layers).toBe(3)
  })

  it('names layers of a flat picture "<name> n", or just the name for one', async () => {
    const { ok, find } = setup()
    const flat = await ok('svg.place', { svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#fc0"/><circle cx="4" cy="4" r="1" fill="#000"/></svg>', name: 'Face', groups: true })
    expect(flat.ids.map((id: string) => find(id).name)).toEqual(['Face 1', 'Face 2'])
    const one = await ok('svg.place', { svg: '<svg viewBox="0 0 10 10"><g id="solo"><circle cx="5" cy="5" r="4" fill="#fc0"/></g></svg>', name: 'Dot', groups: true })
    expect(one.groupId).toBeNull()
    expect(find(one.ids[0]).name).toBe('Dot')
  })

  it('undoes as one step', async () => {
    const { session, ok, layers } = setup()
    await ok('svg.place', { svg: PEEP, groups: true })
    session.undo()
    expect(layers()).toHaveLength(0)
  })
})

// The real file, when this computer has the library. Core loads no Node types, so the modules are named by variable.
const fsName: string = 'node:fs'
const osName: string = 'node:os'
const { existsSync, readFileSync } = (await import(fsName)) as { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string }
const { homedir } = (await import(osName)) as { homedir(): string }
const PEEP_FILE = homedir().replace(/\\/g, '/') + '/uve-assets/open-peeps/peep-1.svg'

describe('svg.place on a real Open Peeps file', () => {
  it.skipIf(!existsSync(PEEP_FILE))('puts body, head and face under one top group', async () => {
    const { ok } = setup()
    const result = await ok('svg.place', { svg: readFileSync(PEEP_FILE, 'utf8'), name: 'Peep', groups: true, size: 400 })
    const top: Entry = result.tree[0]
    expect(top.name).toBe('Peep')
    for (const part of ['body', 'head', 'face']) expect(names(top.children)).toContain(part)
    expect(names(top.children)).not.toContain('facial hair')
  })
})
