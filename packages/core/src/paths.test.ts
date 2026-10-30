import { describe, expect, it } from 'vitest'
import { CommandError } from './errors'
import { applyPatchOps } from './paths'

const sample = () => ({
  style: { color: '#ffffff', align: 'center' },
  effects: [
    { id: 'fx_1', enabled: true },
    { id: 'fx_2', enabled: true },
  ],
})

describe('applyPatchOps', () => {
  it('sets nested keys and list items by index or id', () => {
    const doc = sample()
    applyPatchOps(doc, [
      { op: 'set', path: 'style.color', value: '#000000' },
      { op: 'set', path: 'effects[id=fx_2].enabled', value: false },
      { op: 'set', path: 'effects[0].enabled', value: false },
    ])
    expect(doc.style.color).toBe('#000000')
    expect(doc.effects.map((e) => e.enabled)).toEqual([false, false])
  })

  it('inserts, appends, moves and removes list items', () => {
    const doc = sample()
    applyPatchOps(doc, [
      { op: 'insert', path: 'effects[0]', value: { id: 'fx_0', enabled: true } },
      { op: 'set', path: 'effects[-]', value: { id: 'fx_3', enabled: true } },
      { op: 'move', path: 'effects[id=fx_3]', to: 0 },
      { op: 'remove', path: 'effects[id=fx_1]' },
    ])
    expect(doc.effects.map((e) => e.id)).toEqual(['fx_3', 'fx_0', 'fx_2'])
  })

  it('merges into objects and removes keys', () => {
    const doc: Record<string, unknown> = sample()
    applyPatchOps(doc, [
      { op: 'merge', path: 'style', value: { align: 'left', italic: true } },
      { op: 'remove', path: 'style.color' },
    ])
    expect(doc.style).toEqual({ align: 'left', italic: true })
  })

  it('reports bad paths as command errors', () => {
    expect(() => applyPatchOps(sample(), [{ op: 'set', path: 'style..color', value: 1 }])).toThrow(CommandError)
    expect(() => applyPatchOps(sample(), [{ op: 'set', path: 'effects[5].enabled', value: 1 }])).toThrow(/past the end/)
    expect(() => applyPatchOps(sample(), [{ op: 'remove', path: 'effects[id=nope]' }])).toThrow(/no item/)
    expect(() => applyPatchOps(sample(), [{ op: 'merge', path: 'effects', value: {} }])).toThrow(/needs an object/)
  })

  it('refuses prototype keys', () => {
    expect(() => applyPatchOps({}, [{ op: 'set', path: '__proto__.polluted', value: true }])).toThrow(/not allowed/)
    expect(() => applyPatchOps(sample(), [{ op: 'merge', path: 'style', value: JSON.parse('{"__proto__": {}}') }])).toThrow(
      /not allowed/,
    )
  })
})
