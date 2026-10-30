import { type Comp, type MotionBlurSettings, shutterSamples, shutterWindow } from '@uve/core'
import { transformPoint } from './math'
import { flattenScene, type SceneNode } from './scene'

// Motion blur planning: which nodes move while the shutter is open, and the
// node at each moment drawn for them. Groups are expanded (a member moving on
// its own blurs on its own); a nested comp is one piece.

export interface MovingNode {
  settings: MotionBlurSettings
  /** The node at each moment of the shutter, with weights summing to 1. */
  samples: { node: SceneNode; weight: number }[]
}

/** Moving nodes by layer id. */
export type MotionPlan = Map<string, MovingNode>

/** A node's centre in comp space (depth ignored). */
export function centreOf(node: SceneNode): [x: number, y: number] {
  const x = node.kind === 'leaf' ? 0 : node.box.left + node.box.width / 2
  const y = node.kind === 'leaf' ? 0 : node.box.top + node.box.height / 2
  const [px, py] = transformPoint(node.matrix, x, y, 0)
  return [px, py]
}

function corners(node: SceneNode): [number, number][] {
  const { left, top, width, height } =
    node.kind === 'leaf' ? { left: -node.content.box.width / 2, top: -node.content.box.height / 2, ...node.content.box } : node.box
  return (
    [
      [left, top],
      [left + width, top],
      [left + width, top + height],
      [left, top + height],
    ] as const
  ).map(([x, y]) => {
    const [px, py] = transformPoint(node.matrix, x, y, 0)
    return [px, py]
  })
}

/** How far any corner of a node travels between two of its moments, comp px. */
export function travel(a: SceneNode, b: SceneNode): number {
  const from = corners(a)
  const to = corners(b)
  return Math.max(...from.map(([x, y], i) => Math.hypot(((to[i] as [number, number])[0] - x), ((to[i] as [number, number])[1] - y))))
}

const byId = (scene: readonly SceneNode[]) => new Map(flattenScene(scene).map((n) => [n.layer.id, n]))

/**
 * Plans the motion blur of the frame at `timeMs`: for each node whose layer
 * and comp have it on and that moves while its shutter is open, the node at
 * evenly spread moments of the shutter. `build` makes the scene at a comp
 * time; scenes are built once per moment. Moments are about 1.5 output px of
 * travel apart, at most the shutter's `maxSamples` (and `cap`).
 */
export function planMotion(comp: Comp, scene: readonly SceneNode[], build: (timeMs: number) => readonly SceneNode[], timeMs: number, scale: number, cap?: number): MotionPlan {
  const plan: MotionPlan = new Map()
  if (!comp.motionBlur.enabled) return plan
  const nodes = flattenScene(scene).filter((n) => n.resolved.motionBlur.enabled)
  if (nodes.length === 0) return plan
  const scenes = new Map<number, Map<string, SceneNode>>()
  const at = (t: number) => {
    let found = scenes.get(t)
    if (!found) {
      found = byId(build(t))
      scenes.set(t, found)
    }
    return found
  }
  // Layers that override the shutter are planned with their own moments.
  const { enabled: _, ...master } = comp.motionBlur
  const bySettings = new Map<string, { settings: MotionBlurSettings; nodes: SceneNode[] }>()
  for (const node of nodes) {
    const settings = node.resolved.motionBlur.override ?? master
    const key = JSON.stringify(settings)
    const entry = bySettings.get(key) ?? { settings, nodes: [] }
    entry.nodes.push(node)
    bySettings.set(key, entry)
  }
  for (const { settings, nodes: group } of bySettings.values()) {
    if (settings.shutterAngle <= 0 || settings.amount <= 0 || settings.strength <= 0) continue
    const [open, close] = shutterWindow(settings, timeMs, comp.fps)
    const first = at(open)
    const last = at(close)
    const moving = group
      .map((node) => {
        const a = first.get(node.layer.id)
        const b = last.get(node.layer.id)
        return { node, travel: a && b ? Math.max(travel(a, node), travel(node, b), travel(a, b)) * scale : 0 }
      })
      .filter((m) => m.travel > 0.5)
    if (moving.length === 0) continue
    const most = Math.max(...moving.map((m) => m.travel))
    const count = Math.max(2, Math.min(settings.maxSamples, cap ?? Number.POSITIVE_INFINITY, Math.ceil(most / 1.5) + 1))
    const moments = shutterSamples(settings, timeMs, comp.fps, count)
    for (const { node } of moving) {
      const samples = moments.flatMap((m) => {
        const sample = at(m.timeMs).get(node.layer.id)
        return sample ? [{ node: sample, weight: m.weight }] : []
      })
      const total = samples.reduce((sum, s) => sum + s.weight, 0)
      if (samples.length >= 2 && total > 0) plan.set(node.layer.id, { settings, samples: samples.map((s) => ({ ...s, weight: s.weight / total })) })
    }
  }
  return plan
}
