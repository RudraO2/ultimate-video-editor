import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { LAYER_EFFECTS, TEXT_EFFECTS } from './effects'
import { sequentialIds } from './ids'
import { propertiesOf } from './properties'
import type { Comp, Layer } from './schema'
import { LayerSchema } from './schema'
import { Session } from './session'

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return `${result.error}\n${result.hint ?? ''}`
  }
  const layer = (id: string) => (session.project.comps[0] as Comp).tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  return { session, ok, fail, layer }
}

describe('effect stack', () => {
  it('every card parses with its defaults', () => {
    for (const def of [...LAYER_EFFECTS, ...TEXT_EFFECTS]) {
      for (const [key, field] of Object.entries(def.fields)) {
        if (field.kind === 'number') {
          if (field.min !== undefined) expect(field.default, `${def.type}.${key}`).toBeGreaterThanOrEqual(field.min)
          if (field.max !== undefined) expect(field.default, `${def.type}.${key}`).toBeLessThanOrEqual(field.max)
        }
        if (field.kind === 'enum') expect(field.options).toContain(field.default)
      }
    }
  })

  it('adds, edits, reorders and removes cards; one undo step each', async () => {
    const { ok, fail, layer, session } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'Hello' })
    const shadow = await ok('effects.add', { id, type: 'shadow', values: { y: 20, color: '#00000066' } })
    expect(shadow.effect).toMatchObject({ type: 'shadow', y: 20, blur: 24, color: '#00000066', enabled: true })
    expect(shadow.keyable).toContain(`lfx.${shadow.effectId}.blur`)
    const glow = await ok('effects.add', { id, type: 'glow', index: 0 })
    expect(layer(id).effects.map((e) => e.type)).toEqual(['glow', 'shadow'])

    await ok('effects.update', { id, effectId: shadow.effectId, index: 0, enabled: false, values: { blur: 4 } })
    expect(layer(id).effects[0]).toMatchObject({ id: shadow.effectId, enabled: false, blur: 4 })

    session.undo()
    expect(layer(id).effects.map((e) => e.type)).toEqual(['glow', 'shadow'])
    await ok('effects.update', { id, effectId: glow.effectId, remove: true })
    expect(layer(id).effects.map((e) => e.type)).toEqual(['shadow'])

    expect(await fail('effects.add', { id, type: 'shadow', values: { spread: 4 } })).toContain('no field "spread"')
    expect(await fail('effects.add', { id, type: 'glow', values: { size: -1 } })).toMatch(/size/)
    expect(await fail('effects.add', { id, type: 'grade' })).toContain('not in this editor yet')
    expect(await fail('effects.add', { id, type: 'extrude' })).toContain('domain "text"')
    expect(await fail('effects.add', { id, domain: 'audio', type: 'eq' })).toContain('phase D')
  })

  it('keys effect fields by id, and drops them with the card', async () => {
    const { ok, layer } = setup()
    const { id } = await ok('layer.create', { kind: 'shape', shape: 'rect' })
    const { effectId } = await ok('effects.add', { id, type: 'blur', values: { radius: 0 } })
    const path = `lfx.${effectId}.radius`
    expect(propertiesOf(layer(id)).map((p) => p.path)).toContain(path)
    await ok('keyframes.set', { id, property: path, keys: [{ at: 0, value: 20 }, { at: 500, value: 0 }] })
    expect(layer(id).animations[path]).toHaveLength(2)
    const removed = await ok('effects.update', { id, effectId, remove: true })
    expect(removed.droppedKeys).toEqual([path])
    expect(layer(id).animations[path]).toBeUndefined()
  })

  it('refuses a plain value on a keyed field', async () => {
    const { ok, fail } = setup()
    const { id } = await ok('layer.create', { kind: 'shape' })
    const { effectId } = await ok('effects.add', { id, type: 'glow' })
    await ok('keyframes.set', { id, property: `lfx.${effectId}.intensity`, keys: [{ at: 0, value: 0 }, { at: 300, value: 1 }] })
    expect(await fail('effects.update', { id, effectId, values: { intensity: 2 } })).toContain('animated')
    await ok('layer.set', { id, values: { [`lfx.${effectId}.intensity`]: 2 }, atMs: 300 })
  })

  it('text effects live on the style and need a text layer', async () => {
    const { ok, fail, layer } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'Neon' })
    const { effectId } = await ok('effects.add', { id, domain: 'text', type: 'glow', values: { source: 'text', radius: 30 } })
    const text = layer(id)
    expect(text.kind === 'text' && text.style.textEffects[0]).toMatchObject({ id: effectId, type: 'glow', radius: 30, source: 'text' })
    expect(propertiesOf(text).map((p) => p.path)).toContain(`tfx.${effectId}.radius`)
    const shape = await ok('layer.create', { kind: 'shape' })
    expect(await fail('effects.add', { id: shape.id, domain: 'text', type: 'glow' })).toContain('domain "layer"')
  })

  it('layer.create and layer.patch take loose cards and mint their ids', async () => {
    const { ok, fail, layer } = setup()
    const { id } = await ok('layer.create', {
      kind: 'text',
      text: 'Pop',
      style: { textEffects: [{ type: 'extrude', length: 26, color: '#ff0055' }] },
      effects: [{ type: 'stroke', width: 6, placement: 'outside', color: '#ffffff' }],
    })
    const made = layer(id)
    expect(made.effects[0]).toMatchObject({ type: 'stroke', width: 6, softness: 0 })
    expect(made.kind === 'text' && made.style.textEffects[0]).toMatchObject({ type: 'extrude', length: 26, angle: 45 })
    await ok('layer.patch', { id, ops: [{ op: 'insert', path: 'effects[-]', value: { type: 'blur', radius: 3 } }] })
    expect(layer(id).effects[1]).toMatchObject({ type: 'blur', radius: 3, enabled: true })
    expect(layer(id).effects[1]?.id).toBeTruthy()
    expect(await fail('layer.patch', { id, ops: [{ op: 'insert', path: 'effects[-]', value: { type: 'blur', size: 3 } }] })).toMatch(/size/)
    expect(LayerSchema.parse(layer(id)).effects).toHaveLength(2)
  })
})
