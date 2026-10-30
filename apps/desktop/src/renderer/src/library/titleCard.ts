// Our own demo template: a title card built entirely through the command API, as one undo step.

const fadeUp = (ref: string, fromY: number, toY: number) => [
  { command: 'keyframes.set', input: { id: ref, path: 'y', keys: [{ t: 0, v: fromY, ease: 'ease-out' }, { t: 600, v: toY }] } },
  { command: 'keyframes.set', input: { id: ref, path: 'opacity', keys: [{ t: 0, v: 0, ease: 'ease-out' }, { t: 500, v: 1 }] } },
]

export const TITLE_CARD = [
  {
    command: 'layer.create',
    input: { kind: 'shape', name: 'Background', shape: { width: 1920, height: 1080, fill: '#120f1d' } },
  },
  {
    command: 'layer.create',
    input: {
      kind: 'shape',
      name: 'Glow',
      shape: { type: 'ellipse', width: 900, height: 900, fill: '#7c5cff33' },
      transform: { x: -520, y: -260 },
    },
  },
  {
    command: 'keyframes.set',
    input: { id: '$1.id', path: 'scale', keys: [{ t: 0, v: 0.6, ease: 'ease-out' }, { t: 1400, v: 1 }] },
  },
  {
    command: 'layer.create',
    input: {
      kind: 'shape',
      name: 'Card',
      shape: { width: 1100, height: 520, cornerRadius: 40, fill: '#1d1930', strokeColor: '#7c5cff', strokeWidth: 4 },
    },
  },
  {
    command: 'keyframes.set',
    input: { id: '$3.id', path: 'rotationY', keys: [{ t: 0, v: -70, ease: 'ease-out' }, { t: 1000, v: 0 }] },
  },
  { command: 'keyframes.set', input: { id: '$3.id', path: 'z', keys: [{ t: 0, v: 1200, ease: 'ease-out' }, { t: 1000, v: 0 }] } },
  { command: 'keyframes.set', input: { id: '$3.id', path: 'opacity', keys: [{ t: 0, v: 0, ease: 'ease-out' }, { t: 400, v: 1 }] } },
  {
    command: 'layer.create',
    input: {
      kind: 'text',
      name: 'Title',
      text: 'Ultimate Video Editor',
      startMs: 400,
      style: { fontSize: 96, fontWeight: 800 },
      transform: { y: -40 },
    },
  },
  ...fadeUp('$7.id', 20, -40),
  {
    command: 'layer.create',
    input: {
      kind: 'text',
      name: 'Subtitle',
      text: 'Any agent can drive it',
      startMs: 750,
      style: { fontSize: 44, fontWeight: 500, color: '#b9a8ff' },
      transform: { y: 70 },
    },
  },
  ...fadeUp('$10.id', 110, 70),
]

