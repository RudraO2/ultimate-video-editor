import {
  blinkAt,
  breatheAt,
  type Comp,
  envelopeAt,
  glanceAt,
  type GroupLayer,
  type Layer,
  looseName,
  type MediaAsset,
  memberInfos,
  mouthMember,
  seedOf,
  swayAt,
  talkBlocks,
  talkShapeAt,
} from '@uve/core'
import { isActiveAt, sourceTimeMs } from './evaluate'
import { compose, degToRad, type Mat4, rotateZ, scale, translate } from './math'

// Behaviours (Q7) of a character group, as plain data for the scene builder:
// which switch members to show, what to add to the bones' poses, and what
// matrices to put on layers. Nothing here reads a clock or a random source.

/** A box in comp space. */
interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** A matrix for a layer, made once the layer's own bounds are known. */
export interface LayerOp {
  /** The layer it moves (the group itself moves all its members). */
  target: string
  make: (bounds: Box) => Mat4
}

export interface BehaviourResult {
  /** Switch group id to the member index it must show. */
  switches: Map<string, number>
  /** Bone id to what is added to its pose: a turn in degrees and a factor on its stretch. */
  bones: Map<string, { rotation: number; scale: number }>
  /** Matrices for layers, in the order of the stack. */
  ops: LayerOp[]
}

/** A seed that differs between characters and between behaviours. */
export function behaviourSeed(groupId: string, behaviourId: string, seed: number): number {
  return (seedOf(`${groupId}/${behaviourId}`) + Math.imul(seed | 0, 0x9e3779b1)) >>> 0
}

const bottomCentre = (b: Box): [number, number] => [b.left + b.width / 2, b.top + b.height]
const centre = (b: Box): [number, number] => [b.left + b.width / 2, b.top + b.height / 2]

/** A matrix that scales about a point. */
const scaleAbout = (x: number, y: number, sx: number, sy: number) => compose(translate(x, y, 0), scale(sx, sy, 1), translate(-x, -y, 0))
const turnAbout = (x: number, y: number, deg: number) => compose(translate(x, y, 0), rotateZ(degToRad(deg)), translate(-x, -y, 0))

export interface Voice {
  layer: Layer
  media: MediaAsset
}

/**
 * The voice playing at a comp time: the layer asked for, or else the
 * front-most audio or video layer playing whose media has a loudness envelope.
 */
export function voiceAt(comp: Comp, media: readonly MediaAsset[], timeMs: number, voiceId: string | null): Voice | null {
  const find = (layer: Layer): Voice | null => {
    if ((layer.kind !== 'audio' && layer.kind !== 'video') || !isActiveAt(layer, timeMs)) return null
    const asset = media.find((m) => m.id === layer.mediaId)
    return asset?.envelope && asset.envelope.values.length > 0 ? { layer, media: asset } : null
  }
  for (const track of comp.tracks) {
    for (const layer of track.layers) {
      if (voiceId !== null && layer.id !== voiceId) continue
      const found = find(layer)
      if (found) return found
    }
  }
  return null
}

/** The mouth shape of a talk behaviour at a comp time ('X' when nobody speaks). */
function talkIndex(comp: Comp, media: readonly MediaAsset[], timeMs: number, b: Extract<GroupLayer['behaviors'][number], { type: 'talk' }>, mouth: GroupLayer, seed: number): number {
  const names = memberInfos(comp, mouth).map((m) => m.name)
  const voice = voiceAt(comp, media, timeMs, b.voice)
  let shape = 'X'
  const layer = voice?.layer
  if (voice && layer && (layer.kind === 'audio' || layer.kind === 'video') && voice.media.envelope) {
    const env = voice.media.envelope
    const fromMs = layer.sourceStartMs
    const toMs = fromMs + layer.durationMs * layer.playbackRate
    const blocks = talkBlocks(env, { fromMs, toMs, lead: b.lead, frameMs: 1000 / comp.fps, seed })
    shape = talkShapeAt(blocks, sourceTimeMs(layer, timeMs))
  }
  return mouthMember(shape, names, b.map)
}

/** The member of an eye switch to show for a blink: closed, or half when there is one. */
function blinkMember(names: string[], s: 0.5 | 1): number {
  const loose = names.map(looseName)
  const closed = loose.findIndex((n) => n.includes('clos') || n.includes('shut'))
  if (s === 0.5) {
    const half = loose.findIndex((n) => n.includes('half'))
    if (half >= 0) return half
  }
  return closed >= 0 ? closed : names.length - 1
}

/** What a group's enabled behaviours do at a comp time. `layerTimeMs` is the time since the group's start. */
export function evaluateBehaviours(comp: Comp, media: readonly MediaAsset[], group: GroupLayer, timeMs: number, layerTimeMs: number): BehaviourResult {
  const result: BehaviourResult = { switches: new Map(), bones: new Map(), ops: [] }
  if (group.behaviors.length === 0) return result
  const layers = new Map(comp.tracks.flatMap((t) => t.layers).map((l) => [l.id, l]))
  const bones = group.rig?.bones ?? []
  const boneId = (ref: string) => bones.find((b) => b.id === ref)?.id ?? bones.find((b) => looseName(b.name) === looseName(ref))?.id
  const addBone = (ref: string, rotation: number, factor: number) => {
    const id = boneId(ref)
    if (id === undefined) return
    const was = result.bones.get(id) ?? { rotation: 0, scale: 1 }
    result.bones.set(id, { rotation: was.rotation + rotation, scale: was.scale * factor })
  }
  for (const b of group.behaviors) {
    if (!b.enabled) continue
    const seed = behaviourSeed(group.id, b.id, b.seed)
    switch (b.type) {
      case 'breathe': {
        const swell = breatheAt(b, layerTimeMs)
        if (b.bone !== undefined) addBone(b.bone, 0, 1 + swell)
        else if (b.layer !== undefined) {
          result.ops.push({
            target: b.layer,
            make: (box) => {
              const [x, y] = b.keepBottom ? bottomCentre(box) : centre(box)
              return scaleAbout(x, y, 1, 1 + swell)
            },
          })
        }
        break
      }
      case 'sway': {
        const turn = swayAt({ amount: b.amount, speed: b.speed, seed }, layerTimeMs)
        if (b.bone !== undefined) addBone(b.bone, turn, 1)
        else if (b.layer !== undefined) {
          const pivot = b.pivot
          result.ops.push({ target: b.layer, make: (box) => turnAbout(...(pivot ?? bottomCentre(box)), turn) })
        }
        break
      }
      case 'nod': {
        const voice = voiceAt(comp, media, timeMs, b.voice)
        const env = voice?.media.envelope
        const loud = voice && env ? envelopeAt(env, sourceTimeMs(voice.layer, timeMs)) : 0
        const turn = loud * b.amount
        if (b.bone !== undefined) addBone(b.bone, turn, 1)
        else if (b.layer !== undefined) {
          const pivot = b.pivot
          result.ops.push({ target: b.layer, make: (box) => turnAbout(...(pivot ?? bottomCentre(box)), turn) })
        }
        break
      }
      case 'blink': {
        const s = blinkAt({ every: b.every, closedMs: b.closedMs, variance: b.variance, doubles: b.doubles, seed }, layerTimeMs)
        if (s === 0) break
        for (const id of b.eyes) {
          const eye = layers.get(id)
          if (!eye) continue
          if (eye.kind === 'group' && eye.switch !== null) {
            const names = memberInfos(comp, eye).map((m) => m.name)
            if (names.length > 0) result.switches.set(eye.id, blinkMember(names, s))
          } else {
            const squash = s === 1 ? b.closedScale : (1 + b.closedScale) / 2
            result.ops.push({ target: id, make: (box) => scaleAbout(...centre(box), 1, squash) })
          }
        }
        break
      }
      case 'glance': {
        const at = glanceAt({ rangeX: b.rangeX, rangeY: b.rangeY, hold: b.hold, moveMs: b.moveMs, centre: b.centre, seed }, layerTimeMs)
        for (const id of b.layers) result.ops.push({ target: id, make: () => translate(at.x, at.y, 0) })
        break
      }
      case 'talk': {
        const mouth = layers.get(b.mouth)
        if (mouth?.kind !== 'group' || mouth.switch === null) break
        const index = talkIndex(comp, media, timeMs, b, mouth, seed)
        if (index >= 0) result.switches.set(mouth.id, index)
        break
      }
    }
  }
  return result
}
