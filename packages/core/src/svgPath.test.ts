import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { sampleKeys } from './interpolate'
import { Session } from './session'
import { mixSvgPaths, normalizeSvgPath, parseSvgPath, svgPathBounds } from './svgPath'

describe('SVG path data', () => {
  it('normalises relative, shorthand and implicit commands to absolute M, L, C, Q and Z', () => {
    expect(normalizeSvgPath('m10 10 h20 v20 l-20 0 z')).toBe('M10 10 L30 10 L30 30 L10 30 Z')
    expect(normalizeSvgPath('M0 0 10 0 10 10')).toBe('M0 0 L10 0 L10 10')
    expect(normalizeSvgPath('M0 0 C 0 10 10 10 10 0 S 20 -10 20 0')).toBe('M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0')
    expect(normalizeSvgPath('M0 0 Q 5 10 10 0 T 20 0')).toBe('M0 0 Q5 10 10 0 Q15 -10 20 0')
    expect(normalizeSvgPath('M-1.5e1,0L.5.5')).toBe('M-15 0 L0.5 0.5')
  })

  it('turns arcs into cubic curves that keep their ends and their shape', () => {
    const half = parseSvgPath('M0 0 A 50 50 0 0 1 100 0')
    expect(half.every((c) => c.c === 'M' || c.c === 'C')).toBe(true)
    expect(half.at(-1)?.p.slice(-2)).toEqual([100, 0])
    const b = svgPathBounds(half)
    // A half circle of radius 50 over the line, sweeping up (to -y).
    expect(b.left).toBeCloseTo(0)
    expect(b.width).toBeCloseTo(100)
    expect(b.top).toBeCloseTo(-50, 0)
    expect(b.height).toBeCloseTo(50, 0)
  })

  it('refuses data that is not a path, saying why', () => {
    expect(() => parseSvgPath('L 0 0')).toThrow(/must start with M/)
    expect(() => parseSvgPath('M 0 0 L 10')).toThrow(/needs 2 numbers/)
    expect(() => parseSvgPath('M 0 0 X 10 10')).toThrow(/"X" is not a command/)
  })

  it('morphs paths with the same commands and holds when they differ', () => {
    expect(mixSvgPaths('M0 0 L10 0', 'M0 10 L20 0', 0.5)).toBe('M0 5 L15 0')
    expect(mixSvgPaths('M0 0 L10 0', 'M0 0 C1 1 2 2 3 3', 0.5)).toBeNull()
    const keys = [
      { t: 0, v: 'M0 0 L10 0', ease: 'linear' as const },
      { t: 100, v: 'M0 10 L20 0', ease: 'linear' as const },
    ]
    expect(sampleKeys(keys, 25)).toBe('M0 2.5 L12.5 0')
  })
})

describe('path layers', () => {
  it('creates a path from d, with a light line when bare, and keys its geometry', async () => {
    const ids = sequentialIds()
    const session = new Session({ project: createDefaultProject(ids), ids })
    const created = await session.call('layer.create', { kind: 'path', d: 'm0 0 l100 0 l-50 80 z' })
    if (!created.ok) throw new Error(created.error)
    const layer = session.project.comps[0]?.tracks[0]?.layers[0]
    if (layer?.kind !== 'path') throw new Error('not a path')
    expect(layer.geometry).toBe('M0 0 L100 0 L50 80 Z')
    expect(layer.strokes).toMatchObject([{ width: 4, paint: { color: '#e8e8ee' } }])
    expect(layer.name).toBe('Path')
    const keyed = await session.call('keyframes.set', {
      id: layer.id,
      property: 'geometry',
      keys: [
        { at: 0, value: 'M0 0 L100 0 L50 80 Z' },
        { at: 500, value: 'm0 0 l100 0 l-50 -80 z' },
      ],
    })
    expect(keyed.ok).toBe(true)
    expect(session.project.comps[0]?.tracks[0]?.layers[0]?.animations.geometry?.[1]?.v).toBe('M0 0 L100 0 L50 -80 Z')
    const bad = await session.call('layer.set', { id: layer.id, values: { geometry: 'nonsense' } })
    expect(bad.ok).toBe(false)
    const filled = await session.call('layer.create', { kind: 'path', d: 'M0 0 L10 0 L5 5 Z', fill: '#ff0000' })
    expect(filled.ok && session.project.comps[0]?.tracks[0]?.layers[0]).toMatchObject({ strokes: [], fills: [{ color: '#ff0000' }] })
    const star = await session.call('layer.create', { kind: 'shape', shape: 'star', pointCount: 6, innerRatio: 0.4 })
    expect(star.ok && session.project.comps[0]?.tracks[0]?.layers[0]).toMatchObject({ name: 'Star', shape: { type: 'star', pointCount: 6, innerRatio: 0.4 } })
  })
})
