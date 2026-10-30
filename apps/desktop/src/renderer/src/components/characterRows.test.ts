import { describe, expect, it } from 'vitest'
import { BEHAVIOR_FIELDS, lifeNotes, lifeToggles } from './characterRows'

describe('lifeToggles', () => {
  it('is all off with no behaviours', () => {
    expect(lifeToggles([])).toEqual({ blink: false, breathe: false, nod: false, talk: false, look: false })
  })
  it('turns a function on for its behaviour, and look for glance', () => {
    expect(lifeToggles([{ type: 'blink' }, { type: 'glance' }, { type: 'sway' }])).toEqual({ blink: true, breathe: false, nod: false, talk: false, look: true })
  })
})

describe('lifeNotes', () => {
  it('lists only reasons, in function order', () => {
    const life = { blink: 'No eyes found', breathe: 'on', nod: 'Nods with a voice', talk: 'can', look: 'off' }
    expect(lifeNotes(life)).toEqual(['Blink: No eyes found', 'Nod: Nods with a voice'])
  })
  it('ignores anything that is not a report', () => {
    expect(lifeNotes(undefined)).toEqual([])
    expect(lifeNotes('x')).toEqual([])
  })
})

describe('BEHAVIOR_FIELDS', () => {
  it('has fields for every behaviour type', () => {
    expect(Object.keys(BEHAVIOR_FIELDS).sort()).toEqual(['blink', 'breathe', 'glance', 'nod', 'sway', 'talk'])
  })
})
