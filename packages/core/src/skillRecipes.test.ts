import { describe, expect, it } from 'vitest'
import { createDefaultProject, layerEnd } from './doc'
import { sequentialIds } from './ids'
import type { Comp } from './schema'
import { Session } from './session'
import { defaultCameraPose } from './world'

// Core loads no Node types, so the modules are named by variable.
const fsName: string = 'node:fs'
const urlName: string = 'node:url'
const pathName: string = 'node:path'
const { readFileSync } = (await import(fsName)) as { readFileSync(p: string, enc: string): string }
const { fileURLToPath } = (await import(urlName)) as { fileURLToPath(u: string): string }
const { dirname, resolve } = (await import(pathName)) as { dirname(p: string): string; resolve(...p: string[]): string }

const hereUrl = (import.meta as unknown as { url: string }).url
const RECIPES = resolve(dirname(fileURLToPath(hereUrl)), '../../../skill/references/recipes.md')

/** Every ```js block of the recipes, with the comp it says it is built for (first line: `// comp 1080x1920 15000ms`). */
function blocks() {
  const text = readFileSync(RECIPES, 'utf8').replace(/\r\n/g, '\n')
  const found: { code: string; width: number; height: number; durationMs: number; title: string }[] = []
  let heading = ''
  let open: string[] | null = null
  for (const line of text.split('\n')) {
    if (open === null) {
      if (/^#{1,3} /.test(line)) heading = line.replace(/^#+ /, '')
      if (line.trim() === '```js') open = []
      continue
    }
    if (line.trim() === '```') {
      const code = open.join('\n')
      const size = /^\/\/ comp (\d+)x(\d+) (\d+)ms/.exec(code.split('\n')[0] ?? '')
      if (!size) throw new Error(`The js block under "${heading}" must start with "// comp WIDTHxHEIGHT DURATIONms".`)
      found.push({ code, width: Number(size[1]), height: Number(size[2]), durationMs: Number(size[3]), title: heading })
      open = null
    } else open.push(line)
  }
  return found
}

describe('skill/references/recipes.md', () => {
  const all = blocks()

  it('has a complete script for the title card, the kinetic type and the promo', () => {
    expect(all.length).toBeGreaterThanOrEqual(3)
    for (const word of ['Title card', 'Kinetic', 'promo']) expect(all.some((b) => b.title.toLowerCase().includes(word.toLowerCase()))).toBe(true)
  })

  for (const block of all) {
    it(`"${block.title}" builds in one script_run, inside its comp`, async () => {
      const ids = sequentialIds()
      const session = new Session({ project: createDefaultProject(ids), ids })
      const comp = session.project.comps[0] as Comp
      const sized = await session.call('frame.update', { id: comp.id, width: block.width, height: block.height, durationMs: block.durationMs })
      expect(sized.ok).toBe(true)

      const result = await session.call('script.run', { code: block.code })
      if (!result.ok) throw new Error(`${result.error}\n${result.hint ?? ''}`)
      // biome-ignore lint/suspicious/noExplicitAny: the run's reply is checked field by field
      const out = result.value as any
      expect(out.created.layers).toBeGreaterThan(0)
      expect(out.value).toBeTypeOf('object')

      // Every layer the script made, in the comp and in any comp it made (a world it moved layers into).
      const made = session.project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers))
      expect(made.length).toBe(out.created.layers)
      for (const layer of made) expect(layerEnd(layer)).toBeLessThanOrEqual(block.durationMs)
      // The promo's five cuts each carry a push.
      if (/promo/i.test(block.title)) expect((session.project.comps[0] as Comp).tracks.flatMap((t) => t.transitions)).toHaveLength(5)
      // 2D to 3D: the moved layers are in the world, and the camera holds the default pose until its first key.
      if (/2D to 3D/.test(block.title)) {
        const world = session.project.comps.find((c) => c.id === out.value.world) as Comp
        expect(world.world).toBeTruthy()
        const inWorld = world.tracks.flatMap((t) => t.layers)
        for (const id of [out.value.word, out.value.cloud]) expect(inWorld.some((l) => l.id === id)).toBe(true)
        const camera = inWorld.find((l) => l.id === out.value.camera)
        const pose = defaultCameraPose(block.width, block.height)
        expect([camera?.transform.x, camera?.transform.y, camera?.transform.z]).toEqual(pose.position)
        for (const axis of ['x', 'y', 'z'] as const) {
          const first = camera?.animations[`transform.${axis}`]?.[0]
          expect(first?.v).toBe(camera?.transform[axis])
          expect(first?.t).toBeGreaterThan(0)
        }
      }
      // One undo step takes the whole scene back.
      expect(session.undo()).toBe(true)
      expect(session.project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers))).toHaveLength(0)
    })
  }
})
