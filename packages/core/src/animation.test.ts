import { describe, expect, it } from 'vitest'
import { animationWindow, drawOnAt, drawPieceProgress, glyphPoses, layerPose, slotAnimation, textUnits, unitStartMs } from './animation'
import { ANIMATION_PRESETS, findAnimationPreset } from './animationPresets'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { readProjectFile, writeProjectFile } from './projectFile'
import type { Comp, Layer, LayerAnimation } from './schema'
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
  const layer = (id: string) =>
    (session.project.comps[0] as Comp).tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  return { session, ok, fail, layer }
}

const spec = (fields: Partial<LayerAnimation>): LayerAnimation => ({
  preset: 'fade',
  unit: 'word',
  durationMs: 400,
  staggerMs: 100,
  delayMs: 0,
  easing: 'linear',
  jitterMs: 0,
  scatterPx: 0,
  scatterDeg: 0,
  params: {},
  ...fields,
})

describe('animation presets', () => {
  it('has the 44 presets, each at rest at the end of its entrance', () => {
    expect(ANIMATION_PRESETS).toHaveLength(44)
    expect(new Set(ANIMATION_PRESETS.map((p) => p.id)).size).toBe(44)
    for (const preset of ANIMATION_PRESETS) {
      const pose = preset.pose(1, {})
      expect(pose.opacity, preset.id).toBeCloseTo(1)
      expect(Math.abs(pose.dx) + Math.abs(pose.dy) + Math.abs(pose.rotation) + pose.blur, preset.id).toBeCloseTo(0)
      expect(pose.scale, preset.id).toBeCloseTo(1)
    }
  })

  it('poses follow their knobs', () => {
    const fadeUp = findAnimationPreset('fade-up')!
    expect(fadeUp.pose(0, { distance: 36 })).toMatchObject({ opacity: 0, dy: 36 })
    expect(fadeUp.pose(0.5, { distance: 100 }).dy).toBeCloseTo(50)
    expect(findAnimationPreset('pop-in')!.pose(0, { from: 40 }).scale).toBeCloseTo(0.4)
    expect(findAnimationPreset('blur-in')!.pose(0, { blur: 18 }).blur).toBe(18)
  })
})

describe('text units', () => {
  it('cuts words at spaces and lines at line breaks', () => {
    const units = textUnits('Hi there\nyou')
    expect(units.wordCount).toBe(3)
    expect(units.lineCount).toBe(2)
    expect(units.word).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2])
    expect(units.line).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1])
  })

  it('starts unit i at delay + i·stagger, and ends an exit delay before the layer ends', () => {
    const layer = { id: 'a', durationMs: 3000 }
    expect(unitStartMs(spec({ delayMs: 200 }), 'in', 2, 3, layer)).toBe(400)
    // 3 units: the span is 2·100 + 400 = 600; the last ends at 3000 − 100.
    expect(unitStartMs(spec({ delayMs: 100 }), 'out', 0, 3, layer)).toBe(2300)
    expect(unitStartMs(spec({ delayMs: 100 }), 'out', 2, 3, layer) + 400).toBe(2900)
  })

  it('jitter is repeatable and within its bound', () => {
    const layer = { id: 'abc', durationMs: 3000 }
    const s = spec({ jitterMs: 50, staggerMs: 60 })
    const a = unitStartMs(s, 'in', 4, 10, layer)
    expect(a).toBe(unitStartMs(s, 'in', 4, 10, layer))
    expect(a).toBeGreaterThanOrEqual(240)
    expect(a).toBeLessThan(290)
  })
})

describe('animation.set', () => {
  it('puts a per-word entrance on text and poses each word in turn', async () => {
    const { ok, layer } = setup()
    const text = await ok('layer.create', { kind: 'text', text: 'One two three', durationMs: 4000 })
    const result = await ok('animation.set', { id: text.id, slot: 'in', preset: 'fade-up' })
    expect(result.target).toBe('text')
    expect(result.animation).toMatchObject({ preset: 'fade-up', unit: 'word', durationMs: 450, staggerMs: 90, easing: 'ease-out-quart', params: { distance: 36 } })
    expect(result.units).toBe(3)
    const l = layer(text.id)
    const at = (t: number) => glyphPoses(l, 'One two three', t)!.poses
    // At 50 ms the first word is on its way; the second starts at 90 ms.
    expect(at(50)[0]!.opacity).toBeGreaterThan(0)
    expect(at(50)[4]!.opacity).toBe(0)
    expect(at(50)[4]!.dy).toBe(36)
    expect(at(2000).every((p) => p.opacity === 1 && p.dy === 0)).toBe(true)
  })

  it('animates any layer as one piece, and plays an exit backwards', async () => {
    const { ok, layer } = setup()
    const shape = await ok('layer.create', { kind: 'shape', durationMs: 2000 })
    await ok('animation.set', { id: shape.id, slot: 'in', preset: 'pop-in', easing: 'linear' })
    await ok('animation.set', { id: shape.id, slot: 'out', preset: 'fade', durationMs: 500 })
    const l = layer(shape.id)
    expect(l.animIn?.preset).toBe('pop-in')
    expect(layerPose(l, 0)).toMatchObject({ opacity: 0, scale: 0.4 })
    expect(layerPose(l, 1000)).toMatchObject({ opacity: 1, scale: 1 })
    expect(layerPose(l, 2000)?.opacity).toBe(0)
    expect(layerPose(l, 1750)?.opacity).toBeCloseTo(0.5, 1)
    expect(animationWindow(l, 'layer', 'out')).toEqual({ startMs: 1500, endMs: 2000 })
  })

  it('keeps timing and shared knobs when swapping presets, and removes with null', async () => {
    const { ok, layer, session } = setup()
    const text = await ok('layer.create', { kind: 'text', text: 'Hello world' })
    await ok('animation.set', { id: text.id, slot: 'in', preset: 'slide-up', durationMs: 700, params: { distance: 120 } })
    await ok('animation.set', { id: text.id, slot: 'in', preset: 'fade-up' })
    expect(slotAnimation(layer(text.id), 'text', 'in')).toMatchObject({ preset: 'fade-up', durationMs: 700, unit: 'letter', params: { distance: 120 } })
    const removed = await ok('animation.set', { id: text.id, slot: 'in', preset: null })
    expect(removed.removed).toBe('fade-up')
    expect(slotAnimation(layer(text.id), 'text', 'in')).toBeNull()
    session.undo()
    expect(slotAnimation(layer(text.id), 'text', 'in')?.preset).toBe('fade-up')
  })

  it('gives text a whole-layer slot and a per-unit slot at once', async () => {
    const { ok, layer } = setup()
    const text = await ok('layer.create', { kind: 'text', text: 'Big title', durationMs: 3000 })
    await ok('animation.set', { id: text.id, slot: 'in', preset: 'pop-in', target: 'layer' })
    await ok('animation.set', { id: text.id, slot: 'in', preset: 'fade-up' })
    const l = layer(text.id)
    expect(l.animIn?.preset).toBe('pop-in')
    expect(slotAnimation(l, 'text', 'in')?.preset).toBe('fade-up')
    // drift moves whole layers only, so auto puts it on the layer slot.
    const drift = await ok('animation.set', { id: text.id, slot: 'out', preset: 'drift' })
    expect(drift.target).toBe('layer')
    // auto removes the text slot first.
    expect((await ok('animation.set', { id: text.id, slot: 'in', preset: null })).removed).toBe('fade-up')
    expect((await ok('animation.set', { id: text.id, slot: 'in', preset: null })).removed).toBe('pop-in')
  })

  it('refuses what cannot work, with a reason', async () => {
    const { ok, fail } = setup()
    const text = await ok('layer.create', { kind: 'text', text: 'Hi' })
    const shape = await ok('layer.create', { kind: 'shape' })
    expect(await fail('animation.set', { id: text.id, slot: 'in', preset: 'fadeup' })).toMatch(/No animation preset "fadeup"[\s\S]*fade-up/)
    expect(await fail('animation.set', { id: shape.id, slot: 'in', preset: 'typewriter' })).toMatch(/animates text per unit/)
    expect(await fail('animation.set', { id: shape.id, slot: 'in', preset: 'fade', delayMs: 300 })).toMatch(/for text units[\s\S]*timeline.move/)
    expect(await fail('animation.set', { id: shape.id, slot: 'in', preset: 'fade', target: 'text' })).toMatch(/shape layer/)
    expect(await fail('animation.set', { id: text.id, slot: 'in', preset: 'fade-up', params: { height: 3 } })).toMatch(/no knob "height"[\s\S]*distance/)
    expect(await fail('animation.set', { id: text.id, slot: 'in', preset: 'fade-up', params: { distance: 900 } })).toMatch(/0 to 200/)
    expect(await fail('animation.set', { id: text.id, slot: 'in', preset: 'draw' })).toMatch(/Text cannot draw on/)
  })

  it('accepts AtomCut easing shapes and warns when the units outlast the layer', async () => {
    const { ok } = setup()
    const text = await ok('layer.create', { kind: 'text', text: 'a b c d e f g h', durationMs: 500 })
    const result = await ok('animation.set', { id: text.id, slot: 'in', preset: 'fade', easing: { kind: 'preset', name: 'ease-out-expo' } })
    expect(result.animation.easing).toBe('ease-out-expo')
    expect(result.warnings?.[0]).toMatch(/cut short/)
  })

  it('draws outlines on, piece by piece', async () => {
    const { ok, layer } = setup()
    const path = await ok('layer.create', { kind: 'path', d: 'M0 0 L100 0 M0 50 L100 50', durationMs: 2000 })
    await ok('animation.set', { id: path.id, slot: 'in', preset: 'draw', easing: 'linear', durationMs: 1000 })
    const draw = drawOnAt(layer(path.id), 500)!
    expect(draw.progress).toBeCloseTo(0.5)
    expect(draw.order).toBe('one-by-one')
    expect(drawPieceProgress(draw, 0, 2)).toBeCloseTo(1)
    expect(drawPieceProgress(draw, 1, 2)).toBeCloseTo(0)
    expect(drawOnAt(layer(path.id), 1500)).toBeNull()
  })

  it('survives a project file round trip', async () => {
    const { ok, session } = setup()
    const text = await ok('layer.create', { kind: 'text', text: 'Hi' })
    await ok('animation.set', { id: text.id, slot: 'in', preset: 'typewriter' })
    const read = readProjectFile(writeProjectFile(session.project))
    const again = (read.project.comps[0] as Comp).tracks.flatMap((t) => t.layers).find((l) => l.id === text.id)
    expect(again?.kind === 'text' && again.textIn?.preset).toBe('typewriter')
  })
})
