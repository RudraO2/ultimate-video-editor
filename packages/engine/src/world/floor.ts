import type { World } from '@uve/core'
import { DoubleSide, FrontSide, Group, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, ShadowMaterial } from 'three'
import { WORLD_UNIT } from './threeCamera'

// The world's floor: a square of 2e5 px at height `floor.z` (Z is up) that
// lives in its own group beside the pictures, so it is left out of the
// bounds a sun's shadow is fitted to. `shadow` shows only the shadows that
// fall on it, `solid` is a matte ground, `mirror` is a glossy ground over a
// reflection (stage.ts renders the scene mirrored in z first).

export const FLOOR_SIZE = 2e5

export type FloorKind = 'shadow' | 'solid' | 'mirror'

type Floor = World['render']['floor']

/** Which kind of material a floor mode uses; null for no floor. */
export const floorKindOf = (mode: Floor['mode']): FloorKind | null => (mode === 'none' ? null : mode)

/** The settings of a floor's material (what `syncFloor` applies), as plain data. */
export interface FloorLook {
  kind: FloorKind
  color: string
  opacity: number
  roughness: number
  transparent: boolean
  /** A see-through floor must not hide what is behind it. */
  depthWrite: boolean
}

export function floorLook(floor: Floor): FloorLook | null {
  const kind = floorKindOf(floor.mode)
  if (!kind) return null
  const color = floor.color.slice(0, 7)
  switch (kind) {
    case 'shadow':
      return { kind, color, opacity: floor.opacity, roughness: 1, transparent: true, depthWrite: false }
    case 'solid':
      return { kind, color, opacity: 1, roughness: 0.85, transparent: false, depthWrite: true }
    case 'mirror':
      return { kind, color, opacity: floor.opacity, roughness: 0.25, transparent: floor.opacity < 1, depthWrite: true }
  }
}

/** The matrix (three units, column-major) that mirrors the world in z about the floor's height. */
export function reflectionMatrix(floorZ: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 2 * floorZ * WORLD_UNIT, 1]
}

/** A floor's three.js objects, kept between frames. */
export interface FloorRig {
  group: Group
  mesh: Mesh
  materials: Partial<Record<FloorKind, ShadowMaterial | MeshStandardMaterial>>
  kind: FloorKind | null
  geometry: PlaneGeometry
}

export function makeFloor(): FloorRig {
  const group = new Group()
  group.scale.setScalar(WORLD_UNIT)
  // Drawn before every other transparent object (their depth order is by their own origins).
  group.renderOrder = -1000
  group.visible = false
  const geometry = new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE)
  const mesh = new Mesh(geometry)
  mesh.frustumCulled = false
  mesh.receiveShadow = true
  group.add(mesh)
  return { group, mesh, materials: {}, kind: null, geometry }
}

export function disposeFloor(rig: FloorRig): void {
  rig.group.removeFromParent()
  rig.geometry.dispose()
  for (const material of Object.values(rig.materials)) material?.dispose()
  rig.materials = {}
}

function materialOf(rig: FloorRig, kind: FloorKind): ShadowMaterial | MeshStandardMaterial {
  let material = rig.materials[kind]
  if (!material) {
    material = kind === 'shadow' ? new ShadowMaterial({ side: FrontSide }) : new MeshStandardMaterial({ metalness: 0, side: kind === 'mirror' ? FrontSide : DoubleSide })
    rig.materials[kind] = material
  }
  return material
}

/** Brings the floor to the world's settings: its material, height and whether it is there. */
export function syncFloor(rig: FloorRig, floor: Floor): void {
  const look = floorLook(floor)
  rig.group.visible = look !== null
  rig.kind = look?.kind ?? null
  if (!look) return
  const material = materialOf(rig, look.kind)
  if (rig.mesh.material !== material) rig.mesh.material = material
  material.color.set(look.color)
  material.opacity = look.opacity
  if (material.transparent !== look.transparent || material.depthWrite !== look.depthWrite) material.needsUpdate = true
  material.transparent = look.transparent
  material.depthWrite = look.depthWrite
  if (material instanceof MeshStandardMaterial) material.roughness = look.roughness
  rig.mesh.position.z = floor.z
  rig.mesh.updateMatrix()
}

/** The mirror matrix as a three Matrix4. */
export const reflectionOf = (floorZ: number): Matrix4 => new Matrix4().fromArray(reflectionMatrix(floorZ))
