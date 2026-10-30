import { describe, expect, it } from 'vitest'
import { type Comp, CompSchema, type Layer, LayerSchema, TrackSchema, type Transform, TransformSchema } from './schema'
import {
  cameraFov,
  decomposeXYZ,
  defaultCamera,
  defaultCameraPose,
  focusDistanceOf,
  isWorld,
  liveCamera,
  lookAtRotation,
  mat4Compose,
  mat4Identity,
  mat4Invert,
  mat4Multiply,
  mat4RotateX,
  mat4RotateY,
  mat4RotateZ,
  mat4Scale,
  mat4Translate,
  mat4TransformPoint,
  PICTURE_AXES,
  projectWorldPoint,
  type Vec3,
  worldMatrix,
  worldObjects,
} from './world'

const DEG = Math.PI / 180

/** A small deterministic random source, so failures repeat. */
function rng(seed: number) {
  let s = seed
  return (lo: number, hi: number) => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return lo + (s / 4294967296) * (hi - lo)
  }
}

const transform = (over: Partial<Transform> = {}): Transform => TransformSchema.parse(over)

const layer = (id: string, kind: string, startMs: number, durationMs: number, extra: Record<string, unknown> = {}) =>
  LayerSchema.parse({ id, name: id, kind, startMs, durationMs, ...(kind === 'text' ? { text: 'Hi' } : {}), ...extra })

const lane = (id: string, layers: Layer[], extra: Record<string, unknown> = {}) => TrackSchema.parse({ id, layers, ...extra })

const world = (tracks: ReturnType<typeof lane>[]): Comp =>
  CompSchema.parse({ id: 'w', name: 'World', width: 1920, height: 1080, fps: 30, durationMs: 10_000, world: {}, tracks })

/** Applies a matrix to a point and drops w. */
const apply = (m: number[], p: Vec3): Vec3 => {
  const [x, y, z] = mat4TransformPoint(m, ...p)
  return [x, y, z]
}

const expectVec = (actual: readonly number[], expected: readonly number[], digits = 9) => {
  expect(actual).toHaveLength(expected.length)
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, digits))
}

describe('matrices', () => {
  it('inverts and multiplies', () => {
    const m = mat4Compose(mat4Translate(3, -4, 5), mat4RotateZ(0.4), mat4RotateY(-0.7), mat4RotateX(1.1), mat4Scale(2, 3, 0.5))
    const inv = mat4Invert(m)
    expect(inv).not.toBeNull()
    const id = mat4Multiply(m, inv as number[])
    mat4Identity().forEach((v, i) => expect(id[i]).toBeCloseTo(v, 9))
    expect(mat4Invert(mat4Scale(0, 1, 1))).toBeNull()
  })

  it('uses the standard right-handed turns', () => {
    expectVec(apply(mat4RotateX(90 * DEG), [0, 1, 0]), [0, 0, 1])
    expectVec(apply(mat4RotateX(90 * DEG), [0, 0, -1]), [0, 1, 0])
    expectVec(apply(mat4RotateY(90 * DEG), [0, 0, 1]), [1, 0, 0])
    expectVec(apply(mat4RotateZ(90 * DEG), [1, 0, 0]), [0, 1, 0])
  })
})

describe('worlds', () => {
  it('is a world exactly when it has `world`', () => {
    expect(isWorld(world([]))).toBe(true)
    expect(isWorld(CompSchema.parse({ id: 'f', name: 'Flat', width: 1280, height: 720, fps: 30, durationMs: 1000 }))).toBe(false)
  })
})

describe('default camera and lenses', () => {
  it('stands one sensor-fit distance in front', () => {
    const pose = defaultCameraPose(1920, 1080)
    expect(pose.distance).toBeCloseTo(2666.67, 2)
    expect(pose.position[0]).toBe(0)
    expect(pose.position[1]).toBeCloseTo(-2666.67, 2)
    expect(pose.position[2]).toBe(0)
    expect(pose.rotationX).toBe(90)
    expect(defaultCameraPose(1080, 1920).distance).toBeCloseTo(2666.67, 2)
  })

  it('has a 36 mm sensor across the longer side', () => {
    const fov = 2 * Math.atan(18 / 50) * (180 / Math.PI)
    expect(fov).toBeCloseTo(39.598, 3)
    const land = cameraFov({ focalLength: 50, sensorWidth: 36 }, 1920, 1080)
    expect(land.fovX).toBeCloseTo(fov, 9)
    expect(land.fovY).toBeLessThan(land.fovX)
    expect(land.fovY).toBeCloseTo(2 * Math.atan(Math.tan(fov * DEG / 2) * 0.5625) / DEG, 9)
    const port = cameraFov({ focalLength: 50, sensorWidth: 36 }, 1080, 1920)
    expect(port.fovY).toBeCloseTo(fov, 9)
    expect(port.fovX).toBeCloseTo(land.fovY, 9)
  })

  it('maps the plane y = 0 one unit to one pixel and halves things twice as far', () => {
    const cam = defaultCamera(1920, 1080)
    expectVec(projectWorldPoint(cam, 1920, 1080, [0, 0, 0]) as number[], [960, 540])
    expectVec(projectWorldPoint(cam, 1920, 1080, [100, 0, -50]) as number[], [1060, 590])
    expectVec(projectWorldPoint(cam, 1920, 1080, [-300, 0, 200]) as number[], [660, 340])
    const d = defaultCameraPose(1920, 1080).distance
    expectVec(projectWorldPoint(cam, 1920, 1080, [200, d, -100]) as number[], [960 + 100, 540 + 50])
    expect(projectWorldPoint(cam, 1920, 1080, [0, -d, 0])).toBeNull()
    expect(projectWorldPoint(cam, 1920, 1080, [0, -d - 5, 0])).toBeNull()
  })

  it('projects orthographically over the longer side and shifts by fractions of it', () => {
    const base = defaultCamera(1920, 1080)
    const ortho = { ...base, spec: { ...base.spec, projection: 'orthographic' as const, orthoScale: 960 } }
    expectVec(projectWorldPoint(ortho, 1920, 1080, [100, 5000, -50]) as number[], [960 + 200, 540 + 100])
    const shifted = { ...base, spec: { ...base.spec, shiftX: 0.1, shiftY: 0.05 } }
    expectVec(projectWorldPoint(shifted, 1920, 1080, [0, 0, 0]) as number[], [960 - 192, 540 + 96])
  })
})

describe('live camera', () => {
  const cam = (id: string, start: number, dur: number, extra: Record<string, unknown> = {}) => layer(id, 'camera', start, dur, extra)

  it('takes the front lane', () => {
    const comp = world([lane('a', [cam('front', 0, 5000)]), lane('b', [cam('back', 0, 5000)])])
    expect(liveCamera(comp, 1000)?.id).toBe('front')
  })

  it('skips hidden lanes and disabled layers', () => {
    const hidden = world([lane('a', [cam('front', 0, 5000)], { hidden: true }), lane('b', [cam('back', 0, 5000)])])
    expect(liveCamera(hidden, 1000)?.id).toBe('back')
    const off = world([lane('a', [cam('front', 0, 5000, { enabled: false })]), lane('b', [cam('back', 0, 5000)])])
    expect(liveCamera(off, 1000)?.id).toBe('back')
  })

  it('cuts exactly at the cut on one lane', () => {
    const comp = world([lane('a', [cam('one', 0, 2000), cam('two', 2000, 2000)])])
    expect(liveCamera(comp, 0)?.id).toBe('one')
    expect(liveCamera(comp, 1999.9)?.id).toBe('one')
    expect(liveCamera(comp, 2000)?.id).toBe('two')
    expect(liveCamera(comp, 3999.9)?.id).toBe('two')
  })

  it('is null in a gap, past the end and with no camera', () => {
    const comp = world([lane('a', [cam('one', 0, 1000), cam('two', 3000, 1000)])])
    expect(liveCamera(comp, 1000)).toBeNull()
    expect(liveCamera(comp, 2000)).toBeNull()
    expect(liveCamera(comp, 4000)).toBeNull()
    expect(liveCamera(world([lane('a', [layer('t', 'text', 0, 1000)])]), 500)).toBeNull()
  })
})

describe('look at', () => {
  it('turns the default camera to [90, 0, 0]', () => {
    const turn = lookAtRotation([0, -defaultCameraPose(1920, 1080).distance, 0], [0, 0, 0], 'camera')
    expectVec([turn.rotationX, turn.rotationY, turn.rotation], [90, 0, 0])
  })

  it('aims the right local axis at random targets', () => {
    const random = rng(7)
    for (let i = 0; i < 200; i++) {
      const position: Vec3 = [random(-3000, 3000), random(-3000, 3000), random(-3000, 3000)]
      const target: Vec3 = [random(-3000, 3000), random(-3000, 3000), random(-3000, 3000)]
      const len = Math.hypot(target[0] - position[0], target[1] - position[1], target[2] - position[2])
      const aim = [(target[0] - position[0]) / len, (target[1] - position[1]) / len, (target[2] - position[2]) / len]
      for (const kind of ['camera', 'light', 'empty', 'text'] as const) {
        const turn = lookAtRotation(position, target, kind)
        const m = worldMatrix({ kind: kind === 'text' ? 'empty' : kind, transform: transform({ ...turn }) }, null)
        const local: Vec3 = kind === 'camera' || kind === 'light' ? [0, 0, -1] : [0, -1, 0]
        const dir = mat4TransformPoint(m, ...local)
        expectVec([dir[0], dir[1], dir[2]], aim, 9)
        const up = mat4TransformPoint(m, ...(kind === 'camera' || kind === 'light' ? ([0, 1, 0] as Vec3) : ([0, 0, 1] as Vec3)))
        expect(up[2]).toBeGreaterThanOrEqual(-1e-12)
      }
    }
  })

  it('is stable looking straight down and up, and on a zero aim', () => {
    const down = lookAtRotation([0, 0, 100], [0, 0, 0], 'camera')
    const m = worldMatrix({ kind: 'camera', transform: transform({ ...down }) }, null)
    expectVec(apply(m, [0, 0, -1]), [0, 0, -1])
    expectVec(apply(m, [0, 1, 0]), [0, 1, 0])
    expect(lookAtRotation([1, 2, 3], [1, 2, 3], 'camera')).toEqual({ rotationX: 0, rotationY: 0, rotation: 0 })
    const up = lookAtRotation([0, 0, 0], [0, 0, 50], 'camera')
    expectVec(apply(worldMatrix({ kind: 'camera', transform: transform({ ...up }) }, null), [0, 0, -1]), [0, 0, 1])
  })
})

describe('decompose', () => {
  it('round-trips T·Rz·Ry·Rx·S', () => {
    const random = rng(11)
    for (let i = 0; i < 200; i++) {
      const t = transform({
        x: random(-1000, 1000),
        y: random(-1000, 1000),
        z: random(-1000, 1000),
        rotationX: random(-180, 180),
        rotationY: random(-88, 88),
        rotation: random(-180, 180),
        scaleX: random(0.1, 5),
        scaleY: random(0.1, 5),
        scaleZ: random(0.1, 5),
      })
      const pose = decomposeXYZ(worldMatrix({ kind: 'empty', transform: t }, null))
      expectVec(pose.position, [t.x, t.y, t.z])
      expectVec([pose.rotation.rotationX, pose.rotation.rotationY, pose.rotation.rotation], [t.rotationX, t.rotationY, t.rotation], 7)
      expectVec(pose.scale, [t.scaleX, t.scaleY, t.scaleZ])
    }
  })

  it('rebuilds the same matrix at gimbal lock', () => {
    for (const rotationY of [90, -90]) {
      const m = worldMatrix({ kind: 'empty', transform: transform({ rotationX: 30, rotationY, rotation: 40, scaleX: 2 }) }, null)
      const pose = decomposeXYZ(m)
      expect(pose.rotation.rotation).toBe(0)
      const back = worldMatrix(
        { kind: 'empty', transform: transform({ ...pose.rotation, x: pose.position[0], y: pose.position[1], z: pose.position[2], scaleX: pose.scale[0], scaleY: pose.scale[1], scaleZ: pose.scale[2] }) },
        null,
      )
      m.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 9))
    }
  })
})

describe('world matrix', () => {
  it('turns a picture into the XZ plane facing -Y', () => {
    const m = worldMatrix({ kind: 'text', transform: transform() }, { width: 200, height: 100 })
    expectVec(apply(m, [100, 0, 0]), [100, 0, 0])
    expectVec(apply(m, [0, 100, 0]), [0, 0, -100])
    expectVec(apply(m, [0, 0, 100]), [0, 100, 0])
    expectVec(apply(PICTURE_AXES, [1, 2, 3]), [1, 3, -2])
  })

  it('puts the pivot on the position', () => {
    const m = worldMatrix({ kind: 'shape', transform: transform({ anchorX: 0, anchorY: 0, x: 10, y: 20, z: 30 }) }, { width: 200, height: 100 })
    // The top-left corner of the box (-100, -50) is the pivot.
    expectVec(apply(m, [-100, -50, 0]), [10, 20, 30])
    expectVec(apply(m, [100, 50, 0]), [210, 20, 30 - 100])
    const centred = worldMatrix({ kind: 'shape', transform: transform({ x: 10, y: 20, z: 30 }) }, { width: 200, height: 100 })
    expectVec(apply(centred, [0, 0, 0]), [10, 20, 30])
    // No box: the pivot is the centre.
    expectVec(apply(worldMatrix({ kind: 'shape', transform: transform({ anchorX: 0 }) }, null), [0, 0, 0]), [0, 0, 0])
  })

  it('scales a picture as (x, z, y) and a spatial layer as (x, y, z)', () => {
    const t = transform({ scaleX: 2, scaleY: 3, scaleZ: 5 })
    const picture = worldMatrix({ kind: 'image', transform: t }, { width: 100, height: 100 })
    expectVec(apply(picture, [1, 0, 0]), [2, 0, 0])
    expectVec(apply(picture, [0, 1, 0]), [0, 0, -3])
    expectVec(apply(picture, [0, 0, 1]), [0, 5, 0])
    const empty = worldMatrix({ kind: 'empty', transform: t }, null)
    expectVec(apply(empty, [1, 1, 1]), [2, 3, 5])
  })

  it('applies T·Rz·Ry·Rx in that order', () => {
    const t = transform({ rotation: 90, rotationX: 90, x: 7 })
    const m = worldMatrix({ kind: 'empty', transform: t }, null)
    // Rx(90) takes +Y to +Z, then Rz(90) leaves +Z.
    expectVec(apply(m, [0, 1, 0]), [7, 0, 1])
    // Rx(90) leaves +X, then Rz(90) takes it to +Y.
    expectVec(apply(m, [1, 0, 0]), [7, 1, 0])
  })
})

describe('world objects', () => {
  it('samples keyed values at the layer time', () => {
    const keyed = layer('box', 'empty', 1000, 4000, {
      animations: {
        'transform.x': [
          { t: 0, v: 0, ease: 'linear' },
          { t: 2000, v: 100, ease: 'linear' },
        ],
        'transform.scaleZ': [
          { t: 0, v: 1, ease: 'linear' },
          { t: 2000, v: 3, ease: 'linear' },
        ],
      },
    })
    const comp = world([lane('a', [keyed])])
    const [obj] = worldObjects(comp, 2000)
    expect(obj?.transform.x).toBeCloseTo(50)
    expect(obj?.position[0]).toBeCloseTo(50)
    expect(obj?.scale[2]).toBeCloseTo(2)
    expect(obj?.kind).toBe('empty')
    expect(worldObjects(comp, 3000)[0]?.position[0]).toBeCloseTo(100)
  })

  it('moves a member with its group, outermost first', () => {
    const inner = layer('inner', 'group', 0, 5000, { transform: { x: 10, z: 5 } })
    const outer = layer('outer', 'group', 0, 5000, { transform: { x: 100, rotation: 90, opacity: 0.5 } })
    const member = layer('m', 'empty', 0, 5000, { transform: { x: 1, opacity: 0.5 } })
    const comp = world([
      lane('g1', [outer]),
      lane('g2', [inner], { groupId: 'outer' }),
      lane('m1', [member], { groupId: 'inner' }),
    ])
    const objects = worldObjects(comp, 0)
    expect(objects.map((o) => o.layer.id)).toEqual(['outer', 'inner', 'm'])
    expect(objects.map((o) => o.parentId)).toEqual([null, 'outer', 'inner'])
    const [, innerObj, m] = objects
    // inner: (10, 0, 5) turned 90° about Z (x → y) then moved by 100.
    expectVec(innerObj?.position as number[], [100, 10, 5])
    // member at (1, 0, 0) inside inner: (11, 0, 5) turned and moved.
    expectVec(m?.position as number[], [100, 11, 5])
    expect(m?.opacity).toBeCloseTo(0.25)
    expect(objects[0]?.opacity).toBeCloseTo(0.5)
  })

  it('has no pivot or axis change for a group', () => {
    const group = layer('g', 'group', 0, 5000, { transform: { x: 5, scaleY: 2, scaleZ: 3 } })
    const [obj] = worldObjects(world([lane('a', [group])]), 0)
    expectVec(apply(obj?.matrix as number[], [1, 1, 1]), [6, 3, 2])
  })

  it('passes the box to a picture for its pivot', () => {
    const text = layer('t', 'text', 0, 5000, { transform: { anchorX: 0, anchorY: 0 } })
    const comp = world([lane('a', [text])])
    const [obj] = worldObjects(comp, 0, { box: () => ({ width: 200, height: 100 }) })
    expectVec(apply(obj?.matrix as number[], [-100, -50, 0]), [0, 0, 0])
    const [plain] = worldObjects(comp, 0)
    expectVec(apply(plain?.matrix as number[], [-100, -50, 0]), [-100, 0, 50])
  })

  it('drops hidden lanes, disabled layers, audio and layers outside their span', () => {
    const comp = world([
      lane('a', [layer('hid', 'empty', 0, 5000)], { hidden: true }),
      lane('b', [layer('off', 'empty', 0, 5000, { enabled: false })]),
      lane('c', [layer('snd', 'audio', 0, 5000, { mediaId: 'x' })]),
      lane('d', [layer('early', 'empty', 0, 1000), layer('late', 'empty', 3000, 1000), layer('on', 'light', 4000, 1000)]),
    ])
    expect(worldObjects(comp, 500).map((o) => o.layer.id)).toEqual(['early'])
    expect(worldObjects(comp, 1000)).toEqual([])
    expect(worldObjects(comp, 3000).map((o) => o.layer.id)).toEqual(['late'])
    expect(worldObjects(comp, 4000).map((o) => o.layer.id)).toEqual(['on'])
    expect(worldObjects(comp, 5000)).toEqual([])
  })

  it('lists lanes front first', () => {
    const comp = world([lane('a', [layer('front', 'empty', 0, 1000)]), lane('b', [layer('back', 'empty', 0, 1000)])])
    expect(worldObjects(comp, 0).map((o) => o.layer.id)).toEqual(['front', 'back'])
  })
})

describe('focusDistanceOf', () => {
  it('measures along the view axis from the default camera', () => {
    const cam = defaultCamera(1920, 1080)
    const d = defaultCameraPose(1920, 1080).distance
    expect(focusDistanceOf(cam.matrix, [0, 500, 0])).toBeCloseTo(500 + d, 9)
    expect(focusDistanceOf(cam.matrix, [0, 0, 0])).toBeCloseTo(d, 9)
    // Sideways and up offsets do not change the depth.
    expect(focusDistanceOf(cam.matrix, [300, 0, -200])).toBeCloseTo(d, 9)
  })

  it('is 0 for points level with or behind the camera, and ignores scale', () => {
    const cam = defaultCamera(1920, 1080)
    const d = defaultCameraPose(1920, 1080).distance
    expect(focusDistanceOf(cam.matrix, [0, -d, 0])).toBe(0)
    expect(focusDistanceOf(cam.matrix, [0, -d - 100, 0])).toBe(0)
    const scaled = mat4Compose(cam.matrix, mat4Scale(3, 3, 3))
    expect(focusDistanceOf(scaled, [0, 500, 0])).toBeCloseTo(500 + d, 9)
  })

  it('follows a turned camera', () => {
    const aim = lookAtRotation([100, 0, 0], [100, 0, 700], 'camera')
    const m = mat4Compose(mat4Translate(100, 0, 0), mat4RotateZ(aim.rotation * DEG), mat4RotateY(aim.rotationY * DEG), mat4RotateX(aim.rotationX * DEG))
    expect(focusDistanceOf(m, [100, 0, 700])).toBeCloseTo(700, 6)
    expect(focusDistanceOf(m, [400, 50, 300])).toBeCloseTo(300, 6)
  })
})
