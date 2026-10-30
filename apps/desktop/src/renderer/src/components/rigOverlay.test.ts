import type { Bone } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { BONE_COLORS, BONE_HIT_RADIUS, hitBone, poseDelta, type Pt, rigOverlay, rigSpace, sideOf, sweepDeg } from './rigOverlay'

const bone = (id: string, head: [number, number], tail: [number, number], extra: Partial<Bone> = {}): Bone => ({
  id,
  name: id,
  head,
  tail,
  parent: null,
  deform: true,
  pose: { rotation: 0, x: 0, y: 0, scale: 1 },
  ...extra,
})

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
/** The viewport's comp to screen: a 1280x720 comp shown at half size. */
const compToScreen = (x: number, y: number): Pt => [(x + 640) * 0.5, (y + 360) * 0.5]
const near = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, digits))

/** A column-major matrix: rotate by `deg` clockwise, scale, then move. */
const matrix = (deg: number, sx: number, sy: number, tx: number, ty: number): number[] => {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [c * sx, s * sx, 0, 0, -s * sy, c * sy, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1]
}

describe('rigSpace', () => {
  it('round-trips screen and rig space through a rotated, scaled, flipped group', () => {
    for (const m of [IDENTITY, matrix(30, 1.5, 0.75, 40, -25), matrix(-100, -1, 1, 0, 10)]) {
      const space = rigSpace(m, compToScreen)
      for (const p of [[0, 0], [120, -45], [-300, 210]] as Pt[]) {
        const back = space.fromScreen(space.toScreen(p[0], p[1]))
        near(back, p, 6)
      }
    }
  })

  it('maps rig points to comp by the group matrix', () => {
    const space = rigSpace(matrix(90, 1, 1, 10, 20), compToScreen)
    near(space.toComp(100, 0), [10, 120])
    near(space.toScreen(100, 0), compToScreen(10, 120))
  })
})

describe('rigOverlay', () => {
  const bones = [bone('arm', [0, 0], [100, 0]), bone('hand', [100, 0], [160, 0], { parent: 'arm' })]

  it('draws a tapered diamond from head to tail, 10% wide up to 10 px', () => {
    const overlay = rigOverlay({ id: 'g' }, bones, compToScreen, IDENTITY)
    const arm = overlay.bones[0]!
    near(arm.head, [320, 180])
    near(arm.tail, [370, 180])
    // 50 px long on screen: 5 px wide, 2.5 each side of the axis.
    near(arm.outline[1], [330, 182.5])
    near(arm.outline[3], [330, 177.5])
    const long = rigOverlay({ id: 'g' }, [bone('l', [0, 0], [1000, 0])], compToScreen, IDENTITY).bones[0]!
    expect(Math.abs(long.outline[1][1] - long.outline[3][1])).toBeCloseTo(10)
  })

  it('follows the pose of the bones', () => {
    const posed = bones.map((b) => (b.id === 'arm' ? { ...b, pose: { rotation: 90, x: 0, y: 0, scale: 1 } } : b))
    const overlay = rigOverlay({ id: 'g' }, posed, compToScreen, IDENTITY)
    near(overlay.bones[0]!.tailRig, [0, 100])
    near(overlay.bones[1]!.headRig, [0, 100])
    near(overlay.bones[1]!.tailRig, [0, 160])
  })

  it('goes through the group matrix', () => {
    const overlay = rigOverlay({ id: 'g' }, bones, compToScreen, matrix(0, 1, 1, 100, 0))
    near(overlay.bones[0]!.head, compToScreen(100, 0))
  })

  it('marks controls and sides', () => {
    const overlay = rigOverlay({ id: 'g' }, [bone('Arm.L', [0, 0], [50, 0]), bone('Arm.R', [0, 0], [-50, 0]), bone('ctl', [0, 0], [0, 50], { deform: false })], compToScreen, IDENTITY)
    expect(overlay.bones.map((b) => [b.side, b.control])).toEqual([['left', false], ['right', false], [null, true]])
    expect(BONE_COLORS.left).not.toBe(BONE_COLORS.right)
  })
})

describe('sideOf', () => {
  it('reads sided names', () => {
    expect(['Arm.L', 'arm_L', 'Left Arm', 'L', 'LeftHand'].map(sideOf)).toEqual(['left', 'left', 'left', 'left', 'left'])
    expect(['Arm.R', 'arm_R', 'Right Arm', 'R', 'rightHand'].map(sideOf)).toEqual(['right', 'right', 'right', 'right', 'right'])
    expect(['Arm', 'Torso', 'Lower', 'Spine1'].map(sideOf)).toEqual([null, null, null, null])
  })
})

describe('hitBone', () => {
  const overlay = rigOverlay({ id: 'g' }, [bone('a', [0, 0], [100, 0]), bone('b', [100, 0], [200, 0], { parent: 'a' })], compToScreen, IDENTITY)
  // a: screen (320,180) to (370,180); b: (370,180) to (420,180).

  it('grabs the tail within 8 px', () => {
    expect(hitBone(overlay, [370 - 3, 180 + 4])).toEqual({ boneId: 'a', part: 'tail' })
    expect(hitBone(overlay, [420 + BONE_HIT_RADIUS - 0.5, 180])).toEqual({ boneId: 'b', part: 'tail' })
  })

  it('grabs the body along the bone', () => {
    expect(hitBone(overlay, [345, 180 + 6])).toEqual({ boneId: 'a', part: 'body' })
    expect(hitBone(overlay, [395, 180 - 6])).toEqual({ boneId: 'b', part: 'body' })
  })

  it('misses beyond 8 px', () => {
    expect(hitBone(overlay, [345, 180 + BONE_HIT_RADIUS + 1])).toBeNull()
    expect(hitBone(overlay, [500, 300])).toBeNull()
  })

  it('prefers a tail over a body that is nearer', () => {
    // On a's tail, which is also b's head and b's body: the tail of a wins.
    expect(hitBone(overlay, [370, 180])).toEqual({ boneId: 'a', part: 'tail' })
  })
})

describe('sweepDeg', () => {
  it('is clockwise positive on screen', () => {
    expect(sweepDeg([0, 0], [10, 0], [0, 10])).toBeCloseTo(90)
    expect(sweepDeg([0, 0], [10, 0], [0, -10])).toBeCloseTo(-90)
    expect(sweepDeg([5, 5], [15, 5], [15, 15])).toBeCloseTo(45)
  })

  it('takes the short way over the +-180 seam and ignores the length', () => {
    expect(sweepDeg([0, 0], [-10, -1], [-10, 1])).toBeCloseTo(-(2 * Math.atan(0.1) * 180) / Math.PI)
    expect(sweepDeg([0, 0], [1, 0], [300, 0])).toBeCloseTo(0)
    expect(sweepDeg([0, 0], [0, 0], [3, 4])).toBe(0)
  })

  it('sweeps the same in rig space as the pose turns, through a rotated, flipped group', () => {
    // Turning a bone by 40 degrees in rig space moves its tail by the same swept angle.
    for (const m of [IDENTITY, matrix(70, 1.4, 0.7, 12, 9), matrix(20, -1, 1, 0, 0)]) {
      const space = rigSpace(m, compToScreen)
      const head: Pt = [30, 20]
      const tail: Pt = [130, 20]
      const turned: Pt = [head[0] + 100 * Math.cos((40 * Math.PI) / 180), head[1] + 100 * Math.sin((40 * Math.PI) / 180)]
      const start = space.toScreen(tail[0], tail[1])
      const end = space.toScreen(turned[0], turned[1])
      const swept = sweepDeg(space.fromScreen(space.toScreen(head[0], head[1])), space.fromScreen(start), space.fromScreen(end))
      expect(swept).toBeCloseTo(40, 6)
    }
  })
})

describe('poseDelta', () => {
  it('moves along the bone for pose x and across it for pose y', () => {
    // A bone pointing down the screen: its x axis is rig +y.
    const overlay = rigOverlay({ id: 'g' }, [bone('c', [0, 0], [0, 50], { deform: false })], compToScreen, IDENTITY)
    const c = overlay.bones[0]!
    near(poseDelta(c, [0, 10]), [10, 0])
    near(poseDelta(c, [10, 0]), [0, -10])
  })

  it('ignores the bone\'s own turn: it measures from the frame before pose rotation', () => {
    const turned = bone('c', [0, 0], [50, 0], { pose: { rotation: 90, x: 0, y: 0, scale: 1 } })
    const c = rigOverlay({ id: 'g' }, [turned], compToScreen, IDENTITY).bones[0]!
    // Posed tail points down, but pose x still runs along the rest direction (rig +x).
    near(poseDelta(c, [10, 0]), [10, 0])
  })
})
