import { CommandError } from './errors'
import { groupDescendants, groupMembers } from './groups'
import type { Behavior, Bone, Comp, GroupLayer, Layer, Project } from './schema'

// Helpers for characters (Q7): switches, rigs and behaviours are stored on
// groups, and the commands in `commands/switch.ts`, `rig.ts` and
// `behaviors.ts` all look things up the same way. Pure functions, no writes.

/** A name for matching: lower case, letters and digits only ("Eyes Closed" and "eyes_closed" match). */
export const looseName = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** One member of a switch (or any group), counted from the top. */
export interface MemberInfo {
  index: number
  id: string
  name: string
}

/** The direct members of a group, front first, with their index. */
export function memberInfos(comp: Comp, group: GroupLayer): MemberInfo[] {
  return groupMembers(comp, group.id).map((l, index) => ({ index, id: l.id, name: l.name }))
}

const listMembers = (members: MemberInfo[]) => members.map((m) => `${m.index} ${m.name}`).join(', ')

/** The member of a group a name (case and punctuation ignored) or an index points to. */
export function findMember(comp: Comp, group: GroupLayer, ref: string | number): MemberInfo {
  const members = memberInfos(comp, group)
  if (members.length === 0) throw new CommandError(`"${group.name}" has no members.`, 'Put layers in the group first.')
  if (typeof ref === 'number') {
    const found = members[ref]
    if (!found) throw new CommandError(`"${group.name}" has no member ${ref}.`, `Its members, from the top: ${listMembers(members)}.`)
    return found
  }
  const wanted = looseName(ref)
  const found = members.find((m) => m.name === ref) ?? members.find((m) => looseName(m.name) === wanted) ?? (/^\d+$/.test(ref) ? members[Number(ref)] : undefined)
  if (!found) throw new CommandError(`"${group.name}" has no member "${ref}".`, `Its members, from the top: ${listMembers(members)}.`)
  return found
}

/** The bone a name (case and punctuation ignored) or id points to. */
export function findBone(bones: readonly Bone[], ref: string, what = 'rig'): Bone {
  const wanted = looseName(ref)
  const found = bones.find((b) => b.id === ref) ?? bones.find((b) => b.name === ref) ?? bones.find((b) => looseName(b.name) === wanted)
  if (!found) {
    throw new CommandError(`The ${what} has no bone "${ref}".`, bones.length > 0 ? `Its bones: ${bones.map((b) => `${b.id} (${b.name})`).join(', ')}.` : 'It has no bones yet: rig.bone {add: […]} makes some.')
  }
  return found
}

/** A layer of a group, at any depth, by id or by a name only one of them has. */
export function findUnder(comp: Comp, group: GroupLayer, ref: string): Layer {
  const inside = groupDescendants(comp, group.id)
  const byId = inside.find((l) => l.id === ref)
  if (byId) return byId
  const named = inside.filter((l) => l.name === ref)
  if (named.length === 1) return named[0] as Layer
  if (named.length > 1) throw new CommandError(`Several layers in "${group.name}" are named "${ref}".`, `Use an id: ${named.map((l) => l.id).join(', ')}.`)
  const loose = inside.filter((l) => looseName(l.name) === looseName(ref))
  if (loose.length === 1) return loose[0] as Layer
  throw new CommandError(
    `"${ref}" is not a layer of "${group.name}".`,
    inside.length > 0 ? `Its layers: ${inside.map((l) => `${l.id} (${l.name})`).join(', ')}.` : 'The group is empty.',
  )
}

/** A range [min, max] that is the wrong way round, or null when every range is fine. */
export function limitsProblem(limits: Record<string, readonly [number, number] | undefined> | null | undefined): string | null {
  for (const [channel, range] of Object.entries(limits ?? {})) {
    if (range && !(range[0] <= range[1])) return `limits.${channel} is [${range[0]}, ${range[1]}]: the minimum must not be above the maximum.`
  }
  return null
}

/** A pose value held to the bone's limit for its channel. */
export function clampToLimits(bone: Bone, channel: 'rotation' | 'x' | 'y' | 'scale', value: number): number {
  const range = bone.limits?.[channel]
  return range ? Math.min(range[1], Math.max(range[0], value)) : value
}

/** A bone that is its own ancestor, if any. */
export function boneCycle(bones: readonly Bone[]): Bone | undefined {
  const byId = new Map(bones.map((b) => [b.id, b]))
  for (const bone of bones) {
    const seen = new Set<string>()
    for (let at: Bone | undefined = bone; at; at = at.parent === null ? undefined : byId.get(at.parent)) {
      if (seen.has(at.id)) return bone
      seen.add(at.id)
    }
  }
  return undefined
}

/** The layers a behaviour points at (not its voice, which lives anywhere in the comp). */
export function behaviorLayers(b: Behavior): string[] {
  switch (b.type) {
    case 'blink':
      return b.eyes
    case 'glance':
      return b.layers
    case 'talk':
      return [b.mouth]
    default:
      return b.layer !== undefined ? [b.layer] : []
  }
}

/** A behaviour with its layer references mapped (to the copies of a duplicate); ids not in the map stay. */
export function remapBehavior(b: Behavior, map: ReadonlyMap<string, string>): Behavior {
  const to = (id: string) => map.get(id) ?? id
  switch (b.type) {
    case 'blink':
      return { ...b, eyes: b.eyes.map(to) }
    case 'glance':
      return { ...b, layers: b.layers.map(to) }
    case 'talk':
      return { ...b, mouth: to(b.mouth), voice: b.voice === null ? null : to(b.voice) }
    case 'nod':
      return { ...b, ...(b.layer !== undefined ? { layer: to(b.layer) } : {}), voice: b.voice === null ? null : to(b.voice) }
    default:
      return { ...b, ...(b.layer !== undefined ? { layer: to(b.layer) } : {}) }
  }
}

/**
 * Cleans up after layers were deleted (in a draft, every comp): behaviours
 * lose them from their lists, are dropped when they lose what they cannot do
 * without (their only target, their mouth, every eye), and forget a voice
 * that is gone.
 */
export function dropCharacterRefs(project: Project, layerIds: Iterable<string>): void {
  const gone = new Set(layerIds)
  if (gone.size === 0) return
  for (const comp of project.comps) {
    for (const track of comp.tracks) {
      for (const layer of track.layers) {
        if (layer.kind !== 'group' || layer.behaviors.length === 0) continue
        const kept: Behavior[] = []
        for (const b of layer.behaviors) {
          if (b.type === 'blink') {
            const eyes = b.eyes.filter((id) => !gone.has(id))
            if (eyes.length > 0) kept.push({ ...b, eyes })
          } else if (b.type === 'glance') {
            const layers = b.layers.filter((id) => !gone.has(id))
            if (layers.length > 0) kept.push({ ...b, layers })
          } else if (b.type === 'talk') {
            if (!gone.has(b.mouth)) kept.push({ ...b, voice: b.voice !== null && gone.has(b.voice) ? null : b.voice })
          } else if (b.type === 'nod') {
            if (b.layer !== undefined && gone.has(b.layer)) continue
            kept.push({ ...b, voice: b.voice !== null && gone.has(b.voice) ? null : b.voice })
          } else if (b.layer === undefined || !gone.has(b.layer)) {
            kept.push(b)
          }
        }
        if (kept.length !== layer.behaviors.length || kept.some((b, i) => JSON.stringify(b) !== JSON.stringify(layer.behaviors[i]))) layer.behaviors = kept
      }
    }
  }
}

// TODO: layers that leave a rig or a behaviour group (layers.ungroup, layers.restack) keep a stale bind or
// behaviour reference. The engine ignores references that no longer resolve under the group; a later step may clear them.
