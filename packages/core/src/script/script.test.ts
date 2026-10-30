import { describe, expect, it } from 'vitest'
import { createDefaultProject } from '../doc'
import { sequentialIds } from '../ids'
import { readProjectFile, writeProjectFile } from '../projectFile'
import { Session } from '../session'

// Typed locally so the core package needs neither DOM nor Node type definitions.
const wait = (ms: number) => new Promise<void>((resolve) => (globalThis as unknown as { setTimeout(f: () => void, ms: number): void }).setTimeout(resolve, ms))

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}\n${result.hint ?? ''}`)
    return result.value
  }
  const layers = () => session.project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers))
  return { session, ok, layers }
}

const SCENE = `
const WORDS = ['Design', 'in', 'motion']
const ids = []
for (const [i, word] of WORDS.entries()) {
  const { id } = await ac.layer.create({ kind: 'text', text: word, name: 'Word ' + (i + 1), y: (i - 1) * 140 })
  await ac.keyframes.set({ id, property: 'opacity', keys: [{ t: i * 120, v: 0 }, { t: i * 120 + 400, v: 1 }] })
  ids.push(id)
}
const card = await ac.layer.create({ kind: 'shape', shape: { type: 'rect', width: here.width * 0.5, height: 200 }, x: Math.round(Math.random() * 100) })
console.log('made', ids.length, 'words in', here.name)
return { ids, card: card.id }
`

describe('script.run', () => {
  it('builds a scene through ac.* as one undo step and reports it', async () => {
    const { session, ok, layers } = setup()
    const out = await ok('script.run', { code: SCENE })
    expect(out.value.ids).toHaveLength(3)
    expect(out.created.layers).toBe(4)
    expect(out.calls).toBe(7)
    expect(out.logs).toEqual([`10: made 3 words in ${session.project.comps[0]?.name}`])
    expect(layers()).toHaveLength(4)
    expect(layers().find((l) => l.name === 'Word 2')?.transform.y).toBe(0)
    expect(session.undo()).toBe(true)
    expect(layers()).toHaveLength(0)
    expect(session.canUndo).toBe(false)
  })

  it('writes the same document for the same script (seeded random, frozen Date)', async () => {
    const a = setup()
    const b = setup()
    const code = `${SCENE.replace(/return[^\n]*\n$/, '')}\nawait ac.layer.create({ kind: 'text', text: String(Date.now()) + ':' + Math.random() })\n`
    await a.ok('script.run', { code })
    await b.ok('script.run', { code })
    expect(JSON.stringify(a.session.project)).toBe(JSON.stringify(b.session.project))
    expect(a.layers().some((l) => /^0:0\./.test(l.name))).toBe(true)
  })

  it('rolls back a script that fails, and names the line and the hint', async () => {
    const { session, layers } = setup()
    const result = await session.call('script.run', {
      code: `await ac.layer.create({ kind: 'text', text: 'kept?' })\nconsole.log('one')\nawait ac.layer.create({ kind: 'nope' })`,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/^Script failed at line 3: CommandError: layer\.create: Invalid input/)
    expect(result.hint).toMatch(/Nothing changed/)
    expect(result.hint).toMatch(/2: one/)
    expect(layers()).toHaveLength(0)
    expect(session.canUndo).toBe(false)
  })

  it('lets a script catch a failed call and go on', async () => {
    const { ok, layers } = setup()
    const out = await ok('script.run', {
      code: `try { await ac.layer.get({ id: 'missing' }) } catch (e) { console.log(e.name, e.command) }\nawait ac.layer.create({ kind: 'text', text: 'after' })`,
    })
    expect(out.logs).toEqual(['1: CommandError layer.get'])
    expect(layers()).toHaveLength(1)
  })

  it('stops an endless loop at its time limit and leaves no trace', async () => {
    const { session, layers } = setup()
    const started = Date.now()
    const result = await session.call('script.run', {
      code: `await ac.layer.create({ kind: 'text', text: 'x' })\nwhile (true) {}`,
      timeoutMs: 1000,
    })
    expect(Date.now() - started).toBeLessThan(4000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/timed out/)
    expect(layers()).toHaveLength(0)
    expect(session.scripts.list().at(-1)?.status).toBe('timeout')
  })

  it('stops a script waiting forever', async () => {
    const { session } = setup()
    const result = await session.call('script.run', { code: 'await new Promise(() => {})', timeoutMs: 1000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/timed out/)
  })

  it('is stopped by script runs, mid-run, and leaves no trace', async () => {
    const { session, layers } = setup()
    const running = session.call('script.run', {
      code: `for (let i = 0; i < 100000; i++) await ac.layer.create({ kind: 'text', text: 'w' + i })`,
    })
    await wait(200)
    const live = session.scripts.active
    expect(live?.status).toBe('running')
    expect(live && session.scripts.stop(live.id)).toBe(true)
    const result = await running
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/was stopped/)
    expect(layers()).toHaveLength(0)
    expect(live?.status).toBe('stopped')
    expect(live?.calls).toBeGreaterThan(0)
  })

  it('has no access to the outside world', async () => {
    const { ok } = setup()
    const out = await ok('script.run', {
      code: `return [typeof fetch, typeof setTimeout, typeof require, typeof process, typeof XMLHttpRequest, typeof importScripts, typeof host]`,
    })
    expect(out.value).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'])
  })

  it('refuses nested runs and batches inside a script', async () => {
    const { session } = setup()
    const result = await session.call('script.run', { code: `await ac.call('script.run', { code: '1' })` })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not available inside a script/)
  })

  it('reports a syntax error with its line', async () => {
    const { session } = setup()
    const result = await session.call('script.run', { code: `const a = 1\nconst b = (\n` })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/SyntaxError/)
  })

  it('answers ac.help and gives here', async () => {
    const { ok } = setup()
    const out = await ok('script.run', {
      code: `const all = await ac.help(); const verbs = await ac.help('layer'); const one = await ac.help('layer.create'); return [Object.keys(all.namespaces).includes('layer'), verbs.verbs.some(v => v.name === 'layer.create'), one.name, here.width, Object.isFrozen(here)]`,
    })
    expect(out.value).toEqual([true, true, 'layer.create', 1920, true])
  })

  it('logs carry their lines and the run can be read by cursor', async () => {
    const { session, ok } = setup()
    const out = await ok('script.run', { code: `for (let i = 0; i < 5; i++) console.log('step', i)\nconsole.warn({ a: 1 })` })
    const logs = session.scripts.logs(out.runId, 3)
    expect(logs?.lines.map((l) => l.text)).toEqual(['step 3', 'step 4', '{"a":1}'])
    expect(logs?.lines.at(-1)).toMatchObject({ level: 'warn', line: 2 })
    expect(logs?.next).toBe(6)
  })
})

describe('saved scripts', () => {
  it('saves, lists, reads, and re-runs in replace mode without stacking', async () => {
    const { session, ok, layers } = setup()
    const saved = await ok('script.save', { path: 'intro/title', source: SCENE })
    expect(saved).toMatchObject({ path: 'intro/title.js', onRun: 'replace', created: true })
    expect((await ok('script.list')).scripts[0]).toMatchObject({ path: 'intro/title.js', size: SCENE.length })
    expect((await ok('script.read', { script: 'title.js' })).source).toBe(SCENE)

    await ok('layer.create', { kind: 'text', text: 'Mine' })
    await ok('script.run', { script: 'intro/title.js' })
    expect(layers()).toHaveLength(5)
    const second = await ok('script.run', { script: 'intro/title.js' })
    expect(second.replaced).toEqual({ layers: 4, comps: 0 })
    expect(layers()).toHaveLength(5)
    expect(layers().filter((l) => l.name === 'Mine')).toHaveLength(1)
    expect(session.project.scripts[0]?.output.layerIds).toHaveLength(4)

    // One undo takes the second run back, including the removal of the first run's output.
    session.undo()
    expect(layers()).toHaveLength(5)
  })

  it('appends in append mode', async () => {
    const { ok, layers } = setup()
    await ok('script.save', { path: 'a.js', source: `await ac.layer.create({ kind: 'text', text: 'a' })`, onRun: 'append' })
    await ok('script.run', { script: 'a.js' })
    await ok('script.run', { script: 'a.js' })
    expect(layers()).toHaveLength(2)
  })

  it('a failed run of a saved script keeps the last output', async () => {
    const { session, ok, layers } = setup()
    await ok('script.save', { path: 'a.js', source: `await ac.layer.create({ kind: 'text', text: 'a' })` })
    await ok('script.run', { script: 'a.js' })
    await ok('script.save', { path: 'a.js', source: `await ac.layer.create({ kind: 'text', text: 'b' })\nthrow new Error('boom')` })
    const result = await session.call('script.run', { script: 'a.js' })
    expect(result.ok).toBe(false)
    expect(layers().map((l) => l.name)).toEqual(['a'])
  })

  it('refuses bad paths and unknown scripts, removes, and survives a save to file', async () => {
    const { session, ok } = setup()
    expect((await session.call('script.save', { path: '../x', source: '' })).ok).toBe(false)
    expect((await session.call('script.run', { script: 'nope.js' })).ok).toBe(false)
    await ok('script.save', { path: 'keep.js', source: 'return 1' })
    const reread = readProjectFile(writeProjectFile(session.project))
    expect(reread.project.scripts[0]).toMatchObject({ path: 'keep.js', source: 'return 1', onRun: 'replace' })
    await ok('script.remove', { script: 'keep.js' })
    expect(session.project.scripts).toHaveLength(0)
  })
})
