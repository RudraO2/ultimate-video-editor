import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import type { Comp, Layer } from './schema'
import { Session } from './session'
import { parseSvg, parseSvgColor, parseTransform } from './svgImport'
import { parseSvgPath, svgPathBounds } from './svgPath'

const bounds = (d: string) => {
  const b = svgPathBounds(parseSvgPath(d))
  return [b.left, b.top, b.left + b.width, b.top + b.height].map((n) => Math.round(n * 100) / 100)
}

describe('SVG colours and transforms', () => {
  it('reads hex, rgb, hsl and named colours with their alpha', () => {
    expect(parseSvgColor('#fff')).toEqual({ color: '#ffffff', alpha: 1 })
    expect(parseSvgColor('#11223380')).toEqual({ color: '#112233', alpha: 128 / 255 })
    expect(parseSvgColor('rgb(255, 0, 0)')).toEqual({ color: '#ff0000', alpha: 1 })
    expect(parseSvgColor('rgba(0 128 255 / 50%)')).toEqual({ color: '#0080ff', alpha: 0.5 })
    expect(parseSvgColor('hsl(120, 100%, 50%)')).toEqual({ color: '#00ff00', alpha: 1 })
    expect(parseSvgColor('Tomato')?.color).toBe('#ff6347')
    expect(parseSvgColor('transparent')?.alpha).toBe(0)
    expect(parseSvgColor('not a colour')).toBeNull()
  })

  it('composes matrix, translate, scale, rotate and skew in order', () => {
    expect(parseTransform('translate(10 20) scale(2)')).toEqual([2, 0, 0, 2, 10, 20])
    expect(parseTransform('matrix(1 0 0 1 5 6)')).toEqual([1, 0, 0, 1, 5, 6])
    const [a, b, c, d, e, f] = parseTransform('rotate(90 10 10)')
    expect([a, b, c, d].map((n) => Math.round(n))).toEqual([0, 1, -1, 0])
    expect(e).toBeCloseTo(20)
    expect(f).toBeCloseTo(0)
    expect(parseTransform(undefined)).toEqual([1, 0, 0, 1, 0, 0])
    expect(parseTransform('skewX(45)')[2]).toBeCloseTo(1)
  })
})

describe('reading an SVG', () => {
  it('reads a line icon: strokes in currentColor, round ends, no fill', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></g></svg>'
    const parsed = parseSvg(svg, { color: '#ff00ff' })
    expect(parsed.viewBox).toEqual({ x: 0, y: 0, width: 24, height: 24 })
    expect(parsed.shapes).toHaveLength(2)
    for (const shape of parsed.shapes) {
      expect(shape.fill).toBeNull()
      expect(shape.stroke).toMatchObject({ paint: { type: 'solid', color: '#ff00ff', opacity: 1 }, width: 2, cap: 'round', join: 'round' })
    }
  })

  it('reads a solid icon: one filled path in the given colour, evenodd when asked', () => {
    const parsed = parseSvg('<svg viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="M0 0h16v16H0zM4 4v8h8V4z"/></svg>', { color: '#123456' })
    expect(parsed.shapes[0]).toMatchObject({ fill: { type: 'solid', color: '#123456' }, stroke: null, fillRule: 'evenodd' })
  })

  it('draws rectangles, circles, ellipses, lines, polylines and polygons', () => {
    const svg =
      '<svg viewBox="0 0 100 100"><rect x="10" y="20" width="30" height="40" rx="5"/><circle cx="50" cy="50" r="10"/><ellipse cx="70" cy="30" rx="20" ry="5"/><line x1="0" y1="0" x2="10" y2="10" stroke="red"/><polyline points="0,0 10,0 10,10" fill="none" stroke="blue"/><polygon points="0,0 10,0 5,8"/></svg>'
    const shapes = parseSvg(svg).shapes
    expect(shapes).toHaveLength(6)
    expect(bounds(shapes[0]?.d ?? '')).toEqual([10, 20, 40, 60])
    expect(bounds(shapes[1]?.d ?? '')).toEqual([40, 40, 60, 60])
    expect(bounds(shapes[2]?.d ?? '')).toEqual([50, 25, 90, 35])
    // A line has no inside: only its stroke.
    expect(shapes[3]).toMatchObject({ fill: null, stroke: { paint: { color: '#ff0000' } } })
    expect(shapes[4]).toMatchObject({ fill: null, stroke: { paint: { color: '#0000ff' } } })
    expect(shapes[5]?.d.endsWith('Z')).toBe(true)
  })

  it('applies transforms to outlines and scales line widths with them', () => {
    const parsed = parseSvg('<svg viewBox="0 0 100 100"><g transform="translate(10 20) scale(2)"><rect width="5" height="5" fill="none" stroke="#000" stroke-width="1"/></g></svg>')
    const shape = parsed.shapes[0]
    expect(bounds(shape?.d ?? '')).toEqual([10, 20, 20, 30])
    expect(shape?.stroke?.width).toBeCloseTo(2)
  })

  it('works out colours: inheritance, the style attribute, opacity and display', () => {
    const svg =
      '<svg viewBox="0 0 10 10" fill="#ff0000" opacity="0.5"><g fill-opacity="0.5"><rect width="1" height="1"/><rect width="1" height="1" style="fill: rgb(0, 0, 255); opacity: 0.5"/></g><rect width="1" height="1" display="none"/><rect width="1" height="1" fill="none"/></svg>'
    const shapes = parseSvg(svg).shapes
    expect(shapes).toHaveLength(2)
    expect(shapes[0]).toMatchObject({ fill: { color: '#ff0000', opacity: 0.5 }, opacity: 0.5 })
    expect(shapes[1]).toMatchObject({ fill: { color: '#0000ff', opacity: 0.5 }, opacity: 0.25 })
  })

  it('turns gradients into paints with their ends in the picture space', () => {
    const svg =
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="a"><stop offset="0" stop-color="#f00"/><stop offset="100%" style="stop-color:#00f;stop-opacity:0.5"/></linearGradient>' +
      '<linearGradient id="b" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>' +
      '<radialGradient id="c" href="#a" cx="0.5" cy="0.5" r="0.5"/></defs>' +
      '<rect x="20" y="20" width="40" height="40" fill="url(#a)"/><rect width="50" height="50" fill="url(#b)"/><circle cx="50" cy="50" r="10" fill="url(#c)"/></svg>'
    const [a, b, c] = parseSvg(svg).shapes
    expect(a?.fill).toMatchObject({ type: 'linear', start: [20, 20], end: [60, 20], stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff80' }] })
    expect(b?.fill).toMatchObject({ type: 'linear', start: [0, 0], end: [100, 0] })
    // A radial gradient takes its stops from the gradient it points at; its radius 0.5 of the circle's 20 px box reaches the box's right edge.
    expect(c?.fill).toMatchObject({ type: 'radial', start: [50, 50], end: [60, 50] })
    expect((c?.fill as { stops: unknown[] }).stops).toHaveLength(2)
  })

  it('follows use to something defined once, and lists what it cannot draw', () => {
    const svg =
      '<svg viewBox="0 0 10 10"><defs><path id="dot" d="M0 0h2v2H0z"/></defs><use href="#dot" x="5" y="5" fill="red"/><use href="#missing"/><text>hi</text><rect width="2" height="2" clip-path="url(#c)" mask="url(#m)" filter="url(#f)"/></svg>'
    const parsed = parseSvg(svg)
    expect(parsed.shapes).toHaveLength(2)
    expect(bounds(parsed.shapes[0]?.d ?? '')).toEqual([5, 5, 7, 7])
    expect(parsed.skipped.sort()).toEqual(['clip-path', 'filter', 'mask', 'text', 'use'])
  })

  it('takes the picture box from the viewBox, else width and height, else the outlines', () => {
    expect(parseSvg('<svg width="48" height="24"><rect width="10" height="10"/></svg>').viewBox).toEqual({ x: 0, y: 0, width: 48, height: 24 })
    expect(parseSvg('<path d="M10 10h20v40z"/>').viewBox).toEqual({ x: 10, y: 10, width: 20, height: 40 })
  })

  it('reads past comments, doctypes, entities and namespaced tags', () => {
    const svg = '<?xml version="1.0"?><!DOCTYPE svg><!-- hi --><svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><svg:path d="M0 0h4v4z" fill="#f00"/></svg:svg>'
    expect(parseSvg(svg).shapes).toHaveLength(1)
  })

  it('refuses text that is not an SVG', () => {
    expect(() => parseSvg('hello')).toThrow(/not SVG/)
    expect(() => parseSvg('')).toThrow(/not SVG/)
  })
})

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(name + ' failed: ' + result.error)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(name + ' should have failed')
    return result.error + '\n' + (result.hint ?? '')
  }
  const layer = (id: string) => (session.project.comps[0] as Comp).tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Extract<Layer, { kind: 'path' }>
  return { session, ok, fail, layer }
}

const HOUSE =
  '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M15 21v-8H9v8"/><path d="M3 10l9-8 9 8v11H3z"/></g></svg>'

describe('svg.place', () => {
  it('places a picture centred on x, y at the size asked, joining outlines painted alike into one layer', async () => {
    const { session, ok, layer } = setup()
    const result = await ok('svg.place', { svg: HOUSE, name: 'House', x: 100, y: -50, size: 240, color: '#ffcc00' })
    expect(result).toMatchObject({ layers: 1, groupId: null, size: 240 })
    const l = layer(result.ids[0])
    expect(l.name).toBe('House')
    // 24 units become 240 px: the whole picture spans 3..21 by 2..21, scaled by 10.
    const b = svgPathBounds(parseSvgPath(l.geometry))
    expect(b.width).toBeCloseTo(180, 0)
    expect(l.transform.x).toBeCloseTo(100 + (b.left + b.width / 2), 5)
    expect(l.fills).toHaveLength(0)
    expect(l.strokes).toHaveLength(1)
    expect(l.strokes[0]).toMatchObject({ width: 20, cap: 'round', join: 'round', paint: { type: 'solid', color: '#ffcc00' } })
    session.undo()
    expect((session.project.comps[0] as Comp).tracks).toHaveLength(0)
  })

  it('keeps layers apart when painted differently, and groups them', async () => {
    const { session, ok, layer } = setup()
    const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#111111"/><circle cx="5" cy="5" r="3" fill="#ff0000"/></svg>'
    const result = await ok('svg.place', { svg, name: 'Badge', size: 100 })
    expect(result.layers).toBe(2)
    expect(result.groupId).toBeTruthy()
    expect(layer(result.ids[0]).name).toBe('Badge 1')
    expect(layer(result.ids[1]).fills[0]).toMatchObject({ type: 'solid', color: '#ff0000' })
    const group = (session.project.comps[0] as Comp).tracks.flatMap((t) => t.layers).find((l) => l.id === result.groupId)
    expect(group?.kind).toBe('group')
    expect(group?.name).toBe('Badge')
    const apart = await ok('svg.place', { svg: '<svg viewBox="0 0 4 4"><rect width="1" height="1"/><rect x="2" width="1" height="1"/></svg>', merge: false })
    expect(apart.layers).toBe(2)
  })

  it('maps gradient ends to the box of the layer', async () => {
    const { ok, layer } = setup()
    const svg = '<svg viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect x="20" y="20" width="60" height="60" fill="url(#g)"/></svg>'
    const { ids } = await ok('svg.place', { svg, size: 100 })
    expect(layer(ids[0]).fills[0]).toMatchObject({ type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } })
  })

  it('overrides the line width, scales dashes and keeps the opacity of a shape', async () => {
    const { ok, layer } = setup()
    const svg = '<svg viewBox="0 0 24 24"><path d="M2 12h20" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="3 1" opacity="0.4"/></svg>'
    const { ids } = await ok('svg.place', { svg, size: 48, strokeWidth: 1 })
    expect(layer(ids[0]).strokes[0]).toMatchObject({ width: 2, dash: [6, 2] })
    expect(layer(ids[0]).transform.opacity).toBe(0.4)
  })

  it('gives each path of a picture a draw-on, or the whole thing another entrance, and remembers where it came from', async () => {
    const { session, ok, layer } = setup()
    const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#111"/><circle cx="5" cy="5" r="3" fill="#f00"/></svg>'
    const origin = { kind: 'icon', id: 'demo:badge', license: 'MIT', author: 'Someone' }
    const drawn = await ok('svg.place', { svg, animIn: 'draw', origin })
    for (const id of drawn.ids) {
      expect(layer(id).animIn?.preset).toBe('draw')
      expect(layer(id).origin).toEqual(origin)
    }
    const faded = await ok('svg.place', { svg, animIn: 'fade-up', animOut: 'fade' })
    const group = (session.project.comps[0] as Comp).tracks.flatMap((t) => t.layers).find((l) => l.id === faded.groupId)
    expect(group?.animIn?.preset).toBe('fade-up')
    expect(group?.animOut?.preset).toBe('fade')
  })

  it('refuses markup with nothing to draw, a bad preset, and says what it left out', async () => {
    const { ok, fail } = setup()
    expect(await fail('svg.place', { svg: 'hello' })).toContain('not SVG')
    expect(await fail('svg.place', { svg: '<svg viewBox="0 0 4 4"><text>x</text></svg>' })).toContain('left out: text')
    expect(await fail('svg.place', { svg: HOUSE, animIn: 'nope' })).toContain('No animation preset')
    const partial = await ok('svg.place', { svg: '<svg viewBox="0 0 4 4"><rect width="2" height="2" mask="url(#m)"/></svg>' })
    expect(partial.skipped).toEqual(['mask'])
  })
})

describe('groups and ids', () => {
  it('tells each shape its named groups, outermost first, and its own id', () => {
    const svg =
      '<svg viewBox="0 0 10 10"><g id="outer"><g><g id="inner" fill="#f00"><path id="a" d="M0 0h2v2z"/></g></g><g data-name="Named"><rect width="2" height="2" fill="#0f0"/></g><g inkscape:label="Label" id="g99"><circle cx="5" cy="5" r="1" fill="#00f"/></g></g><path d="M0 0h1v1z"/></svg>'
    const [a, b, c, d] = parseSvg(svg).shapes
    expect(a).toMatchObject({ groups: ['outer', 'inner'], id: 'a' })
    expect(b?.groups).toEqual(['outer', 'Named'])
    expect(b?.id).toBeUndefined()
    expect(c?.groups).toEqual(['outer', 'Label'])
    expect(d?.groups).toEqual([])
    // Two groups of one name are still two groups.
    const twins = parseSvg('<svg viewBox="0 0 4 4"><g id="t"><rect width="1" height="1"/></g><g id="t"><rect width="1" height="1"/></g></svg>').shapes
    expect(twins[0]?.groupKeys).not.toEqual(twins[1]?.groupKeys)
  })
})
