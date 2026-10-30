import { type Comp } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { aoRows, bloomRows, cameraRows, dofRows, floorRows, focusCandidates, lightRows, materialRows, meshRows, worldTransformRows } from './worldRows'

describe('worldTransformRows', () => {
  it('gives pictures every row', () => {
    expect(worldTransformRows('text')).toEqual({ scale: true, pivot: true, opacity: true })
    expect(worldTransformRows('nested')).toEqual({ scale: true, pivot: true, opacity: true })
  })
  it('gives spatial kinds only what they use', () => {
    expect(worldTransformRows('camera')).toEqual({ scale: false, pivot: false, opacity: false })
    expect(worldTransformRows('light')).toEqual({ scale: false, pivot: false, opacity: false })
    expect(worldTransformRows('empty')).toEqual({ scale: true, pivot: false, opacity: false })
    expect(worldTransformRows('mesh')).toEqual({ scale: true, pivot: false, opacity: false })
  })
})

describe('meshRows', () => {
  it('shows the auto angle only for auto shading', () => {
    expect(meshRows('auto')).toEqual({ autoAngle: true })
    expect(meshRows('smooth')).toEqual({ autoAngle: false })
    expect(meshRows('flat')).toEqual({ autoAngle: false })
  })
})

describe('lightRows', () => {
  it('shows range for point and spot, and the cone only for spot', () => {
    expect(lightRows('point')).toMatchObject({ range: true, spot: false, shadow: true })
    expect(lightRows('spot')).toMatchObject({ range: true, spot: true, shadow: true })
  })
  it('shows size for area, ground for hemisphere, a preset for environment', () => {
    expect(lightRows('area')).toMatchObject({ area: true, range: false })
    expect(lightRows('hemisphere')).toMatchObject({ ground: true, shadow: false })
    expect(lightRows('environment')).toMatchObject({ environment: true, shadow: false })
    expect(lightRows('sun')).toMatchObject({ shadow: true, range: false })
  })
})

describe('cameraRows', () => {
  it('shows the ortho scale only when orthographic and focus only with depth of field', () => {
    expect(cameraRows('perspective', false)).toEqual({ orthoScale: false, focus: false })
    expect(cameraRows('orthographic', true)).toEqual({ orthoScale: true, focus: true })
  })
})

describe('materialRows', () => {
  it('gives pbr the physical rows, the coat and refraction only when used', () => {
    expect(materialRows('pbr', 0, 0)).toMatchObject({ roughness: true, metalness: true, refraction: false, clearcoatRoughness: false, toonSteps: false, emission: true })
    expect(materialRows('pbr', 1, 0.5)).toMatchObject({ refraction: true, clearcoatRoughness: true })
  })
  it('gives toon its bands and unlit nothing but the tint', () => {
    expect(materialRows('toon', 1, 1)).toMatchObject({ toonSteps: true, roughness: false, refraction: false, emission: true })
    expect(materialRows('unlit', 0, 0)).toMatchObject({ toonSteps: false, metalness: false, emission: false })
  })
})

describe('look rows', () => {
  it('shows bloom, occlusion and floor settings only when they do something', () => {
    expect(bloomRows(true)).toEqual({ settings: true })
    expect(bloomRows(false)).toEqual({ settings: false })
    expect(aoRows(false)).toEqual({ settings: false })
    expect(floorRows('none')).toEqual({ settings: false })
    expect(floorRows('mirror')).toEqual({ settings: true })
  })
  it('dims the focus distance while a focus layer is set', () => {
    expect(dofRows(false, null)).toEqual({ settings: false, distanceOverridden: false })
    expect(dofRows(true, null)).toEqual({ settings: true, distanceOverridden: false })
    expect(dofRows(true, 'lyr_1')).toEqual({ settings: true, distanceOverridden: true })
  })
})

describe('focusCandidates', () => {
  const layer = (id: string, kind: string) => ({ id, kind, name: id })
  const comp = { tracks: [{ layers: [layer('cam', 'camera'), layer('t', 'text')] }, { layers: [layer('m', 'mesh'), layer('l', 'light'), layer('a', 'audio'), layer('e', 'empty'), layer('g', 'group')] }] } as unknown as Comp
  it('lists pictures, meshes and controllers, not the camera, lights, groups or sound', () => {
    expect(focusCandidates(comp, 'cam').map((c) => c.id)).toEqual(['t', 'm', 'e'])
  })
})
