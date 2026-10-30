import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { evaluateProperty, resolveProperty } from './properties'
import { type Layer } from './schema'
import { Session } from './session'

describe('world.extrude', () => {
  it('sets thickness and samples keys, with zero retained for a flat frame', async () => {
    const ids = sequentialIds()
    const session = new Session({ project: createDefaultProject(ids), ids })
    const call = async (name: string, input: unknown) => {
      const result = await session.call(name, input)
      if (!result.ok) throw new Error(result.error)
      return result.value as { id: string; frameId: string }
    }
    const world = await call('world.create', { starter: false })
    const shape = await call('layer.create', { compId: world.frameId, kind: 'shape' })
    await call('world.extrude', { ids: shape.id, depth: 0, bevel: 4 })
    const layer = () => session.project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers)).find((l) => l.id === shape.id) as Layer
    expect(layer().extrude).toEqual({ depth: 0, bevel: 4, bevelSegments: 3, sideColor: null, fit: 'outline' })
    await call('keyframes.set', { id: shape.id, path: 'extrude.depth', keys: [{ t: 0, v: 0, ease: 'linear' }, { t: 1000, v: 100, ease: 'linear' }] })
    expect(evaluateProperty(layer(), resolveProperty(layer(), 'extrude.depth')[0]!, 500)).toBeCloseTo(50)
    await call('world.extrude', { ids: shape.id, depth: 10, sideColor: '#ff0000' })
    expect(layer().extrude).toMatchObject({ depth: 10, bevel: 4, sideColor: '#ff0000' })
  })

  it('refuses open contours atomically and gives a closing hint', async () => {
    const ids = sequentialIds()
    const session = new Session({ project: createDefaultProject(ids), ids })
    const call = async (name: string, input: unknown) => {
      const result = await session.call(name, input)
      if (!result.ok) throw new Error(result.error)
      return result.value as { id: string; frameId: string }
    }
    const world = await call('world.create', { starter: false })
    const good = await call('layer.create', { compId: world.frameId, kind: 'shape' })
    const path = await call('layer.create', { compId: world.frameId, kind: 'path', d: 'M0 0 L10 0 L10 10' })
    const result = await session.call('world.extrude', { ids: [good.id, path.id], depth: 20 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.hint).toMatch(/Close every contour/)
    const layer = session.project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers)).find((l) => l.id === good.id)
    expect(layer?.extrude).toBeUndefined()
    expect((await session.call('world.extrude', { ids: path.id, depth: 0 })).ok).toBe(false)
    const closed = await call('layer.create', { compId: world.frameId, kind: 'path', d: 'M0 0 L10 0 L10 10 Z' })
    await call('world.extrude', { ids: closed.id, depth: 0 })
    expect((await session.call('layer.patch', { id: closed.id, ops: [{ op: 'set', path: 'geometry', value: 'M0 0 L10 0 L10 10' }] })).ok).toBe(false)
    expect((await session.call('keyframes.set', { id: closed.id, path: 'geometry', keys: [{ t: 0, v: 'M0 0 L10 0 L10 10' }] })).ok).toBe(false)
  })
})
