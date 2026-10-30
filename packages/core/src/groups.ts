import type { Comp, GroupLayer, Layer, Track } from './schema'

// Groups, AtomCut-style: lanes stay one flat list per comp. A group layer
// sits alone on its own lane; its members are on the lanes that name it as
// `groupId`, which come right after that lane, followed by (or mixed with)
// the lanes of groups nested inside it. So a group and everything in it is
// one unbroken run of lanes, and code that walks the lanes still sees every
// layer.

/** The group layer on a lane, when the lane is a group's own. */
export function groupOnLane(track: Track): GroupLayer | undefined {
  const first = track.layers[0]
  return first?.kind === 'group' ? first : undefined
}

/** Index of the lane that holds group `groupId`, or -1. */
export function groupLaneIndex(comp: Comp, groupId: string): number {
  return comp.tracks.findIndex((t) => groupOnLane(t)?.id === groupId)
}

/** The ids of `groupId` and every group nested in it. */
function groupFamily(comp: Comp, groupId: string): Set<string> {
  const family = new Set([groupId])
  let grew = true
  while (grew) {
    grew = false
    for (const track of comp.tracks) {
      const group = groupOnLane(track)
      if (group && track.groupId !== null && family.has(track.groupId) && !family.has(group.id)) {
        family.add(group.id)
        grew = true
      }
    }
  }
  return family
}

/**
 * The lanes a group holds: from just after its own lane, every lane whose
 * group is it or a group inside it. Returns [start, end) indices.
 */
export function groupBlock(comp: Comp, groupId: string): [start: number, end: number] {
  const lane = groupLaneIndex(comp, groupId)
  if (lane < 0) return [0, 0]
  const family = groupFamily(comp, groupId)
  let end = lane + 1
  while (end < comp.tracks.length && family.has(comp.tracks[end]?.groupId ?? '')) end++
  return [lane + 1, end]
}

/** The lanes directly in a group (not those of groups nested in it). */
export function memberLanes(comp: Comp, groupId: string): Track[] {
  return comp.tracks.filter((t) => t.groupId === groupId)
}

/** The layers directly in a group. */
export function groupMembers(comp: Comp, groupId: string): Layer[] {
  return memberLanes(comp, groupId).flatMap((t) => t.layers)
}

/** Every layer in a group, nested groups' members included. */
export function groupDescendants(comp: Comp, groupId: string): Layer[] {
  const [start, end] = groupBlock(comp, groupId)
  return comp.tracks.slice(start, end).flatMap((t) => t.layers)
}

/** The chain of groups a layer is in, innermost first. */
export function ancestorGroups(comp: Comp, layerId: string): GroupLayer[] {
  const chain: GroupLayer[] = []
  let track = comp.tracks.find((t) => t.layers.some((l) => l.id === layerId))
  const seen = new Set<string>()
  while (track?.groupId && !seen.has(track.groupId)) {
    seen.add(track.groupId)
    const lane = groupLaneIndex(comp, track.groupId)
    const group = lane >= 0 ? groupOnLane(comp.tracks[lane] as Track) : undefined
    if (!group) break
    chain.push(group)
    track = comp.tracks[lane]
  }
  return chain
}

/** How deep a lane sits in groups: 0 at the top level. */
export function laneDepth(comp: Comp, track: Track): number {
  let depth = 0
  let current: Track | undefined = track
  const seen = new Set<string>()
  while (current?.groupId && !seen.has(current.groupId)) {
    seen.add(current.groupId)
    depth++
    current = comp.tracks[groupLaneIndex(comp, current.groupId)]
  }
  return depth
}

/** The group a new lane inserted at `index` joins: that of the lane it lands in front of. */
export function groupAtInsert(comp: Comp, index: number): string | null {
  return comp.tracks[index]?.groupId ?? null
}

/** What is wrong with a comp's groups, if anything: lanes naming missing groups, crowded group lanes, broken runs. */
export function groupStructureProblem(comp: Comp): string | null {
  const groups = new Map<string, number>()
  for (const [index, track] of comp.tracks.entries()) {
    const group = groupOnLane(track)
    if (group) {
      if (track.layers.length > 1) return `the lane of group "${group.name}" holds other layers too`
      groups.set(group.id, index)
    } else if (track.layers.some((l) => l.kind === 'group')) {
      return `lane "${track.id}" holds a group among other layers`
    }
  }
  for (const [index, track] of comp.tracks.entries()) {
    if (track.groupId === null) continue
    const lane = groups.get(track.groupId)
    if (lane === undefined) return `lane "${track.id}" is in group "${track.groupId}", which is not in the comp`
    if (lane >= index) return `lane "${track.id}" comes before its group's own lane`
    const [start, end] = groupBlock(comp, track.groupId)
    if (index < start || index >= end) return `the lanes of group "${track.groupId}" are not together after its lane`
  }
  for (const id of groups.keys()) if (ancestorGroupsOfGroup(comp, id).includes(id)) return `group "${id}" is inside itself`
  return null
}

function ancestorGroupsOfGroup(comp: Comp, groupId: string): string[] {
  return ancestorGroups(comp, groupId).map((g) => g.id)
}
