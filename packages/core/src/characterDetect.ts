import { CommandError } from './errors'
import { findUnder, looseName } from './characters'
import {
  type BaseRole,
  BASE_ROLES,
  COPY_WORDS,
  EYE_STATE_OPEN,
  EYE_STATE_SHUT,
  LEFT_WORDS,
  PLURAL_WORDS,
  RIGHT_WORDS,
  ROLE_WORDS,
  SIDED_ROLES,
  VISEME_NAMES,
} from './characterWords'
import { groupMembers } from './groups'
import type { Comp, GroupLayer, Layer, PathLayer, Project } from './schema'
import { type PathCommand, parseSvgPath, svgPathBounds } from './svgPath'

// Finding the parts of a character (`character.detect`): names in many
// languages, switch members, and where flat pieces sit. Pure: reads a project,
// writes nothing. Boxes are comp space, computed here from geometry and
// transforms (text and nested comps have none, so geometry skips them).

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export type Side = 'L' | 'R'
export type Role = BaseRole | `${BaseRole}.${Side}`

/** Every role in the order a report lists them: sided roles as `eye.L`, `eye.R`. */
export const ROLES: Role[] = BASE_ROLES.flatMap((r): Role[] => (SIDED_ROLES.includes(r) ? [`${r}.L`, `${r}.R`] : [r]))

export interface Part {
  role: Role
  id: string
  name: string
  confidence: number
  reason: string
  layer: Layer
  box: Box | null
}

export interface Detection {
  figure: 'face' | 'body'
  parts: Part[]
  /** Pieces in the one path that draws the whole face (eyes, brows, mouth together), when there is such a path. */
  pieces?: number
  /** That path layer. */
  facePath?: PathLayer
  headBox: Box | null
  rootBox: Box | null
}

const cx = (b: Box) => b.left + b.width / 2
const cy = (b: Box) => b.top + b.height / 2
const area = (b: Box) => b.width * b.height
const inside = (x: number, y: number, b: Box) => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height
const holds = (outer: Box, inner: Box, slack = 0.5) =>
  inner.left >= outer.left - slack && inner.top >= outer.top - slack && inner.left + inner.width <= outer.left + outer.width + slack && inner.top + inner.height <= outer.top + outer.height + slack

function union(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null
  const left = Math.min(...boxes.map((b) => b.left))
  const top = Math.min(...boxes.map((b) => b.top))
  const right = Math.max(...boxes.map((b) => b.left + b.width))
  const bottom = Math.max(...boxes.map((b) => b.top + b.height))
  return { left, top, width: right - left, height: bottom - top }
}

// ---------------------------------------------------------------- boxes

function pathBox(geometry: string): Box | null {
  try {
    const box = svgPathBounds(parseSvgPath(geometry))
    return box.width > 0 || box.height > 0 ? box : null
  } catch {
    return null
  }
}

/**
 * The axis-aligned box a layer covers in comp space at rest (rotation
 * ignored): paths, shapes, pictures and groups. A group is the union of its
 * members, moved and scaled by its own transform. Null when it has no known
 * size (text, nested comps, empty groups).
 */
export function layerBox(project: Project, comp: Comp, layer: Layer): Box | null {
  const t = layer.transform
  const place = (w: number, h: number): Box => {
    const sw = w * Math.abs(t.scaleX)
    const sh = h * Math.abs(t.scaleY)
    return { left: t.x - t.anchorX * sw, top: t.y - t.anchorY * sh, width: sw, height: sh }
  }
  switch (layer.kind) {
    case 'path': {
      const b = pathBox(layer.geometry)
      return b ? place(b.width, b.height) : null
    }
    case 'shape':
      return place(layer.shape.width, layer.shape.height)
    case 'image':
    case 'video': {
      const media = project.media.find((m) => m.id === layer.mediaId)
      return media?.width && media.height ? place(media.width, media.height) : null
    }
    case 'group': {
      const u = union(groupMembers(comp, layer.id).flatMap((m) => layerBox(project, comp, m) ?? []))
      if (!u) return null
      const px = u.left + t.anchorX * u.width
      const py = u.top + t.anchorY * u.height
      const sx = Math.abs(t.scaleX)
      const sy = Math.abs(t.scaleY)
      return { left: px + t.x + (u.left - px) * sx, top: py + t.y + (u.top - py) * sy, width: u.width * sx, height: u.height * sy }
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------- names

/** Words of a name: accents dropped, camelCase, digits and punctuation split, lower case. */
export function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== '')
}

const CJK = /[ᄀ-ᇿ぀-ヿ㐀-鿿가-힯]/u
const normalWord = (w: string) => nameTokens(w).join(' ')

interface WordEntry {
  role: BaseRole
  plural: boolean
  word: string
  compact: string
  cjk: boolean
}

const ENTRIES: WordEntry[] = []
for (const role of BASE_ROLES) {
  for (const [list, plural] of [[ROLE_WORDS[role], false], [PLURAL_WORDS[role], true]] as const) {
    for (const raw of (list ?? '').split('|')) {
      const word = normalWord(raw)
      if (word !== '') ENTRIES.push({ role, plural, word, compact: word.replace(/ /g, ''), cjk: CJK.test(word) })
    }
  }
}

const sideSet = (list: string) => new Set(list.split('|').map(normalWord).filter((w) => w !== ''))
const LEFT = sideSet(LEFT_WORDS)
const RIGHT = sideSet(RIGHT_WORDS)
const LEFT_CJK = [...LEFT].filter((w) => CJK.test(w)).concat('左')
const RIGHT_CJK = [...RIGHT].filter((w) => CJK.test(w)).concat('右')
const COPY = new Set(COPY_WORDS.map(normalWord))

export interface NameMatch {
  role: BaseRole
  plural: boolean
  side: Side | undefined
  copy: boolean
}

/** The part a layer's name says it is (whole words; CJK as a substring; the longest match wins), with the side it names. */
export function matchName(name: string): NameMatch | null {
  const all = nameTokens(name)
  const copy = all.some((t) => COPY.has(t)) || name.includes('コピー')
  const tokens = all.filter((t) => !COPY.has(t))
  if (tokens.length === 0) return null
  const spaced = ` ${tokens.join(' ')} `
  const compact = tokens.join('')
  let best: WordEntry | undefined
  for (const e of ENTRIES) {
    const hit = e.cjk ? compact.includes(e.compact) : spaced.includes(` ${e.word} `)
    if (hit && (!best || e.word.length > best.word.length)) best = e
  }
  if (!best) return null
  let side: Side | undefined
  for (const t of tokens) {
    if (LEFT.has(t)) side = 'L'
    else if (RIGHT.has(t)) side = 'R'
    if (side) break
  }
  if (!side && CJK.test(compact)) {
    if (LEFT_CJK.some((w) => compact.includes(w))) side = 'L'
    else if (RIGHT_CJK.some((w) => compact.includes(w))) side = 'R'
  }
  return { role: best.role, plural: best.plural, side, copy }
}

/** A name without its trailing numbers: "grinning face 14", "grinning face 12 1" and "Shape_3" give "grinning face", "grinning face" and "shape". */
const baseName = (name: string) => name.trim().replace(/([\s._-]*\d+)+$/, '').trim().toLowerCase()

/**
 * Ids of the layers whose names tell nothing: three or more siblings (members
 * of one group) share one base name, so the name is a counter, not a part.
 */
function numberedNames(nodes: readonly { layer: Layer; parentId: string | null }[]): Set<string> {
  const byKey = new Map<string, string[]>()
  for (const n of nodes) {
    const key = `${n.parentId ?? ''}|${baseName(n.layer.name)}`
    byKey.set(key, [...(byKey.get(key) ?? []), n.layer.id])
  }
  return new Set([...byKey.values()].filter((ids) => ids.length >= 3).flat())
}

/** How much of `inner` lies inside `outer`, 0 to 1 (a flat box counts as in or out). */
function shareInside(inner: Box, outer: Box): number {
  const a = area(inner)
  if (a <= 1e-6) return holds(outer, inner) ? 1 : 0
  const w = Math.min(inner.left + inner.width, outer.left + outer.width) - Math.max(inner.left, outer.left)
  const h = Math.min(inner.top + inner.height, outer.top + outer.height) - Math.max(inner.top, outer.top)
  return w > 0 && h > 0 ? (w * h) / a : 0
}

/**
 * The drawing layers under `root` (through plain groups, not into switches)
 * whose boxes lie at least `share` (80 %) inside `outer`: the teeth and tongue of a
 * mouth, the highlight of an eye. `skip` holds ids that are never taken.
 */
export function piecesInside(project: Project, comp: Comp, root: Layer, outer: Box, skip: ReadonlySet<string>, share = 0.8): Layer[] {
  const found: Layer[] = []
  const walk = (group: GroupLayer) => {
    for (const m of groupMembers(comp, group.id)) {
      if (m.kind === 'group') {
        if (m.switch === null) walk(m)
        continue
      }
      if (m.kind !== 'path' && m.kind !== 'shape') continue
      const box = layerBox(project, comp, m)
      if (box && !skip.has(m.id) && shareInside(box, outer) >= share) found.push(m)
    }
  }
  if (root.kind === 'group') walk(root)
  return found
}

// ---------------------------------------------------------------- pieces of one path

export interface PathPiece {
  commands: PathCommand[]
  box: Box
}

/**
 * The separate drawings in one path: every subpath, plus the subpaths that lie
 * inside it (a pupil's highlight, an evenodd hole). A subpath inside one that
 * is bigger than a third of the whole path stays on its own, so a face outline
 * does not swallow the eyes.
 */
export function pathPieces(geometry: string): PathPiece[] {
  const commands = parseSvgPath(geometry)
  const subs: PathCommand[][] = []
  for (const c of commands) {
    if (c.c === 'M') subs.push([c])
    else subs[subs.length - 1]?.push(c)
  }
  const boxes = subs.map((s) => svgPathBounds(s))
  const total = area(svgPathBounds(commands))
  const parentOf = subs.map((_, i) => {
    const mine = boxes[i] as Box
    let best = -1
    boxes.forEach((other, j) => {
      if (j === i || !holds(other, mine)) return
      const bigger = area(other) > area(mine) || (area(other) === area(mine) && j < i)
      if (!bigger || area(other) > 0.35 * total) return
      if (best < 0 || area(other) < area(boxes[best] as Box)) best = j
    })
    return best
  })
  const rootOf = (i: number): number => {
    let at = i
    for (let guard = 0; guard < subs.length && parentOf[at] !== -1; guard++) at = parentOf[at] as number
    return at
  }
  const groups = new Map<number, number[]>()
  subs.forEach((_, i) => {
    const root = rootOf(i)
    groups.set(root, [...(groups.get(root) ?? []), i])
  })
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([root, members]) => ({ commands: members.flatMap((i) => subs[i] as PathCommand[]), box: boxes[root] as Box }))
}

// ---------------------------------------------------------------- detection

interface Node {
  layer: Layer
  parentId: string | null
  depth: number
  box: Box | null
}

interface Cand {
  role: BaseRole
  node: Node
  a: number
  why: string[]
  side: Side | undefined
  /** The name marks a duplicate, so its side may be stale. */
  copy: boolean
}

const viseme = new Set(VISEME_NAMES)

/** Whether `child` sits at any depth under `ancestor`, by the node tree. */
function under(byId: Map<string, Node>, child: Node, ancestorId: string): boolean {
  for (let at: Node | undefined = child; at; at = at.parentId === null ? undefined : byId.get(at.parentId)) {
    if (at.parentId === ancestorId) return true
  }
  return false
}

function plainGroup(layer: Layer | undefined): boolean {
  return layer?.kind === 'group' && layer.switch === null && layer.rig === null && layer.behaviors.length === 0
}

/** The path layer that draws a whole face as many outlines, if there is one; the cases in the order they are tried. */
function findFacePath(project: Project, comp: Comp, root: Layer, byId: Map<string, Node>, parts: readonly Part[]): { layer: PathLayer; pieces: number } | undefined {
  const leaves = (layer: Layer | undefined): PathLayer[] => {
    if (!layer) return []
    if (layer.kind === 'path') return [layer]
    if (layer.kind !== 'group') return []
    return [...byId.values()].filter((n) => n.layer.kind === 'path' && (n.layer.id === layer.id || under(byId, n, layer.id))).map((n) => n.layer as PathLayer)
  }
  const named = (role: Role) => parts.find((p) => p.role === role)?.layer
  const all = [...byId.values()].map((n) => n.layer)
  const tries: PathLayer[][] = [
    leaves(named('face')),
    leaves(named('head')),
    all.filter((l): l is PathLayer => l.kind === 'path' && ['ink', 'face'].includes(looseName(l.name))),
    root.kind === 'path' ? [root] : [],
  ]
  for (const list of tries) {
    const only = list.length === 1 ? (list[0] as PathLayer) : undefined
    if (!only) continue
    try {
      const pieces = pathPieces(only.geometry).length
      if (pieces >= 3) return { layer: only, pieces }
    } catch {
      // Not a path we can read: try the next case.
    }
  }
  void project
  void comp
  return undefined
}

/**
 * Reads a character: which layers are its head, eyes, mouth and so on, how
 * sure that is and why. `root` is a group (any depth below it counts) or one
 * layer. `overrides` pins a role to a layer (id or name) or, with null,
 * rules it out.
 */
export function detectCharacter(project: Project, comp: Comp, root: Layer, overrides: Record<string, string | null> = {}): Detection {
  const boxMemo = new Map<string, Box | null>()
  const boxOf = (l: Layer): Box | null => {
    if (!boxMemo.has(l.id)) boxMemo.set(l.id, layerBox(project, comp, l))
    return boxMemo.get(l.id) ?? null
  }

  // The layers that count: everything under a group, except what is inside a switch (a switch is one part).
  const nodes: Node[] = []
  const byId = new Map<string, Node>()
  const walk = (group: GroupLayer, depth: number) => {
    for (const m of groupMembers(comp, group.id)) {
      const node: Node = { layer: m, parentId: group.id, depth, box: boxOf(m) }
      nodes.push(node)
      byId.set(m.id, node)
      if (m.kind === 'group' && m.switch === null) walk(m, depth + 1)
    }
  }
  if (root.kind === 'group') walk(root, 1)
  else {
    const node: Node = { layer: root, parentId: null, depth: 0, box: boxOf(root) }
    nodes.push(node)
    byId.set(root.id, node)
  }
  const rootBox = boxOf(root)

  // Overrides: pinned roles name layers under the root.
  const pinned = new Map<string, Layer | null>()
  for (const [key, ref] of Object.entries(overrides)) {
    if (!(ROLES as string[]).includes(key)) throw new CommandError(`"${key}" is not a character part.`, `Parts: ${ROLES.join(', ')}.`)
    if (ref === null) {
      pinned.set(key, null)
    } else if (root.kind === 'group') {
      pinned.set(key, findUnder(comp, root, ref))
    } else if (root.id === ref || root.name === ref) {
      pinned.set(key, root)
    } else {
      throw new CommandError(`"${ref}" is not part of "${root.name}".`)
    }
  }

  const cands = new Map<string, Cand>()
  const add = (role: BaseRole, node: Node, a: number, why: string, side?: Side, copy = false) => {
    const key = `${role}|${node.layer.id}`
    const old = cands.get(key)
    if (old) {
      old.a = 1 - (1 - old.a) * (1 - a)
      old.why.push(why)
      old.side ??= side
      old.copy ||= copy
    } else cands.set(key, { role, node, a, why: [why], side, copy })
  }

  // Evidence from names, plural parents and switch members. Names that only count ("Face 1" … "Face 14") tell nothing.
  const counters = numberedNames(nodes)
  for (const node of nodes) {
    const l = node.layer
    const own = counters.has(l.id) ? null : matchName(l.name)
    if (own && !own.plural) add(own.role, node, 0.9, `named "${l.name}"`, own.side, own.copy)
    const parent = node.parentId === null ? undefined : byId.get(node.parentId)
    if (!own && parent) {
      const p = matchName(parent.layer.name)
      if (p?.plural) add(p.role, node, 0.7, `inside "${parent.layer.name}"`)
    }
    if (l.kind === 'group' && l.switch !== null) {
      const members = groupMembers(comp, l.id).map((m) => looseName(m.name))
      const visemes = members.filter((m) => viseme.has(m)).length
      if (members.length >= 3 && visemes >= 3 && visemes >= 0.6 * members.length) add('mouth', node, 0.88, 'a switch of mouth shapes')
      else if (members.some((m) => EYE_STATE_OPEN.includes(m)) && members.some((m) => EYE_STATE_SHUT.includes(m))) add('eye', node, 0.75, 'a switch of open and closed')
    }
  }

  // Geometry: flat pieces, for what no name or switch settled.
  const settled = (role: BaseRole) => [...cands.values()].some((c) => c.role === role && c.a >= 0.6 && pinned.get(role) === undefined)
  const bestOf = (role: BaseRole): Cand | undefined => [...cands.values()].filter((c) => c.role === role && c.a >= 0.6).sort((a, b) => b.a - a.a || a.node.depth - b.node.depth)[0]
  const claimed = new Set([...cands.values()].filter((c) => c.a >= 0.6).map((c) => c.node.layer.id))
  const pool = nodes.filter(
    (n): n is Node & { box: Box } => n.box !== null && n.box.width >= 1 && n.box.height >= 1 && (n.layer.kind !== 'group' || n.layer.switch !== null) && !claimed.has(n.layer.id),
  )
  const pairOk = (a: Box, b: Box) => {
    const wr = a.width / b.width
    const hr = a.height / b.height
    if (wr < 0.6 || wr > 1.67 || hr < 0.6 || hr > 1.67) return false
    if (Math.abs(cy(a) - cy(b)) > 0.3 * Math.max(a.height, b.height) + 1) return false
    if (Math.abs(cx(a) - cx(b)) < 0.6 * Math.max(a.width, b.width)) return false
    const [l, r] = a.left <= b.left ? [a, b] : [b, a]
    return l.left + l.width <= r.left
  }
  type P = Node & { box: Box }
  const pairsIn = (list: readonly P[]): [P, P][] => {
    const out: [P, P][] = []
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] as P
        const b = list[j] as P
        if (pairOk(a.box, b.box)) out.push(a.box.left <= b.box.left ? [a, b] : [b, a])
      }
    }
    return out
  }
  const aspect = (p: [P, P]) => (p[0].box.width + p[1].box.width) / (p[0].box.height + p[1].box.height)
  const pairCy = (p: [P, P]) => (cy(p[0].box) + cy(p[1].box)) / 2

  let headBox: Box | null = null
  let headNode: Node | undefined
  const pinnedHead = pinned.get('head')
  const headCand = pinnedHead ? undefined : bestOf('head')
  const faceCand = pinnedHead ? undefined : bestOf('face')
  if (pinnedHead) {
    headNode = byId.get(pinnedHead.id)
    headBox = boxOf(pinnedHead)
  } else if (headCand ?? faceCand) {
    headNode = (headCand ?? faceCand)?.node
    headBox = headNode?.box ?? null
  } else {
    let bestScore = 0
    for (const x of pool) {
      const near = pool.filter((p) => p !== x && inside(cx(p.box), cy(p.box), x.box))
      for (const pair of pairsIn(near)) {
        const rel = (pairCy(pair) - x.box.top) / x.box.height
        if (area(pair[0].box) + area(pair[1].box) >= 0.2 * area(x.box) || rel > 0.75) continue
        const score = area(x.box) * (1 - 0.5 * rel)
        if (score > bestScore) {
          bestScore = score
          headNode = x
          headBox = x.box
        }
      }
    }
    if (headNode && headBox) add('head', headNode, 0.5, 'holds a pair of eyes high up')
  }
  const headLayerId = headNode?.layer.id
  const inHead = (n: Node) => headLayerId !== undefined && (n.layer.id === headLayerId || under(byId, n, headLayerId))

  const eyeBoxes: Box[] = []
  const eyeIds = new Set<string>()
  const nameEyes = [...cands.values()].filter((c) => c.role === 'eye' && c.a >= 0.6)
  for (const c of nameEyes) {
    if (c.node.box) eyeBoxes.push(c.node.box)
    eyeIds.add(c.node.layer.id)
  }
  if (headBox && !settled('eye') && !pinned.has('eye.L') && !pinned.has('eye.R')) {
    const h = headBox
    const small = pool.filter((p) => p.layer.id !== headLayerId && inside(cx(p.box), cy(p.box), h) && area(p.box) < 0.2 * area(h))
    // A highlight (under 15 % of the piece it sits in) is no eye and no pupil.
    const glint = (p: P) => small.some((q) => q !== p && inside(cx(p.box), cy(p.box), q.box) && area(p.box) < 0.15 * area(q.box))
    const near = small.filter((p) => !glint(p))
    const inner = (e: P): P | undefined => near.filter((p) => p !== e && inside(cx(p.box), cy(p.box), e.box) && area(p.box) < 0.8 * area(e.box) && area(p.box) >= 0.15 * area(e.box)).sort((a, b) => area(b.box) - area(a.box))[0]
    const pairs = pairsIn(near).filter((p) => aspect(p) < 2.6)
    const withPupils = pairs
      .map((p) => ({ p, pupils: [inner(p[0]), inner(p[1])] as const }))
      .filter((x): x is { p: [P, P]; pupils: readonly [P, P] } => x.pupils[0] !== undefined && x.pupils[1] !== undefined)
      .sort((a, b) => pairCy(a.p) - pairCy(b.p))[0]
    const plain = pairs.filter((p) => pairCy(p) <= cy(h) + 0.15 * h.height).sort((a, b) => pairCy(a) - pairCy(b))[0]
    const eyes = withPupils?.p ?? plain
    if (eyes) {
      for (const e of eyes) {
        add('eye', e, 0.5, 'a pair high in the head')
        eyeBoxes.push(e.box)
        eyeIds.add(e.layer.id)
      }
      if (withPupils) for (const pupil of withPupils.pupils) add('pupil', pupil, 0.5, 'a pair inside the eyes')
    }
  }
  const taken = new Set([...eyeIds, ...[...cands.values()].filter((c) => c.role === 'pupil').map((c) => c.node.layer.id)])
  const eyeLine = eyeBoxes.length > 0 ? { midX: eyeBoxes.reduce((s, b) => s + cx(b), 0) / eyeBoxes.length, bottom: Math.max(...eyeBoxes.map((b) => b.top + b.height)), midY: eyeBoxes.reduce((s, b) => s + cy(b), 0) / eyeBoxes.length } : null

  if (headBox && eyeLine) {
    const h = headBox
    const free = pool.filter((p) => !taken.has(p.layer.id) && p.layer.id !== headLayerId && inside(cx(p.box), cy(p.box), h))
    if (!settled('brow') && !pinned.has('brow.L') && !pinned.has('brow.R')) {
      const brows = pairsIn(free.filter((p) => cy(p.box) < eyeLine.midY))
        .filter((p) => aspect(p) >= 1.8 && eyeLine.midY - pairCy(p) < 0.3 * h.height)
        .sort((a, b) => pairCy(b) - pairCy(a))[0]
      if (brows) for (const b of brows) add('brow', b, 0.45, 'a wide pair just above the eyes')
    }
    const browIds = new Set([...cands.values()].filter((c) => c.role === 'brow').map((c) => c.node.layer.id))
    if (!settled('mouth') || !settled('nose')) {
      const low = free
        .filter((p) => !browIds.has(p.layer.id) && area(p.box) < 0.3 * area(h) && Math.abs(cx(p.box) - eyeLine.midX) <= 0.15 * h.width && cy(p.box) > eyeLine.bottom)
        .sort((a, b) => cy(b.box) - cy(a.box))
      // The mouth is the lowest piece, or the biggest piece that holds it (a tongue sits lower than the mouth it is in).
      let mouth = low[0]
      for (const c of low) if (mouth && area(c.box) > area(mouth.box) && shareInside(mouth.box, c.box) >= 0.8) mouth = c
      if (mouth && !settled('mouth') && !pinned.has('mouth')) add('mouth', mouth, 0.5, 'the lowest piece under the eyes')
      const nose = low.find((p) => p !== mouth && cy(p.box) < cy((mouth ?? p).box) && !(mouth && shareInside(p.box, mouth.box) >= 0.8))
      if (nose && (!mouth || area(nose.box) <= 1.5 * area(mouth.box)) && !settled('nose') && !pinned.has('nose')) add('nose', nose, 0.45, 'above the mouth, below the eyes')
    }
  }
  if (headBox && !settled('hair') && !pinned.has('hair')) {
    const h = headBox
    const hair = pool
      .filter((p) => !inHead(p) && p.box.top <= h.top + 0.05 * h.height && cy(p.box) < cy(h) && p.box.width >= 0.5 * h.width && Math.abs(cx(p.box) - cx(h)) <= 0.2 * h.width)
      .sort((a, b) => area(b.box) - area(a.box))[0]
    if (hair) add('hair', hair, 0.4, 'over the top of the head')
  }
  if (headBox && !settled('torso') && !pinned.has('torso') && rootBox) {
    const h = headBox
    const torso = pool
      .filter((p) => !inHead(p) && cy(p.box) > h.top + h.height * 0.9 && Math.abs(cx(p.box) - cx(h)) <= 0.2 * rootBox.width)
      .sort((a, b) => area(b.box) - area(a.box))[0]
    if (torso) add('torso', torso, 0.5, 'the biggest piece below the head')
  }

  // Choose: best evidence first; a layer plays one role; a role takes one layer (two for the sided ones), never a layer inside another it took.
  const live = [...cands.values()].filter((c) => c.a >= 0.3)
  live.sort((a, b) => b.a - a.a || a.node.depth - b.node.depth || BASE_ROLES.indexOf(a.role) - BASE_ROLES.indexOf(b.role))
  const used = new Set<string>()
  const picks = new Map<BaseRole, Cand[]>()
  for (const c of live) {
    if (used.has(c.node.layer.id)) continue
    const list = picks.get(c.role) ?? []
    if (list.length >= (SIDED_ROLES.includes(c.role) ? 2 : 1)) continue
    if (list.some((p) => under(byId, p.node, c.node.layer.id) || under(byId, c.node, p.node.layer.id))) continue
    list.push(c)
    picks.set(c.role, list)
    used.add(c.node.layer.id)
  }

  // Sides: the name, else a parent's, else the eye a piece sits in, else the one free side, else by place (larger x is the character's left).
  const axis = headBox ? cx(headBox) : rootBox ? cx(rootBox) : 0
  const sideOfAncestor = (n: Node): Side | undefined => {
    for (let at = n.parentId === null ? undefined : byId.get(n.parentId); at; at = at.parentId === null ? undefined : byId.get(at.parentId)) {
      const m = matchName(at.layer.name)
      if (m?.side && !m.copy) return m.side
    }
    return undefined
  }
  const parts: Part[] = []
  const resolved = new Map<string, Side>()
  const eyeSides: { box: Box; side: Side }[] = []
  for (const role of ['eye', 'brow', 'lid', 'pupil', 'arm', 'forearm', 'hand', 'leg', 'shin', 'foot'] as const) {
    const list = picks.get(role) ?? []
    const sides = list.map((c) => c.side ?? sideOfAncestor(c.node))
    const trust: number[] = list.map((_, i) => (sides[i] ? 1 : 0))
    if (role === 'brow' || role === 'lid' || role === 'pupil') {
      list.forEach((c, i) => {
        if (sides[i] || !c.node.box || eyeSides.length === 0) return
        const centre: [number, number] = [cx(c.node.box), cy(c.node.box)]
        const hit = eyeSides.find((e) => inside(centre[0], centre[1], e.box)) ?? [...eyeSides].sort((a, b) => Math.hypot(cx(a.box) - centre[0], cy(a.box) - centre[1]) - Math.hypot(cx(b.box) - centre[0], cy(b.box) - centre[1]))[0]
        if (hit) {
          sides[i] = hit.side
          trust[i] = 0.95
        }
      })
    }
    if (list.length === 2 && sides[0] !== undefined && sides[0] === sides[1]) {
      // Two with one side: one is a copy with a stale name, or it is a mistake; the copy (else the second) goes by place.
      const stale = (list[0] as Cand).copy && !(list[1] as Cand).copy ? 0 : 1
      sides[stale] = undefined
      trust[stale] = 0
    }
    const missing = list.map((_, i) => i).filter((i) => !sides[i])
    const left = (i: number) => ((list[i] as Cand).node.box ? cx((list[i] as Cand).node.box as Box) : 0)
    if (missing.length === 2) {
      const [a, b] = missing as [number, number]
      const aIsLeft = left(a) >= left(b)
      sides[a] = aIsLeft ? 'L' : 'R'
      sides[b] = aIsLeft ? 'R' : 'L'
      trust[a] = trust[b] = 0.9
    } else if (missing.length === 1) {
      const i = missing[0] as number
      const other = list.length === 2 ? sides[1 - i] : undefined
      if (other) {
        sides[i] = other === 'L' ? 'R' : 'L'
        trust[i] = 0.95
      } else {
        const box = (list[i] as Cand).node.box
        sides[i] = box && cx(box) < axis - 1 ? 'R' : 'L'
        trust[i] = 0.8
      }
    }
    list.forEach((c, i) => {
      const side = sides[i] as Side
      resolved.set(c.node.layer.id, side)
      if (role === 'eye' && c.node.box) eyeSides.push({ box: c.node.box, side })
      parts.push({ role: `${role}.${side}`, id: c.node.layer.id, name: c.node.layer.name, confidence: Math.round(Math.min(1, c.a * (trust[i] ?? 1)) * 100) / 100, reason: c.why.join('; '), layer: c.node.layer, box: c.node.box })
    })
  }
  for (const role of BASE_ROLES) {
    if (SIDED_ROLES.includes(role)) continue
    for (const c of picks.get(role) ?? []) {
      parts.push({ role, id: c.node.layer.id, name: c.node.layer.name, confidence: Math.round(Math.min(1, c.a) * 100) / 100, reason: c.why.join('; '), layer: c.node.layer, box: c.node.box })
    }
  }

  // Pinned parts replace what was found, with full confidence; a null takes the role out.
  for (const [key, layer] of pinned) {
    const at = parts.findIndex((p) => p.role === key)
    if (at >= 0) parts.splice(at, 1)
    if (layer === null) continue
    const twice = parts.findIndex((p) => p.id === layer.id)
    if (twice >= 0) parts.splice(twice, 1)
    parts.push({ role: key as Role, id: layer.id, name: layer.name, confidence: 1, reason: 'set by you', layer, box: boxOf(layer) })
  }
  parts.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role))

  const has = (re: RegExp) => parts.some((p) => re.test(p.role))
  const headPart = parts.find((p) => p.role === 'head') ?? parts.find((p) => p.role === 'face')
  const torsoPart = parts.find((p) => p.role === 'torso')
  const below = headPart?.box && torsoPart?.box ? cy(torsoPart.box) > headPart.box.top + headPart.box.height : false
  const figure = has(/^(torso|arm|leg)/) || below ? 'body' : 'face'
  const face = findFacePath(project, comp, root, byId, parts)
  return {
    figure,
    parts,
    ...(face ? { pieces: face.pieces, facePath: face.layer } : {}),
    headBox: headPart?.box ?? headBox,
    rootBox,
  }
}

/** A group with nothing but members (no switch, rig or behaviours) can hold pieces in place of one of them. */
export const isPlainGroup = plainGroup
