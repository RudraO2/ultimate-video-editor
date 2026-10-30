import { ancestorGroups, type Comp, type GroupLayer, isWorld, type Project } from '@uve/core'
import type { CompRenderer, GroupNode, SceneNode } from '@uve/engine'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { beginGesture, useEditor } from '../store'
import { type BoneHit, hitBone, type Pt, poseDelta, type RigOverlay, rigOverlay, sweepDeg } from './rigOverlay'

// Bones of the selected rig on the viewport, and posing them by dragging.
// Every edit is `rig.pose` inside one gesture (one undo step per drag).

/** A press must move this far before it starts posing, so a click only picks the bone. */
const DRAG_PX = 3

interface Shown {
  overlay: RigOverlay
  /** On a locked track: drawn, never hit. */
  locked: boolean
}

/** The overlay of the last draw, for hit testing between draws. */
let current: Shown | null = null
/** The bone last picked or posed (drawn in the accent colour); forgotten when another rig shows. */
let picked: { rigId: string; boneId: string } | null = null

/** The group node of a layer, found depth first. */
function groupNodeOf(nodes: readonly SceneNode[], id: string): GroupNode | undefined {
  for (const node of nodes) {
    if (node.kind !== 'group') continue
    if (node.layer.id === id) return node
    const found = groupNodeOf(node.children, id)
    if (found) return found
  }
  return undefined
}

/** The rig that goes with the selection: the selected rig group, or the nearest rig above the selected member. */
export function rigGroupFor(comp: Comp, selectedLayerId: string | null): GroupLayer | null {
  if (selectedLayerId === null) return null
  const layer = comp.tracks.flatMap((t) => t.layers).find((l) => l.id === selectedLayerId)
  if (!layer) return null
  if (layer.kind === 'group' && layer.rig) return layer
  return ancestorGroups(comp, layer.id).find((g) => g.rig && g.rig.bones.length > 0) ?? null
}

export interface RigState {
  project: Project
  timeMs: number
  tool: string
  selectedLayerId: string | null
  pen: unknown
}

/**
 * Builds the overlay for the selection's rig (Move tool only) and keeps it for hit
 * testing. `frameWidth` is the artboard's width in CSS px. The scene is built only
 * when a rig is shown.
 */
export function updateRigOverlay(renderer: Pick<CompRenderer, 'scene'>, state: RigState, comp: Comp, frameWidth: number): RigOverlay | null {
  current = null
  if (frameWidth <= 0 || state.tool !== 'move' || state.pen !== null || isWorld(comp)) return null
  const group = rigGroupFor(comp, state.selectedLayerId)
  if (!group?.rig || group.rig.bones.length === 0) return null
  const node = groupNodeOf(renderer.scene(comp, state.project, state.timeMs), group.id)
  if (!node) return null
  const k = frameWidth / comp.width
  const toScreen = (x: number, y: number): Pt => [(x + comp.width / 2) * k, (y + comp.height / 2) * k]
  const overlay = rigOverlay(group, node.resolved.bones ?? group.rig.bones, toScreen, node.matrix)
  if (picked && (picked.rigId !== group.id || !overlay.bones.some((b) => b.id === picked?.boneId))) picked = null
  current = { overlay, locked: node.locked }
  return overlay
}

/** The bone being posed or last posed in this overlay. */
export const pickedBone = (overlay: RigOverlay): string | null => (picked?.rigId === overlay.rigId ? picked.boneId : null)

/** The bone part of the shown rig under a point (CSS px from the artboard's top-left), or null. */
export function rigHitAt(point: Pt): { overlay: RigOverlay; hit: BoneHit } | null {
  if (!current || current.locked) return null
  const hit = hitBone(current.overlay, point)
  return hit ? { overlay: current.overlay, hit } : null
}

/**
 * Starts posing the bone under a press: turning it about its head (the angle swept
 * by the pointer), or with Shift on a control moving it. Returns false when the
 * press hit nothing that can be posed. The drag is one undo step, ended on pointer
 * up, cancel and lost capture.
 */
export function startRigDrag(e: ReactPointerEvent<HTMLElement>, found: { overlay: RigOverlay; hit: BoneHit }, point: (e: { clientX: number; clientY: number }) => Pt): boolean {
  const { overlay, hit } = found
  const bone = overlay.bones.find((b) => b.id === hit.boneId)
  if (!bone) return false
  picked = { rigId: overlay.rigId, boneId: bone.id }
  useEditor.setState({}) // Redraw with the bone picked.
  const target = e.currentTarget
  const moving = e.shiftKey && bone.control
  const start = overlay.space.fromScreen(point(e))
  const startPose = bone.pose
  let last = start
  let turned = 0
  let gesture: ReturnType<typeof beginGesture> | null = null

  const move = (ev: PointerEvent) => {
    const screen = point(ev)
    if (!gesture) {
      const from = point(e)
      if (Math.hypot(screen[0] - from[0], screen[1] - from[1]) < DRAG_PX) return
      gesture = beginGesture('Pose bone')
    }
    const now = overlay.space.fromScreen(screen)
    if (Number.isNaN(now[0]) || Number.isNaN(now[1])) return
    let pose: { bone: string; rotation?: number; x?: number; y?: number }
    if (moving) {
      const [dx, dy] = poseDelta(bone, [now[0] - start[0], now[1] - start[1]])
      pose = { bone: bone.id, x: round(startPose.x + dx), y: round(startPose.y + dy) }
    } else {
      // Sweeps add up step by step, so a turn of more than half a circle keeps going.
      turned += sweepDeg(bone.headRig, last, now)
      pose = { bone: bone.id, rotation: round(startPose.rotation + turned) }
    }
    const poses = [pose]
    last = now
    gesture.request('rig.pose', { rigId: overlay.rigId, atMs: useEditor.getState().timeMs, poses })
  }
  const finish = () => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', finish)
    target.removeEventListener('pointercancel', finish)
    target.removeEventListener('lostpointercapture', finish)
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
    void gesture?.end()
    gesture = null
  }
  try {
    target.setPointerCapture(e.pointerId)
  } catch {
    // The pointer is already gone (or synthetic); events sent to the target still work.
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', finish)
  target.addEventListener('pointercancel', finish)
  target.addEventListener('lostpointercapture', finish)
  return true
}

const round = (v: number) => Math.round(v * 10) / 10
