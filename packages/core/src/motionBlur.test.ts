import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { DEFAULT_MOTION_BLUR, MOTION_BLUR_PRESETS, motionBlurPreset, shutterSamples, shutterWindow } from './motionBlur'
import type { Comp, Layer } from './schema'
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
  const comp = () => session.project.comps[0] as Comp
  const layer = (id: string) => comp().tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  return { session, ok, comp, layer }
}

describe('motion blur', () => {
  it('opens a 180° shutter half a frame, centred on the frame time', () => {
    expect(shutterWindow(DEFAULT_MOTION_BLUR, 1000, 25)).toEqual([990, 1010])
    const whip = motionBlurPreset('whip')!
    // 720° doubled by amount 2: four frames, centred on the frame.
    expect(shutterWindow(whip, 1000, 25)).toEqual([920, 1080])
  })

  it('spreads samples through the shutter with weights that sum to 1', () => {
    const samples = shutterSamples(DEFAULT_MOTION_BLUR, 1000, 25, 5)
    expect(samples.map((s) => s.timeMs)).toEqual([990, 995, 1000, 1005, 1010])
    expect(samples.reduce((a, s) => a + s.weight, 0)).toBeCloseTo(1)
    const trail = shutterSamples({ ...DEFAULT_MOTION_BLUR, weighting: 'trail' }, 1000, 25, 3)
    expect(trail[2]!.weight).toBeGreaterThan(trail[0]!.weight)
  })

  it('has AtomCut\'s seven presets', () => {
    expect(MOTION_BLUR_PRESETS.map((p) => p.id)).toEqual(['film', 'crisp', 'long', 'comet', 'anticipate', 'whip', 'ghost'])
  })

  it('is on for new comps and layers; comp.update merges and applies presets', async () => {
    const { ok, comp } = setup()
    expect(comp().motionBlur).toMatchObject({ enabled: true, shutterAngle: 180, shutterPhase: -90 })
    await ok('comp.update', { id: comp().id, motionBlur: { preset: 'crisp', strength: 0.5 } })
    expect(comp().motionBlur).toMatchObject({ enabled: true, shutterAngle: 90, shutterPhase: -45, strength: 0.5 })
    await ok('comp.update', { id: comp().id, motionBlur: { enabled: false } })
    expect(comp().motionBlur).toMatchObject({ enabled: false, shutterAngle: 90 })
  })

  it("keys a layer's shutter at mblur.*, making its override", async () => {
    const { ok, layer } = setup()
    const { id } = await ok('layer.create', { kind: 'shape' })
    expect(layer(id).motionBlur).toEqual({ enabled: true, override: null })
    await ok('layer.set', { id, values: { 'mblur.shutterAngle': 360 } })
    expect(layer(id).motionBlur.override).toMatchObject({ shutterAngle: 360, shutterPhase: -90 })
    await ok('keyframes.set', { id, property: 'mblur.strength', keys: [{ at: 0, value: 0 }, { at: 500, value: 1 }] })
    expect(layer(id).animations['mblur.strength']).toHaveLength(2)
    await ok('layer.patch', { id, ops: [{ op: 'set', path: 'motionBlur.enabled', value: false }] })
    expect(layer(id).motionBlur.enabled).toBe(false)
  })
})
