import { type Comp, type Force, isWorld, type Joint, type Layer, type MediaAsset, type PhysicsBody, PhysicsSceneSchema, type Track } from '@uve/core'
import { type Body, Circle, type Contact, DistanceJoint, type Fixture, type JointDef, Polygon, RevoluteJoint, RopeJoint, Vec2, WeldJoint, World } from 'planck'
import type { Ctx2D } from '../content'
import { isActiveAt, resolveLayer } from '../evaluate'
import type { SceneNode } from '../scene'
import { bodyColliders, type Collider } from './colliders'

// A comp's physics, run from the document: planck (a Box2D port) in metres,
// stepped at a fixed 120 Hz from the comp's physics start. Steps are computed
// on demand and kept, so any frame (scrubbed, looped, exported) reads the same
// result, and the same document always gives the same numbers. The scene reads
// each body's pose at a frame's time; nothing is baked into keys.

/** Simulation steps per second of simulated time. */
export const PHYSICS_HZ = 120
/** The most steps a simulation runs (two minutes). */
export const MAX_PHYSICS_STEPS = 120 * PHYSICS_HZ
/** Comp px per metre inside the engine (1 px = 1 cm). */
const PX = 100
const VELOCITY_ITERATIONS = 10
const POSITION_ITERATIONS = 4
/** How thick the floor and walls are, in metres: thick enough that nothing tunnels through. */
const SLAB = 20

/** A body's pose at a moment, in comp px and degrees (clockwise). */
export interface BodyPose {
  x: number
  y: number
  rotation: number
}

/** What a body is, for physics.inspect and overlays. */
export interface BodyInfo {
  id: string
  name: string
  type: PhysicsBody['type']
  /** Its colliders in comp space when it entered the simulation. */
  colliders: Collider[]
  /** Comp time it entered at. */
  enteredMs: number
}

interface BodyPlan {
  layer: Layer
  physics: PhysicsBody
  enterStep: number
  exitStep: number
}

interface Live {
  plan: BodyPlan
  body: Body
  /** For a group: the reference point's offset from its transform's x, y (the box pivot) at entry. */
  offset: [number, number]
}

interface Record {
  first: number
  data: number[]
}

/** Builds the comp's top-level scene at a comp time with physics off (scene.ts provides it). */
export type BuildScene = (timeMs: number) => SceneNode[]

/** What a simulation needs besides the comp. */
export interface PhysicsSource {
  measure: Ctx2D
  media: readonly MediaAsset[]
}

const toRad = (deg: number) => (deg * Math.PI) / 180
const toDeg = (rad: number) => (rad * 180) / Math.PI

/** A body's reference point (its pivot) and angle: transform x, y, rotation, plus a group's box pivot. */
function reference(node: SceneNode): [number, number, number] {
  const t = node.resolved.transform
  if (node.kind === 'group') return [t.x + node.box.left + t.anchorX * node.box.width, t.y + node.box.top + t.anchorY * node.box.height, t.rotation]
  return [t.x, t.y, t.rotation]
}

/** Box2D damping per second from a 0..1 share of speed lost per second. */
function dampingOf(share: number): number {
  return share >= 0.999 ? 20 : -Math.log(1 - Math.max(0, share))
}

/** How much of a force reaches a point `distance` px from its carrier. */
function reach(force: Force, distance: number): number {
  if (force.radius <= 0) return 1
  if (distance >= force.radius) return 0
  const s = 1 - distance / force.radius
  return force.falloff === 'none' ? 1 : force.falloff === 'linear' ? s : s * s * (3 - 2 * s)
}

/** A smooth, seeded noise in −1..1 (value noise on a lattice, eased between corners). */
function noise(x: number, y: number, z: number, seed: number): number {
  const hash = (i: number, j: number, k: number) => {
    let h = Math.imul(i, 0x27d4eb2f) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x9e3779b1) ^ Math.imul(seed, 0x85ebca6b)
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
    return ((h ^ (h >>> 15)) >>> 0) / 0xffffffff
  }
  const [i, j, k] = [Math.floor(x), Math.floor(y), Math.floor(z)]
  const ease = (t: number) => t * t * (3 - 2 * t)
  const [u, v, w] = [ease(x - i), ease(y - j), ease(z - k)]
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const plane = (kk: number) => lerp(lerp(hash(i, j, kk), hash(i + 1, j, kk), u), lerp(hash(i, j + 1, kk), hash(i + 1, j + 1, kk), u), v)
  return lerp(plane(k), plane(k + 1), w) * 2 - 1
}

/** The acceleration (px/s²) a force gives a body at `p` moving at `v`, from a carrier at `c` turned `angle` degrees. */
export function forceAcceleration(force: Force, c: readonly [number, number], angle: number, p: readonly [number, number], v: readonly [number, number], simSeconds: number): [number, number] {
  const dx = p[0] - c[0]
  const dy = p[1] - c[1]
  const distance = Math.hypot(dx, dy)
  const w = reach(force, distance) * force.strength
  if (w === 0) return [0, 0]
  switch (force.type) {
    case 'wind':
      return [w * Math.cos(toRad(angle)), w * Math.sin(toRad(angle))]
    case 'point':
      return distance < 1 ? [0, 0] : [(-dx / distance) * w, (-dy / distance) * w]
    case 'vortex': {
      if (distance < 1) return [0, 0]
      // Clockwise around the carrier (+y is down), with a quarter of it pulling in so things swirl rather than fly off.
      const [nx, ny] = [dx / distance, dy / distance]
      return [-ny * w - nx * w * 0.25, nx * w - ny * w * 0.25]
    }
    case 'turbulence': {
      const s = force.scale
      const t = simSeconds * 0.6
      return [w * noise(p[0] / s, p[1] / s, t, force.seed), w * noise(p[0] / s + 31.7, p[1] / s - 17.3, t, force.seed + 1013)]
    }
    case 'drag': {
      const k = Math.min(20, Math.max(0, (reach(force, distance) * force.strength) / 100))
      return [-v[0] * k, -v[1] * k]
    }
  }
}

/** A comp's physics. Built by `simulationFor`; read a body's pose with `poseAt`. */
export class Simulation {
  readonly settings
  private readonly world: World
  private readonly plans: BodyPlan[]
  private readonly live = new Map<string, Live>()
  private readonly records = new Map<string, Record>()
  private readonly infos = new Map<string, BodyInfo>()
  private readonly carriers: Layer[]
  private readonly scenes = new Map<number, SceneNode[]>()
  private ground: Body
  private topWall: Fixture | null = null
  private pendingJoints: { owner: Layer; joint: Joint }[] = []
  /** Steps done so far (the state after `done` steps is recorded). */
  private done = -1

  constructor(
    readonly comp: Comp,
    private readonly source: PhysicsSource,
    private readonly build: BuildScene,
  ) {
    this.settings = PhysicsSceneSchema.parse(comp.physics ?? {})
    const s = this.settings
    this.world = new World({ gravity: new Vec2(0, s.gravity / PX), allowSleep: true })
    this.ground = this.world.createBody({ type: 'static' })
    const top = comp.tracks.filter((t) => t.groupId === null && !t.hidden)
    const stepOf = (ms: number) => Math.max(0, Math.ceil(((ms - s.startMs) * PHYSICS_HZ * s.timeScale) / 1000 - 1e-6))
    this.plans = top
      .flatMap((t) => t.layers)
      .filter((l) => l.enabled && l.physics && l.kind !== 'audio')
      .map((layer) => ({
        layer,
        physics: layer.physics as PhysicsBody,
        enterStep: stepOf(Math.max(s.startMs, layer.startMs)),
        exitStep: stepOf(layer.startMs + layer.durationMs),
      }))
      .filter((p) => p.exitStep > p.enterStep)
    const visible = (track: Track) => !track.hidden
    this.carriers = comp.tracks.filter(visible).flatMap((t) => t.layers.filter((l) => l.enabled && (l.forces?.length ?? 0) > 0))
    this.stage()
    this.world.on('pre-solve', (contact: Contact) => this.oneSided(contact))
  }

  /** Every body, with its colliders once it has entered. */
  bodies(): BodyInfo[] {
    return this.plans.map((p) => this.infos.get(p.layer.id) ?? { id: p.layer.id, name: p.layer.name, type: p.physics.type, colliders: [], enteredMs: this.compMs(p.enterStep) })
  }

  /** The comp time of a step. */
  compMs(step: number): number {
    return this.settings.startMs + (step * 1000) / (PHYSICS_HZ * this.settings.timeScale)
  }

  /** Where a body is at a comp time, or null when physics does not move it then (before the start, outside its clip, not a body). */
  poseAt(layerId: string, compMs: number): BodyPose | null {
    if (compMs < this.settings.startMs || !this.plans.some((p) => p.layer.id === layerId)) return null
    const f = Math.min(MAX_PHYSICS_STEPS, ((compMs - this.settings.startMs) * PHYSICS_HZ * this.settings.timeScale) / 1000)
    let n = Math.floor(f + 1e-6)
    const frac = f - n > 1e-6 ? f - n : 0
    this.advance(Math.min(MAX_PHYSICS_STEPS, frac > 0 ? n + 1 : n))
    const record = this.records.get(layerId)
    if (!record) return null
    const count = record.data.length / 3
    if (n < record.first || n >= record.first + count) return null
    const at = (i: number) => record.data.slice((i - record.first) * 3, (i - record.first) * 3 + 3) as [number, number, number]
    const a = at(n)
    if (frac > 0 && n + 1 < record.first + count) {
      const b = at(n + 1)
      return { x: a[0] + (b[0] - a[0]) * frac, y: a[1] + (b[1] - a[1]) * frac, rotation: toDeg(a[2] + (b[2] - a[2]) * frac) }
    }
    return { x: a[0], y: a[1], rotation: toDeg(a[2]) }
  }

  /** The floor and walls. */
  private stage(): void {
    const { width, height } = this.comp
    const s = this.settings
    const slab = (cx: number, cy: number, hw: number, hh: number) => {
      const body = this.world.createBody({ type: 'static', position: new Vec2(cx, cy) })
      return body.createFixture(new Polygon([new Vec2(-hw, -hh), new Vec2(hw, -hh), new Vec2(hw, hh), new Vec2(-hw, hh)]), { friction: 0.6, restitution: 0 })
    }
    const [w, h] = [width / PX, height / PX]
    if (s.floor) slab(0, (s.floorAt ?? height / 2) / PX + SLAB, w * 20 + SLAB, SLAB)
    if (s.walls) {
      // The sides reach far above the frame, so things dropped from above stay inside; the top only stops things already in the frame.
      slab(-w / 2 - SLAB, -h * 10, SLAB, h * 12)
      slab(w / 2 + SLAB, -h * 10, SLAB, h * 12)
      this.topWall = slab(0, -h / 2 - SLAB, w / 2 + SLAB, SLAB)
    }
  }

  /** The top wall lets bodies in from above: it only touches bodies whose centre is inside the frame. */
  private oneSided(contact: Contact): void {
    if (!this.topWall) return
    const [a, b] = [contact.getFixtureA(), contact.getFixtureB()]
    const other = a === this.topWall ? b : b === this.topWall ? a : null
    if (!other) return
    if (other.getBody().getWorldCenter().y * PX < -this.comp.height / 2) contact.setEnabled(false)
  }

  private sceneAt(step: number): SceneNode[] {
    let nodes = this.scenes.get(step)
    if (!nodes) {
      nodes = this.build(this.compMs(step))
      this.scenes.set(step, nodes)
      if (this.scenes.size > 8) this.scenes.delete(this.scenes.keys().next().value as number)
    }
    return nodes
  }

  /** Runs until the state after `step` steps is recorded. */
  private advance(step: number): void {
    if (this.done < 0) {
      this.enter(0)
      this.record(0)
      this.done = 0
    }
    while (this.done < step) {
      const n = this.done
      this.drive(n)
      this.world.step(1 / PHYSICS_HZ, VELOCITY_ITERATIONS, POSITION_ITERATIONS)
      this.leave(n + 1)
      this.enter(n + 1)
      this.record(n + 1)
      this.done = n + 1
    }
  }

  private record(step: number): void {
    for (const [id, live] of this.live) {
      let record = this.records.get(id)
      if (!record) this.records.set(id, (record = { first: step, data: [] }))
      const p = live.body.getPosition()
      record.data.push(p.x * PX, p.y * PX, live.body.getAngle())
    }
  }

  private leave(step: number): void {
    let left = false
    for (const [id, live] of this.live) {
      if (live.plan.exitStep > step) continue
      this.world.destroyBody(live.body)
      this.live.delete(id)
      left = true
    }
    // What rested on a body that left falls now.
    if (left) for (const live of this.live.values()) live.body.setAwake(true)
  }

  private enter(step: number): void {
    const entering = this.plans.filter((p) => p.enterStep === step)
    if (entering.length === 0) return
    const nodes = this.sceneAt(step)
    const silhouetteOf = (layer: Layer) => ('mediaId' in layer ? this.source.media.find((m) => m.id === layer.mediaId)?.silhouette : undefined)
    for (const plan of entering) {
      const node = nodes.find((n) => n.layer.id === plan.layer.id)
      if (!node) continue
      const [rx, ry, rot] = reference(node)
      const t = node.resolved.transform
      const offset: [number, number] = [rx - t.x, ry - t.y]
      const angle = toRad(rot)
      const phys = plan.physics
      const type = phys.type === 'active' ? 'dynamic' : phys.type === 'passive' ? 'static' : 'kinematic'
      const body = this.world.createBody({
        type,
        position: new Vec2(rx / PX, ry / PX),
        angle,
        linearDamping: dampingOf(phys.damping),
        angularDamping: dampingOf(phys.damping),
      })
      const colliders = bodyColliders(node, phys.shape, this.source.measure, silhouetteOf)
      const [cos, sin] = [Math.cos(-angle), Math.sin(-angle)]
      const local = (x: number, y: number) => new Vec2(((x - rx) * cos - (y - ry) * sin) / PX, ((x - rx) * sin + (y - ry) * cos) / PX)
      const fixture = { density: 1, friction: phys.friction, restitution: phys.bounce }
      let made = 0
      for (const c of colliders) {
        try {
          if (c.kind === 'circle') body.createFixture(new Circle(local(c.x, c.y), Math.max(0.005, c.radius / PX)), fixture)
          else body.createFixture(new Polygon(c.points.map(([x, y]) => local(x, y))), fixture)
          made++
        } catch {
          // A piece too small for the engine is left out.
        }
      }
      if (made === 0) body.createFixture(new Circle(new Vec2(0, 0), 0.05), fixture)
      if (type === 'dynamic') {
        const md = { mass: 0, center: new Vec2(0, 0), I: 0 }
        body.getMassData(md)
        const k = md.mass > 0 ? phys.mass / md.mass : 1
        body.setMassData({ mass: phys.mass, center: md.center, I: md.I * k })
        // It keeps the motion its keys had, plus its push.
        const [vx, vy, vr] = this.keyedVelocity(plan.layer, step)
        body.setLinearVelocity(new Vec2((vx + phys.velocity[0]) / PX, (vy + phys.velocity[1]) / PX))
        body.setAngularVelocity(toRad(vr + phys.spin[2]))
      }
      this.live.set(plan.layer.id, { plan, body, offset })
      this.infos.set(plan.layer.id, { id: plan.layer.id, name: plan.layer.name, type: phys.type, colliders, enteredMs: this.compMs(step) })
      for (const joint of plan.layer.joints ?? []) if (joint.enabled) this.pendingJoints.push({ owner: plan.layer, joint })
    }
    this.connect()
  }

  /** Makes the joints whose bodies are both in the simulation. */
  private connect(): void {
    this.pendingJoints = this.pendingJoints.filter(({ owner, joint }) => {
      const a = this.live.get(owner.id)
      if (!a) return true
      const b = joint.target === null ? null : this.live.get(joint.target)
      if (joint.target !== null && !b) return !this.plans.some((p) => p.layer.id === joint.target) ? false : true
      const bodyB = b?.body ?? this.ground
      const own = (layer: Layer, anchor: readonly number[]) => {
        const t = layer.transform
        return new Vec2(((anchor[0] ?? 0) * t.scaleX) / PX, ((anchor[1] ?? 0) * t.scaleY) / PX)
      }
      const localA = own(owner, joint.anchor)
      const worldA = a.body.getWorldPoint(localA)
      const localB =
        joint.targetAnchor === null
          ? bodyB.getLocalPoint(worldA)
          : b
            ? own(b.plan.layer, joint.targetAnchor)
            : new Vec2((joint.targetAnchor[0] ?? 0) / PX, (joint.targetAnchor[1] ?? 0) / PX)
      const length = joint.length !== null ? joint.length / PX : Vec2.distance(worldA, bodyB.getWorldPoint(localB))
      const def = { bodyA: a.body, bodyB, localAnchorA: localA, localAnchorB: localB, collideConnected: false } as unknown as JointDef
      if (joint.type === 'pin') this.world.createJoint(new RevoluteJoint({ ...def, referenceAngle: bodyB.getAngle() - a.body.getAngle() } as never))
      else if (joint.type === 'weld') this.world.createJoint(new WeldJoint({ ...def, referenceAngle: bodyB.getAngle() - a.body.getAngle() } as never))
      else if (joint.type === 'rope') this.world.createJoint(new RopeJoint({ ...def, maxLength: Math.max(0.005, length) } as never))
      else if (joint.stiffness > 0) {
        const k = Math.sqrt(joint.stiffness)
        this.world.createJoint(new DistanceJoint({ ...def, length: Math.max(0.005, length), frequencyHz: k / (2 * Math.PI), dampingRatio: joint.damping / (2 * k) } as never))
      }
      return false
    })
  }

  /** The speed a layer's keys give it at a step: px/s and deg/s of simulated time. */
  private keyedVelocity(layer: Layer, step: number): [number, number, number] {
    const a = resolveLayer(layer, this.compMs(step)).transform
    const b = resolveLayer(layer, this.compMs(step + 1)).transform
    return [(b.x - a.x) * PHYSICS_HZ, (b.y - a.y) * PHYSICS_HZ, (b.rotation - a.rotation) * PHYSICS_HZ]
  }

  /** Moves animated bodies along their keys, pulls following bodies back to theirs, and applies the forces, for step `n`. */
  private drive(n: number): void {
    const dt = 1 / PHYSICS_HZ
    const nextMs = this.compMs(n + 1)
    for (const live of this.live.values()) {
      const { plan, body, offset } = live
      const kinematic = plan.physics.type === 'animated'
      const follow = plan.physics.type === 'active' ? plan.physics.follow : 0
      if (!kinematic && follow <= 0) continue
      const t = resolveLayer(plan.layer, nextMs).transform
      const target = new Vec2((t.x + offset[0]) / PX, (t.y + offset[1]) / PX)
      const targetAngle = toRad(t.rotation)
      const p = body.getPosition()
      if (kinematic) {
        body.setLinearVelocity(new Vec2((target.x - p.x) / dt, (target.y - p.y) / dt))
        body.setAngularVelocity((targetAngle - body.getAngle()) / dt)
        continue
      }
      // A spring and damper toward the keyed pose: 0.2 jiggles, 1 holds firmly.
      const omega = 2 * Math.PI * (1 + 11 * follow)
      const zeta = 0.2 + 0.8 * follow
      const [vx, vy, vr] = this.keyedVelocity(plan.layer, n)
      const v = body.getLinearVelocity()
      const m = body.getMass()
      body.applyForceToCenter(
        new Vec2(m * (omega * omega * (target.x - p.x) + 2 * zeta * omega * (vx / PX - v.x)), m * (omega * omega * (target.y - p.y) + 2 * zeta * omega * (vy / PX - v.y))),
        true,
      )
      const inertia = body.getInertia()
      body.applyTorque(inertia * (omega * omega * (targetAngle - body.getAngle()) + 2 * zeta * omega * (toRad(vr) - body.getAngularVelocity())), true)
    }
    if (this.carriers.length === 0) return
    const nowMs = this.compMs(n)
    const simSeconds = n / PHYSICS_HZ
    const fields: { force: Force; c: [number, number]; angle: number }[] = []
    for (const carrier of this.carriers) {
      if (!isActiveAt(carrier, nowMs)) continue
      const resolved = resolveLayer(carrier, nowMs)
      for (const force of resolved.forces ?? []) fields.push({ force, c: [resolved.transform.x, resolved.transform.y], angle: resolved.transform.rotation })
    }
    if (fields.length === 0) return
    for (const { body } of this.live.values()) {
      if (body.getType() !== 'dynamic') continue
      const centre = body.getWorldCenter()
      const v = body.getLinearVelocity()
      const p: [number, number] = [centre.x * PX, centre.y * PX]
      const vel: [number, number] = [v.x * PX, v.y * PX]
      let [ax, ay] = [0, 0]
      for (const f of fields) {
        const [fx, fy] = forceAcceleration(f.force, f.c, f.angle, p, vel, simSeconds)
        ax += fx
        ay += fy
      }
      if (ax !== 0 || ay !== 0) body.applyForceToCenter(new Vec2((ax * body.getMass()) / PX, (ay * body.getMass()) / PX), true)
    }
  }
}

interface Cached {
  media: readonly MediaAsset[]
  epoch: number
  sim: Simulation | null
}

const cache = new WeakMap<Comp, Cached>()
let measureEpoch = 0

/** Call when fonts finish loading: text bodies are measured again. */
export function physicsMeasuresChanged(): void {
  measureEpoch++
}

/** Whether a comp has anything for physics to move. */
export function hasPhysics(comp: Comp): boolean {
  return !isWorld(comp) && comp.tracks.some((t) => t.groupId === null && t.layers.some((l) => l.physics && l.enabled))
}

/**
 * The comp's simulation (null when it has no bodies, or is a world), kept
 * while the comp, the media list and the fonts stay the same.
 */
export function simulationFor(comp: Comp, source: PhysicsSource, build: BuildScene): Simulation | null {
  if (!hasPhysics(comp)) return null
  const hit = cache.get(comp)
  if (hit && hit.media === source.media && hit.epoch === measureEpoch) return hit.sim
  const sim = new Simulation(comp, source, build)
  cache.set(comp, { media: source.media, epoch: measureEpoch, sim })
  return sim
}
