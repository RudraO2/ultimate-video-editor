// comp 1920x1080 7000ms
// The website's demo scene (website/assets/shots and website/assets/video), built through the editor's
// own commands. Paste into the Scripts tab, or send as script_run {code} over MCP, in an empty comp;
// then frame_update {durationMs: 7000} and export at 2/3 scale for the hero video. One run, one undo step.
const U = Math.min(here.width, here.height) / 100
const LEFT = -here.width / 2 + 12 * U
const ACCENT = '#FF6B4A', CORAL = '#F5AB90', INK = '#FCF8F1', MUTED = '#BFAFA8'
const TITLE_SIZE = 14 * U

const ground = await ac.layer.create({
  kind: 'shape', name: 'Ground', shape: { type: 'rect', width: here.width, height: here.height },
  fill: { type: 'linear', stops: [{ offset: 0, color: '#2A0F10' }, { offset: 1, color: '#070506' }], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
})
const glow = await ac.layer.create({
  kind: 'shape', name: 'Glow', shape: { type: 'ellipse', width: 95 * U, height: 95 * U },
  x: here.width * 0.2, y: -here.height * 0.1,
  fill: { type: 'radial', stops: [{ offset: 0, color: '#CE3024B0' }, { offset: 1, color: '#CE302400' }], start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 0.5 } },
})
await ac.keyframes.set({ id: glow.id, property: 'opacity', keys: [{ t: 0, v: 0, ease: 'ease-out' }, { t: 1400, v: 1 }] })
await ac.keyframes.set({ id: glow.id, property: 'scale', keys: [{ t: 0, v: 0.8, ease: 'ease-out' }, { t: 1800, v: 1 }] })
const warm = await ac.layer.create({
  kind: 'shape', name: 'Warm light', shape: { type: 'ellipse', width: 70 * U, height: 70 * U },
  x: here.width * 0.36, y: here.height * 0.3,
  fill: { type: 'radial', stops: [{ offset: 0, color: '#F5AB9055' }, { offset: 1, color: '#F5AB9000' }], start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 0.5 } },
})
await ac.keyframes.set({ id: warm.id, property: 'x', keys: [{ t: 0, v: here.width * 0.3, ease: 'ease-in-out' }, { t: 6000, v: here.width * 0.4 }] })

const line = (name, text, y, style, extra = {}) =>
  ac.layer.create({ kind: 'text', name, text, x: LEFT, y: y * U, transform: { anchorX: 0 }, style: { align: 'left', ...style }, ...extra })

const kicker = await line('Kicker', 'Ultimate Video Editor', -17, { fontSize: 2.6 * U, fontWeight: 700, letterSpacing: 0.18 * 2.6 * U, textCase: 'upper', color: CORAL })
const title = await line('Title', 'From words to motion', -4, { fontSize: TITLE_SIZE, fontWeight: 800, letterSpacing: -0.03 * TITLE_SIZE, color: INK })
const subtitle = await line('Subtitle', 'Say it. Watch it get edited. Finish it by hand.', 9.5, { fontSize: 3.6 * U, fontWeight: 400, color: MUTED })
await ac.text.style({ id: title.id, match: 'motion', style: { color: ACCENT } })

const rule = await ac.layer.create({
  kind: 'shape', name: 'Rule', shape: { type: 'rect', width: 14 * U, height: 0.8 * U, cornerRadius: 0.4 * U },
  fill: ACCENT, x: LEFT, y: 16 * U, transform: { anchorX: 0 },
})
await ac.keyframes.set({ id: rule.id, property: 'opacity', keys: [{ t: 0, v: 0, ease: 'hold' }, { t: 900, v: 1 }] })
await ac.keyframes.set({ id: rule.id, property: 'width', keys: [{ t: 900, v: 1, ease: 'ease-out-expo' }, { t: 1700, v: 14 * U }] })

const sparks = []
for (const [i, s] of [[0.30, -0.30, 1.6], [0.40, 0.18, 1.1], [0.22, 0.32, 0.8]].entries()) {
  const dot = await ac.layer.create({
    kind: 'shape', name: 'Spark ' + (i + 1), shape: { type: 'ellipse', width: s[2] * U, height: s[2] * U },
    x: here.width * s[0], y: here.height * s[1], fill: i === 1 ? ACCENT : CORAL,
  })
  await ac.keyframes.set({ id: dot.id, property: 'y', keys: [{ t: 0, v: here.height * s[1] + 6 * U, ease: 'ease-out' }, { t: 2400, v: here.height * s[1] }, { t: 6000, v: here.height * s[1] - 4 * U }] })
  await ac.keyframes.set({ id: dot.id, property: 'opacity', keys: [{ t: 0, v: 0, ease: 'ease-out' }, { t: 1200 + i * 200, v: 1 }] })
  sparks.push(dot.id)
}

const pill = await ac.layer.create({
  kind: 'shape', name: 'Caption pill', shape: { type: 'rect', width: 64 * U, height: 7.6 * U, cornerRadius: 3.8 * U },
  fill: '#120A0BD9', y: 37 * U, startMs: 2600, durationMs: 3400,
})
const caption = await ac.layer.create({
  kind: 'text', name: 'Caption', text: 'इसे साफ़ करो, कैप्शन लगाओ', y: 37 * U, startMs: 2600, durationMs: 3400,
  style: { fontSize: 3.4 * U, fontWeight: 600, color: INK, align: 'center' },
})
await ac.animation.set({ id: pill.id, slot: 'in', preset: 'fade-up', target: 'layer', durationMs: 400 })
await ac.animation.set({ id: caption.id, slot: 'in', preset: 'fade-up', unit: 'word', staggerMs: 90, durationMs: 380 })

await ac.animation.set({ id: kicker.id, slot: 'in', preset: 'fade-up', unit: 'letter', staggerMs: 28, durationMs: 420 })
await ac.animation.set({ id: title.id, slot: 'in', preset: 'unblur-up', unit: 'word', staggerMs: 140, delayMs: 250, durationMs: 700 })
await ac.animation.set({ id: subtitle.id, slot: 'in', preset: 'fade-up', unit: 'line', delayMs: 1100, durationMs: 600 })

const built = { kicker: kicker.id, title: title.id, subtitle: subtitle.id, rule: rule.id, s1: sparks[0], s2: sparks[1], s3: sparks[2] }

// The title stack goes into a 3D world in place (same pixels), then the camera swings right (recipe 11).
const MOVE = 3000, FLY = 2600
const ids = built
const moved = await ac.world.move_into({ ids: Object.values(ids), name: 'Title 3D' })
const world = moved.frameId
const { cameraId } = await ac.world.camera({ compId: world, fromDefault: true })
const aim = await ac.world.add({ compId: world, kind: 'controller', name: 'Aim', position: [0, 0, 0] })
await ac.world.track({ id: cameraId, lookAt: aim.id })
const pose = (await ac.layer.get({ id: cameraId })).layer.transform
const fly = (property, to) =>
  ac.keyframes.set({ id: cameraId, property, keys: [{ t: MOVE, v: pose[property], ease: 'ease-in-out' }, { t: MOVE + FLY, v: to }] })
await fly('y', pose.y * 0.9)
await fly('x', 40 * U)
await fly('z', 9 * U)
const depth = (id, to) => ac.keyframes.set({ id, property: 'y', keys: [{ t: MOVE, v: 0, ease: 'ease-in-out' }, { t: MOVE + FLY, v: to }] })
await depth(ids.kicker, -14 * U)
await depth(ids.subtitle, 16 * U)
await depth(ids.rule, 22 * U)
await depth(ids.s1, -30 * U)
await depth(ids.s2, 26 * U)
await depth(ids.s3, -20 * U)
return { world, nested: moved.nestedId, camera: cameraId, pose }
