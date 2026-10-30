import type { Bone } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { affApply, autoBone, type BonePose, solveRig } from './rig'

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

const pose = (p: Partial<BonePose>): BonePose => ({ rotation: 0, x: 0, y: 0, scale: 1, ...p })
const near = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, -Math.log10(eps)))

describe('solveRig: forward kinematics', () => {
  const chain = [bone('a', [0, 0], [100, 0]), bone('b', [100, 0], [200, 0], { parent: 'a' })]

  it('leaves everything in place at rest', () => {
    const solved = solveRig(chain)
    near(affApply(solved.get('b')!.matrix, 150, 7), [150, 7])
    near(solved.get('b')!.tail, [200, 0])
  })

  it('turns a child with its parent, clockwise on screen', () => {
    const solved = solveRig(chain, new Map([['a', pose({ rotation: 90 })]]))
    near(solved.get('a')!.tail, [0, 100])
    near(solved.get('b')!.head, [0, 100])
    near(solved.get('b')!.tail, [0, 200])
    // The matrix takes a rest point of the child to its posed place.
    near(affApply(solved.get('b')!.matrix, 150, 0), [0, 150])
  })

  it("carries the joint along when the parent stretches, but does not stretch the child", () => {
    const solved = solveRig(chain, new Map([['a', pose({ scale: 2 })]]))
    near(solved.get('a')!.tail, [200, 0])
    near(solved.get('b')!.head, [200, 0])
    near(solved.get('b')!.tail, [300, 0])
    // The parent's piece stretches about its head; the child's piece only moves.
    near(affApply(solved.get('a')!.matrix, 100, 10), [200, 10])
    near(affApply(solved.get('b')!.matrix, 150, 10), [250, 10])
  })

  it("adds a child's own turn to its parent's", () => {
    const solved = solveRig(chain, new Map([['a', pose({ rotation: 90 })], ['b', pose({ rotation: -90 })]]))
    near(solved.get('b')!.tail, [100, 100])
  })

  it('holds each channel to its limits', () => {
    const limited = [bone('a', [0, 0], [100, 0], { limits: { rotation: [-10, 10], scale: [1, 1.5] } })]
    const solved = solveRig(limited, new Map([['a', pose({ rotation: 90, scale: 4 })]]))
    const r = (10 * Math.PI) / 180
    near(solved.get('a')!.tail, [150 * Math.cos(r), 150 * Math.sin(r)])
  })

  it('solves bones whatever order they are listed in', () => {
    const solved = solveRig([chain[1]!, chain[0]!], new Map([['a', pose({ rotation: 90 })]]))
    near(solved.get('b')!.tail, [0, 200])
  })
})

describe('solveRig: inverse kinematics', () => {
  const arm = (ik: Bone['ik'], limits?: Bone['limits']): Bone[] => [
    bone('upper', [0, 0], [100, 0], limits ? { limits } : {}),
    bone('lower', [100, 0], [200, 0], { parent: 'upper', ik }),
    bone('goal', [50, 100], [60, 100], { deform: false }),
  ]
  const tipAfter = (bones: Bone[], goal: Partial<BonePose>) => solveRig(bones, new Map([['goal', pose(goal)]]))

  it('reaches a reachable target', () => {
    for (const goal of [{ x: 20, y: -30 }, { x: 60, y: 40 }, { x: -40, y: -90 }]) {
      const solved = tipAfter(arm({ target: 'goal', chain: 2, flip: false, mix: 1 }), goal)
      near(solved.get('lower')!.tail, [50 + goal.x, 100 + goal.y])
      // The two bones keep their lengths and stay joined.
      near(solved.get('upper')!.tail, solved.get('lower')!.head)
      const [ux, uy] = solved.get('upper')!.tail
      expect(Math.hypot(ux, uy)).toBeCloseTo(100, 6)
    }
  })

  it('bends the other way with flip, and still reaches', () => {
    const goal = { x: 20, y: -30 }
    const a = tipAfter(arm({ target: 'goal', chain: 2, flip: false, mix: 1 }), goal)
    const b = tipAfter(arm({ target: 'goal', chain: 2, flip: true, mix: 1 }), goal)
    near(b.get('lower')!.tail, [70, 70])
    // Mirrored about the line from shoulder to target.
    const [ax, ay] = a.get('lower')!.head
    const [bx, by] = b.get('lower')!.head
    expect(Math.hypot(ax - bx, ay - by)).toBeGreaterThan(10)
    const d = Math.hypot(70, 70)
    const side = (x: number, y: number) => (70 * y - 70 * x) / d
    expect(Math.sign(side(ax, ay))).toBe(-Math.sign(side(bx, by)))
    expect(Math.abs(side(ax, ay))).toBeCloseTo(Math.abs(side(bx, by)), 6)
  })

  it('stretches nothing and points straight at a target out of reach', () => {
    const solved = tipAfter(arm({ target: 'goal', chain: 2, flip: false, mix: 1 }), { x: 450, y: -100 })
    const [tx, ty] = solved.get('lower')!.tail
    expect(Math.hypot(tx, ty)).toBeCloseTo(200, 6)
    expect(Math.atan2(ty, tx)).toBeCloseTo(Math.atan2(0, 500), 6)
  })

  it('respects rotation limits of the chain', () => {
    const solved = tipAfter(arm({ target: 'goal', chain: 2, flip: false, mix: 1 }, { rotation: [-5, 5] }), { x: 0, y: 60 })
    const [x, y] = solved.get('upper')!.tail
    expect(Math.atan2(y, x)).toBeLessThanOrEqual((5 * Math.PI) / 180 + 1e-9)
    const [tx, ty] = solved.get('lower')!.tail
    expect(Math.hypot(tx - 50, ty - 160)).toBeGreaterThan(1)
  })

  it('mixes with the plain pose', () => {
    const full = tipAfter(arm({ target: 'goal', chain: 2, flip: false, mix: 1 }), { y: -80 })
    const none = tipAfter(arm({ target: 'goal', chain: 2, flip: false, mix: 0 }), { y: -80 })
    const half = tipAfter(arm({ target: 'goal', chain: 2, flip: false, mix: 0.5 }), { y: -80 })
    near(none.get('lower')!.tail, [200, 0])
    const [fx, fy] = full.get('upper')!.tail
    const [hx, hy] = half.get('upper')!.tail
    expect(Math.atan2(hy, hx)).toBeCloseTo(Math.atan2(fy, fx) / 2, 6)
  })

  it('aims a single bone at its target with chain 1', () => {
    const bones = [bone('lone', [0, 0], [100, 0], { ik: { target: 'goal', chain: 1, flip: false, mix: 1 } }), bone('goal', [0, 300], [10, 300], { deform: false })]
    const solved = solveRig(bones, new Map())
    near(solved.get('lone')!.tail, [0, 100])
  })
})

describe('autoBone', () => {
  const bones = [
    bone('torso', [0, 100], [0, -100]),
    bone('arm', [0, -80], [150, -80], { parent: 'torso' }),
    bone('hand', [150, -80], [200, -80], { parent: 'arm' }),
    bone('ctrl', [300, 0], [300, 50], { deform: false }),
  ]
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height })

  it('picks the deform bone with the longest run through the box', () => {
    expect(autoBone(bones, box(-30, -120, 60, 240))?.id).toBe('torso')
    expect(autoBone(bones, box(20, -100, 100, 40))?.id).toBe('arm')
  })

  it('never picks a control', () => {
    expect(autoBone(bones, box(280, -10, 40, 80))?.id).not.toBe('ctrl')
  })

  it('takes a bone whose tail is in the box when nothing runs through it', () => {
    // Only the very end of the hand pokes in.
    expect(autoBone(bones, box(195, -95, 30, 30))?.id).toBe('hand')
  })

  it("takes the parent of a bone that starts in the box", () => {
    expect(autoBone(bones, box(145, -100, 4, 40))?.id).toBe('arm')
  })

  it('falls back to the nearest bone', () => {
    expect(autoBone(bones, box(-20, 400, 40, 40))?.id).toBe('torso')
    expect(autoBone([], box(0, 0, 10, 10))).toBeNull()
  })
})
