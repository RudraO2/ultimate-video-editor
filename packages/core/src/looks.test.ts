import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { findLook, lookCaptionFocus, lookLayerInput, lookStyle, TEXT_LOOKS } from './looks'
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
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return `${result.error}\n${result.hint ?? ''}`
  }
  const text = (id: string) => (session.project.comps[0] as Comp).tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Extract<Layer, { kind: 'text' }>
  return { session, ok, fail, text }
}

describe('text looks', () => {
  it('has 103 looks, each findable by id or name', () => {
    expect(TEXT_LOOKS).toHaveLength(103)
    expect(findLook('hero-pop')?.name).toBe('Hero Pop')
    expect(findLook('HERO POP')?.id).toBe('hero-pop')
    expect(findLook('no such look')).toBeUndefined()
  })

  it('makes a valid text layer from every look', async () => {
    const { session } = setup()
    for (const look of TEXT_LOOKS) {
      const result = await session.call('layer.create', { kind: 'text', template: look.id })
      expect(result.ok, `${look.id}: ${result.ok ? '' : result.error}`).toBe(true)
    }
  })

  it('resolves palette references and keeps case, decoration, pill and opacity', () => {
    const style = lookStyle(findLook('lower-third') as NonNullable<ReturnType<typeof findLook>>) as Record<string, unknown>
    expect(style.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    expect(style.highlight).toMatchObject({ color: expect.stringMatching(/^#/), radius: 4 })
    expect(lookStyle(findLook('film-title') as NonNullable<ReturnType<typeof findLook>>)).toMatchObject({ textCase: 'upper' })
    expect(lookStyle(findLook('underline-title') as NonNullable<ReturnType<typeof findLook>>)).toMatchObject({ decoration: 'underline' })
    expect(lookLayerInput(findLook('whisper-caption') as NonNullable<ReturnType<typeof findLook>>).transform).toEqual({ opacity: 0.92 })
  })

  it('reads a caption look into a spoken-word state', () => {
    const look = (id: string) => findLook(id) as NonNullable<ReturnType<typeof findLook>>
    expect(lookCaptionFocus(look('social-caption'))).toEqual({ style: { color: '#F5B843' }, scale: 1.1 })
    expect(lookCaptionFocus(look('karaoke-pill'))).toEqual({
      style: { highlight: { color: look('karaoke-pill').palette.accent, radius: 12, paddingX: 14, paddingY: 6 } },
      scale: 1.06,
    })
    expect(lookCaptionFocus(look('hero-pop'))).toBeNull()
  })
})

describe('layer.create with a template', () => {
  it('starts from the look and lets what the caller gives win', async () => {
    const { ok, text } = setup()
    const { id } = await ok('layer.create', { kind: 'text', template: 'hero-pop' })
    expect(text(id).text).toBe('BIG MOMENT')
    expect(text(id).style).toMatchObject({ fontFamily: 'Archivo Black', fontSize: 140, letterSpacing: 2 })
    expect(text(id).textIn?.preset).toBe('pop-in')
    expect(text(id).sounds).toHaveLength(1)

    const own = await ok('layer.create', { kind: 'text', template: 'Hero Pop', text: 'Mine', style: { fontSize: 90, color: '#00ff00' }, sounds: [] })
    expect(text(own.id).text).toBe('Mine')
    expect(text(own.id).style).toMatchObject({ fontFamily: 'Archivo Black', fontSize: 90, color: '#00ff00' })
    expect(text(own.id).sounds).toHaveLength(0)
  })

  it('refuses an unknown template and a template on another kind of layer', async () => {
    const { fail } = setup()
    expect(await fail('layer.create', { kind: 'text', template: 'nope' })).toContain('catalog.list')
    expect(await fail('layer.create', { kind: 'shape', template: 'hero-pop' })).toContain('only applies to text')
  })
})

describe('template.apply', () => {
  it('puts a look on a text layer and keeps its words, place, box, alignment and exit', async () => {
    const { ok, text } = setup()
    const { id } = await ok('layer.create', {
      kind: 'text',
      text: 'keep these words',
      x: 120,
      y: -40,
      maxWidth: 900,
      style: { align: 'left', fontSize: 50, italic: true },
    })
    await ok('animation.set', { id, slot: 'out', preset: 'fade', target: 'layer' })
    const result = await ok('template.apply', { ids: id, templateId: 'hero-pop' })
    expect(result.applied).toEqual([{ id, name: 'keep these words' }])
    const layer = text(id)
    expect(layer.text).toBe('keep these words')
    expect(layer.transform).toMatchObject({ x: 120, y: -40 })
    expect(layer.maxWidth).toBe(900)
    expect(layer.style).toMatchObject({ fontFamily: 'Archivo Black', fontSize: 140, align: 'left', italic: false })
    expect(layer.textIn?.preset).toBe('pop-in')
    expect(layer.animOut?.preset).toBe('fade')
    expect(layer.sounds.map((s) => s.trigger.kind)).toEqual(['text'])

    await ok('layer.patch', { id, ops: [{ op: 'set', path: 'style.fontSize', value: 61 }] })
    await ok('template.apply', { ids: id, templateId: 'hero-pop', keepSize: true })
    expect(text(id).style.fontSize).toBe(61)
  })

  it('replaces the typing sound and the effects with the ones of the look', async () => {
    const { ok, text } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'neon', template: 'hero-pop', effects: [{ type: 'glow' }] })
    expect(text(id).effects.map((e) => e.type)).toEqual(['glow'])
    await ok('template.apply', { ids: id, templateId: 'hero-pop' })
    expect(text(id).effects).toHaveLength(0)
    expect(text(id).sounds).toHaveLength(1)
  })

  it('sets the spoken-word look of a caption layer', async () => {
    const { ok, text } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'wait for it' })
    await ok('caption.set', { id, even: { unit: 'word', fromMs: 0, toMs: 1500 } })
    const result = await ok('template.apply', { ids: id, templateId: 'social-caption' })
    expect(result.applied[0].captionFocus).toBe(true)
    expect(text(id).caption?.states.focus).toMatchObject({ style: { color: '#F5B843' }, scale: 1.1 })
  })

  it('is one undo step and refuses what is not text', async () => {
    const { session, ok, fail } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'one' })
    const shape = await ok('layer.create', { kind: 'shape', shape: 'rect' })
    const before = JSON.stringify(session.project)
    expect(await fail('template.apply', { ids: [id, shape.id], templateId: 'hero-pop' })).toContain('needs a text layer')
    expect(await fail('template.apply', { ids: id, templateId: 'nope' })).toContain('catalog.list')
    expect(JSON.stringify(session.project)).toBe(before)
    await ok('template.apply', { ids: id, templateId: 'hero-pop' })
    session.undo()
    expect(JSON.stringify(session.project)).toBe(before)
  })
})
