import { WorldRenderSchema } from '@uve/core'
import { MeshStandardMaterial, ShadowMaterial } from 'three'
import { describe, expect, it } from 'vitest'
import { floorKindOf, floorLook, makeFloor, reflectionMatrix, syncFloor } from './floor'

const floor = (extra: Record<string, unknown>) => WorldRenderSchema.parse({ floor: extra }).floor

describe('the floor', () => {
  it('has no material for mode none and hides', () => {
    expect(floorKindOf('none')).toBeNull()
    expect(floorLook(floor({ mode: 'none' }))).toBeNull()
    const rig = makeFloor()
    syncFloor(rig, floor({ mode: 'none' }))
    expect(rig.group.visible).toBe(false)
  })

  it('chooses a material for each mode', () => {
    const rig = makeFloor()
    syncFloor(rig, floor({ mode: 'shadow', color: '#336699', opacity: 0.3 }))
    expect(rig.mesh.material).toBeInstanceOf(ShadowMaterial)
    expect(rig.group.visible).toBe(true)
    const shadow = rig.mesh.material as ShadowMaterial
    expect(shadow.opacity).toBeCloseTo(0.3, 9)
    expect(shadow.transparent).toBe(true)
    // A see-through floor must not hide what is behind it.
    expect(shadow.depthWrite).toBe(false)
    expect(shadow.color.getHexString()).toBe('336699')

    syncFloor(rig, floor({ mode: 'solid', opacity: 0.2 }))
    const solid = rig.mesh.material as MeshStandardMaterial
    expect(solid).toBeInstanceOf(MeshStandardMaterial)
    expect(solid.roughness).toBeCloseTo(0.85, 9)
    expect(solid.transparent).toBe(false)
    expect(solid.opacity).toBe(1)

    syncFloor(rig, floor({ mode: 'mirror', opacity: 0.45 }))
    const mirror = rig.mesh.material as MeshStandardMaterial
    expect(mirror).not.toBe(solid)
    expect(mirror.roughness).toBeCloseTo(0.25, 9)
    expect(mirror.opacity).toBeCloseTo(0.45, 9)
    expect(mirror.transparent).toBe(true)
    expect(rig.kind).toBe('mirror')
  })

  it('stands at the floor height and receives shadows', () => {
    const rig = makeFloor()
    syncFloor(rig, floor({ mode: 'solid', z: -120 }))
    expect(rig.mesh.position.z).toBe(-120)
    expect(rig.mesh.receiveShadow).toBe(true)
    // 2e5 px square, scaled to three units by its group.
    expect(rig.geometry.parameters.width).toBe(2e5)
    expect(rig.group.scale.x).toBeCloseTo(0.01, 12)
  })

  it('mirrors in z about the floor height (three units)', () => {
    const m = reflectionMatrix(100)
    // z' = -z + 2 * 1.0
    expect(m[10]).toBe(-1)
    expect(m[14]).toBeCloseTo(2, 12)
    expect(m[0]).toBe(1)
    expect(m[5]).toBe(1)
  })
})
