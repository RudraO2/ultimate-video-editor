import type { Behavior } from '@uve/core'

// What the character sections show, as plain data and small pure functions:
// which life functions are on, why the others are not, and which number fields
// each behaviour type has.

export const LIFE_KEYS = ['blink', 'breathe', 'nod', 'talk', 'look'] as const
export type LifeKey = (typeof LIFE_KEYS)[number]

export const LIFE_LABELS: Record<LifeKey, string> = { blink: 'Blink', breathe: 'Breathe', nod: 'Nod', talk: 'Talk', look: 'Look' }

/** The behaviour that stands for each life function (looking is the glance behaviour). */
export const LIFE_BEHAVIOR: Record<LifeKey, Behavior['type']> = { blink: 'blink', breathe: 'breathe', nod: 'nod', talk: 'talk', look: 'glance' }

/** Which life functions are on: each is on when a behaviour of its type exists. */
export function lifeToggles(behaviors: readonly Pick<Behavior, 'type'>[]): Record<LifeKey, boolean> {
  const has = (type: Behavior['type']) => behaviors.some((b) => b.type === type)
  return { blink: has('blink'), breathe: has('breathe'), nod: has('nod'), talk: has('talk'), look: has('glance') }
}

const LIFE_STATES = new Set(['on', 'off', 'can'])

/** The reasons a life report gives for what could not be done ("Talk: No voice: add a voice line to talk"); states on, off and can say nothing. */
export function lifeNotes(life: unknown): string[] {
  if (typeof life !== 'object' || life === null) return []
  const report = life as Record<string, unknown>
  return LIFE_KEYS.flatMap((key) => {
    const state = report[key]
    return typeof state === 'string' && !LIFE_STATES.has(state) ? [`${LIFE_LABELS[key]}: ${state}`] : []
  })
}

export interface BehaviorField {
  key: string
  label: string
  step: number
  precision: number
  min?: number
  max?: number
  suffix?: string
}

export const BEHAVIOR_TITLES: Record<Behavior['type'], string> = { blink: 'Blink', breathe: 'Breathe', sway: 'Sway', nod: 'Nod', glance: 'Look', talk: 'Talk' }

/** The main number fields of each behaviour type (limits as the schema has them). */
export const BEHAVIOR_FIELDS: Record<Behavior['type'], readonly BehaviorField[]> = {
  blink: [
    { key: 'every', label: 'Every', step: 0.1, precision: 1, min: 0.5, max: 30, suffix: 's' },
    { key: 'closedMs', label: 'Shut for', step: 5, precision: 0, min: 40, max: 800, suffix: 'ms' },
  ],
  breathe: [
    { key: 'amount', label: 'Amount', step: 0.1, precision: 1, min: 0, max: 20, suffix: '%' },
    { key: 'rate', label: 'Rate', step: 1, precision: 0, min: 2, max: 60, suffix: '/min' },
  ],
  sway: [
    { key: 'amount', label: 'Amount', step: 0.1, precision: 1, min: 0, max: 30, suffix: '°' },
    { key: 'speed', label: 'Speed', step: 0.01, precision: 2, min: 0.01, max: 5, suffix: 'Hz' },
  ],
  nod: [{ key: 'amount', label: 'Amount', step: 0.1, precision: 1, min: -90, max: 90, suffix: '°' }],
  glance: [
    { key: 'rangeX', label: 'Range X', step: 1, precision: 0, min: 0, suffix: 'px' },
    { key: 'rangeY', label: 'Range Y', step: 1, precision: 0, min: 0, suffix: 'px' },
    { key: 'hold', label: 'Hold', step: 0.1, precision: 1, min: 0, suffix: 's' },
  ],
  talk: [{ key: 'lead', label: 'Lead', step: 1, precision: 0, min: -200, max: 200, suffix: 'ms' }],
}

/** A number field of a behaviour, or 0 when it has none. */
export function behaviorNumber(behavior: Behavior, key: string): number {
  const value = (behavior as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : 0
}
