import { CommandError } from './errors'
import { formatSvgPath, type PathCommand, parseSvgPath, svgPathBounds } from './svgPath'

// Reads SVG markup into drawable shapes: the outline of every path, rect,
// circle, ellipse, line, polyline and polygon in the picture's own space, with
// its transform applied and its fill and stroke worked out (colours, gradients,
// opacity, line ends, dashes). It is what places an icon or any SVG as vector
// layers. Pure text in, plain data out: no DOM, so it runs anywhere the core
// does. What it cannot draw (masks, clip paths, filters, text, images) is left
// out and listed.

/** A 2D affine transform [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = readonly [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
]

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** How much a transform scales lengths (the square root of its area factor). */
const scaleOf = (m: Matrix): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1

// ---- XML ----------------------------------------------------------------

interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Parses markup into a tree. Lenient: comments, processing instructions, doctypes and CDATA are read past; a tag left open is closed at the end. */
function parseXml(markup: string): XmlNode | null {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g
  const attribute = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  let at = 0
  for (const match of markup.matchAll(tag)) {
    const top = stack[stack.length - 1] as XmlNode
    top.text += decode(markup.slice(at, match.index))
    at = (match.index ?? 0) + match[0].length
    if (match[1] !== undefined) top.text += match[1]
    else if (match[2] !== undefined) {
      // A closing tag closes the nearest open one of that name.
      const name = match[2].toLowerCase()
      for (let i = stack.length - 1; i > 0; i--) {
        if ((stack[i] as XmlNode).name === name) {
          stack.length = i
          break
        }
      }
    } else if (match[3] !== undefined) {
      const attrs: Record<string, string> = {}
      for (const a of (match[4] ?? '').matchAll(attribute)) attrs[(a[1] as string).toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '')
      const node: XmlNode = { name: match[3].toLowerCase().replace(/^[a-z0-9]+:/, ''), attrs, children: [], text: '' }
      top.children.push(node)
      if (match[5] !== '/') stack.push(node)
    }
  }
  return root.children.find((n) => n.name === 'svg') ?? root.children[0] ?? null
}

// ---- Colours ------------------------------------------------------------

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff',
  teal: '#008080', navy: '#000080', fuchsia: '#ff00ff', magenta: '#ff00ff', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', coral: '#ff7f50',
  crimson: '#dc143c', indigo: '#4b0082', violet: '#ee82ee', tomato: '#ff6347', salmon: '#fa8072', khaki: '#f0e68c', turquoise: '#40e0d0',
  lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', dimgray: '#696969', darkred: '#8b0000', darkgreen: '#006400',
  darkblue: '#00008b', lightblue: '#add8e6', lightgreen: '#90ee90', skyblue: '#87ceeb', steelblue: '#4682b4', orangered: '#ff4500', whitesmoke: '#f5f5f5',
}

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')

/** A CSS colour as #rrggbb and an alpha (0 to 1); null when it is not one this reader knows. */
export function parseSvgColor(value: string): { color: string; alpha: number } | null {
  const v = value.trim().toLowerCase()
  if (v === 'transparent') return { color: '#000000', alpha: 0 }
  if (v in NAMED) return { color: NAMED[v] as string, alpha: 1 }
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)
  if (hex) {
    const h = hex[1] as string
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => Number.parseInt(c + c, 16))
      return { color: '#' + hex2(r as number) + hex2(g as number) + hex2(b as number), alpha: a === undefined ? 1 : a / 255 }
    }
    if (h.length === 6 || h.length === 8) return { color: '#' + h.slice(0, 6), alpha: h.length === 8 ? Number.parseInt(h.slice(6), 16) / 255 : 1 }
    return null
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v)
  if (fn) {
    const parts = (fn[2] as string).split(/[\s,/]+/).filter(Boolean)
    const number = (s: string | undefined, scale: number) => (s === undefined ? Number.NaN : s.endsWith('%') ? (Number.parseFloat(s) / 100) * scale : Number.parseFloat(s))
    const alpha = parts[3] === undefined ? 1 : Math.min(1, Math.max(0, number(parts[3], 1)))
    if ((fn[1] as string).startsWith('rgb')) {
      const [r, g, b] = [number(parts[0], 255), number(parts[1], 255), number(parts[2], 255)]
      return [r, g, b].every(Number.isFinite) ? { color: '#' + hex2(r) + hex2(g) + hex2(b), alpha } : null
    }
    const h = (((Number.parseFloat(parts[0] ?? '0') % 360) + 360) % 360) / 360
    const s = number(parts[1], 1)
    const l = number(parts[2], 1)
    if (![h, s, l].every(Number.isFinite)) return null
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    const channel = (t: number) => {
      const u = (t + 1) % 1
      return 255 * (u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p)
    }
    return { color: '#' + hex2(channel(h + 1 / 3)) + hex2(channel(h)) + hex2(channel(h - 1 / 3)), alpha }
  }
  return null
}

// ---- Transforms ---------------------------------------------------------

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi

/** The matrix of a transform attribute: matrix, translate, scale, rotate, skewX and skewY in order. */
export function parseTransform(value: string | undefined): Matrix {
  if (!value) return IDENTITY
  let m: Matrix = IDENTITY
  for (const call of value.matchAll(/([a-z]+)\s*\(([^)]*)\)/gi)) {
    const n = (call[2] as string).match(NUMBER)?.map(Number) ?? []
    const rad = (deg: number) => (deg * Math.PI) / 180
    let t: Matrix | null = null
    switch ((call[1] as string).toLowerCase()) {
      case 'matrix':
        if (n.length === 6) t = n as unknown as Matrix
        break
      case 'translate':
        t = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0]
        break
      case 'scale':
        t = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]
        break
      case 'rotate': {
        const [a = 0, cx = 0, cy = 0] = n
        const [c, s] = [Math.cos(rad(a)), Math.sin(rad(a))]
        t = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]
        break
      }
      case 'skewx':
        t = [1, 0, Math.tan(rad(n[0] ?? 0)), 1, 0, 0]
        break
      case 'skewy':
        t = [1, Math.tan(rad(n[0] ?? 0)), 0, 1, 0, 0]
        break
    }
    if (t) m = multiply(m, t)
  }
  return m
}

function transformPath(commands: readonly PathCommand[], m: Matrix): PathCommand[] {
  const point = (x: number, y: number) => apply(m, x, y)
  return commands.map((cmd): PathCommand => {
    if (cmd.c === 'Z') return cmd
    if (cmd.c === 'C') return { c: 'C', p: [...point(cmd.p[0], cmd.p[1]), ...point(cmd.p[2], cmd.p[3]), ...point(cmd.p[4], cmd.p[5])] }
    if (cmd.c === 'Q') return { c: 'Q', p: [...point(cmd.p[0], cmd.p[1]), ...point(cmd.p[2], cmd.p[3])] }
    return { c: cmd.c, p: point(cmd.p[0], cmd.p[1]) }
  })
}

// ---- Shapes to outlines -------------------------------------------------

const KAPPA = 0.5522847498307936

const num = (v: string | undefined, fallback = 0): number => {
  const parsed = v === undefined ? Number.NaN : Number.parseFloat(v)
  return Number.isFinite(parsed) ? parsed : fallback
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  const [kx, ky] = [rx * KAPPA, ry * KAPPA]
  return (
    'M' + (cx + rx) + ' ' + cy +
    ' C' + (cx + rx) + ' ' + (cy + ky) + ' ' + (cx + kx) + ' ' + (cy + ry) + ' ' + cx + ' ' + (cy + ry) +
    ' C' + (cx - kx) + ' ' + (cy + ry) + ' ' + (cx - rx) + ' ' + (cy + ky) + ' ' + (cx - rx) + ' ' + cy +
    ' C' + (cx - rx) + ' ' + (cy - ky) + ' ' + (cx - kx) + ' ' + (cy - ry) + ' ' + cx + ' ' + (cy - ry) +
    ' C' + (cx + kx) + ' ' + (cy - ry) + ' ' + (cx + rx) + ' ' + (cy - ky) + ' ' + (cx + rx) + ' ' + cy + ' Z'
  )
}

function rectPath(x: number, y: number, w: number, h: number, rxIn: number | undefined, ryIn: number | undefined): string {
  let rx = rxIn ?? ryIn ?? 0
  let ry = ryIn ?? rxIn ?? 0
  rx = Math.min(Math.max(0, rx), w / 2)
  ry = Math.min(Math.max(0, ry), h / 2)
  if (rx === 0 || ry === 0) return 'M' + x + ' ' + y + ' L' + (x + w) + ' ' + y + ' L' + (x + w) + ' ' + (y + h) + ' L' + x + ' ' + (y + h) + ' Z'
  const [kx, ky] = [rx * KAPPA, ry * KAPPA]
  return (
    'M' + (x + rx) + ' ' + y + ' L' + (x + w - rx) + ' ' + y +
    ' C' + (x + w - rx + kx) + ' ' + y + ' ' + (x + w) + ' ' + (y + ry - ky) + ' ' + (x + w) + ' ' + (y + ry) +
    ' L' + (x + w) + ' ' + (y + h - ry) +
    ' C' + (x + w) + ' ' + (y + h - ry + ky) + ' ' + (x + w - rx + kx) + ' ' + (y + h) + ' ' + (x + w - rx) + ' ' + (y + h) +
    ' L' + (x + rx) + ' ' + (y + h) +
    ' C' + (x + rx - kx) + ' ' + (y + h) + ' ' + x + ' ' + (y + h - ry + ky) + ' ' + x + ' ' + (y + h - ry) +
    ' L' + x + ' ' + (y + ry) +
    ' C' + x + ' ' + (y + ry - ky) + ' ' + (x + rx - kx) + ' ' + y + ' ' + (x + rx) + ' ' + y + ' Z'
  )
}

/** The outline of a drawable element as path data in its own space, or null when it has none (or none worth drawing). */
function outlineOf(node: XmlNode): string | null {
  const a = node.attrs
  switch (node.name) {
    case 'path':
      return a.d && a.d.trim() !== '' ? a.d : null
    case 'rect': {
      const [w, h] = [num(a.width), num(a.height)]
      return w > 0 && h > 0 ? rectPath(num(a.x), num(a.y), w, h, a.rx === undefined ? undefined : num(a.rx), a.ry === undefined ? undefined : num(a.ry)) : null
    }
    case 'circle':
      return num(a.r) > 0 ? ellipsePath(num(a.cx), num(a.cy), num(a.r), num(a.r)) : null
    case 'ellipse':
      return num(a.rx) > 0 && num(a.ry) > 0 ? ellipsePath(num(a.cx), num(a.cy), num(a.rx), num(a.ry)) : null
    case 'line':
      return 'M' + num(a.x1) + ' ' + num(a.y1) + ' L' + num(a.x2) + ' ' + num(a.y2)
    case 'polyline':
    case 'polygon': {
      const n = (a.points ?? '').match(NUMBER)?.map(Number) ?? []
      if (n.length < 4) return null
      let d = 'M' + n[0] + ' ' + n[1]
      for (let i = 2; i + 1 < n.length; i += 2) d += ' L' + n[i] + ' ' + n[i + 1]
      return node.name === 'polygon' ? d + ' Z' : d
    }
    default:
      return null
  }
}

// ---- Styles -------------------------------------------------------------

/** What a shape is drawn with: all inherited down the tree except opacity, which multiplies. */
interface Style {
  fill: string
  fillOpacity: number
  fillRule: 'nonzero' | 'evenodd'
  stroke: string
  strokeOpacity: number
  strokeWidth: number
  cap: 'butt' | 'round' | 'square'
  join: 'miter' | 'round' | 'bevel'
  dash: number[]
  dashOffset: number
  /** The colour `currentColor` stands for. */
  color: string
}

const PRESENTATION = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'color', 'opacity', 'display', 'visibility']

/** The declarations of a style="…" attribute. */
function styleDeclarations(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (style ?? '').split(';')) {
    const colon = part.indexOf(':')
    if (colon > 0) out[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).replace(/!important/i, '').trim()
  }
  return out
}

/** An element's presentation attributes, with its style="…" declarations on top. */
function declarations(node: XmlNode): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of PRESENTATION) if (node.attrs[key] !== undefined) out[key] = node.attrs[key].trim()
  return { ...out, ...styleDeclarations(node.attrs.style) }
}

function inherit(parent: Style, d: Record<string, string>): Style {
  const style: Style = { ...parent }
  if (d.color !== undefined && d.color !== 'inherit') style.color = d.color
  if (d.fill !== undefined && d.fill !== 'inherit') style.fill = d.fill
  if (d['fill-opacity'] !== undefined) style.fillOpacity = Math.min(1, Math.max(0, num(d['fill-opacity'], 1)))
  if (d['fill-rule'] !== undefined) style.fillRule = d['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero'
  if (d.stroke !== undefined && d.stroke !== 'inherit') style.stroke = d.stroke
  if (d['stroke-opacity'] !== undefined) style.strokeOpacity = Math.min(1, Math.max(0, num(d['stroke-opacity'], 1)))
  if (d['stroke-width'] !== undefined) style.strokeWidth = Math.max(0, num(d['stroke-width'], 1))
  if (d['stroke-linecap'] !== undefined) style.cap = d['stroke-linecap'] === 'round' || d['stroke-linecap'] === 'square' ? d['stroke-linecap'] : 'butt'
  if (d['stroke-linejoin'] !== undefined) style.join = d['stroke-linejoin'] === 'round' || d['stroke-linejoin'] === 'bevel' ? d['stroke-linejoin'] : 'miter'
  if (d['stroke-dasharray'] !== undefined) {
    const dash = d['stroke-dasharray'] === 'none' ? [] : (d['stroke-dasharray'].match(NUMBER)?.map(Number) ?? [])
    style.dash = dash.some((n) => n < 0) || dash.every((n) => n === 0) ? [] : dash.length % 2 === 1 ? [...dash, ...dash] : dash
  }
  if (d['stroke-dashoffset'] !== undefined) style.dashOffset = num(d['stroke-dashoffset'])
  return style
}

// ---- Gradients ----------------------------------------------------------

/** A paint ready for a layer: a colour, or a gradient whose ends are in the picture's space. */
export type SvgPaint =
  | { type: 'solid'; color: string; opacity: number }
  | {
      type: 'linear' | 'radial'
      stops: { offset: number; color: string }[]
      /** Linear: where offset 0 lies; radial: the centre. */
      start: [number, number]
      /** Linear: where offset 1 lies; radial: a point on the outer circle. */
      end: [number, number]
      opacity: number
    }

export interface SvgStroke {
  paint: SvgPaint
  width: number
  cap: 'butt' | 'round' | 'square'
  join: 'miter' | 'round' | 'bevel'
  dash: number[]
  dashOffset: number
}

/** One drawable outline with how it is painted, in the picture's own coordinates. */
export interface SvgShape {
  /** Absolute path data, transforms applied. */
  d: string
  fill: SvgPaint | null
  stroke: SvgStroke | null
  fillRule: 'nonzero' | 'evenodd'
  /** The element's opacity (and its groups'), for the whole layer. */
  opacity: number
  /** Names of the enclosing `<g>` elements, outermost first: inkscape:label, else data-name, else id. Groups without a name are left out. */
  groups: string[]
  /** One number per entry of `groups`, telling apart two groups of the same name (and one group seen twice through `use`). */
  groupKeys: number[]
  /** The element's own id. */
  id?: string
}

export interface ParsedSvg {
  /** The picture's box: from its viewBox, else its width and height, else the outlines' own box. */
  viewBox: { x: number; y: number; width: number; height: number }
  shapes: SvgShape[]
  /** Kinds of content that were left out: clip-path, mask, filter, text, image, use of something missing. */
  skipped: string[]
}

export interface SvgOptions {
  /** What currentColor stands for when the SVG does not set `color`. Default black. */
  color?: string
}

interface GradientDef {
  node: XmlNode
  stops: { offset: number; color: string }[]
}

const percent = (v: string | undefined, fallback: number): number => {
  if (v === undefined) return fallback
  const n = Number.parseFloat(v)
  if (!Number.isFinite(n)) return fallback
  return v.trim().endsWith('%') ? n / 100 : n
}

function collectGradients(root: XmlNode): Map<string, GradientDef> {
  const gradients = new Map<string, GradientDef>()
  const walk = (node: XmlNode) => {
    if ((node.name === 'lineargradient' || node.name === 'radialgradient') && node.attrs.id) {
      const stops: { offset: number; color: string }[] = []
      for (const stop of node.children) {
        if (stop.name !== 'stop') continue
        const css = styleDeclarations(stop.attrs.style)
        const parsed = parseSvgColor(css['stop-color'] ?? stop.attrs['stop-color'] ?? '#000000') ?? { color: '#000000', alpha: 1 }
        const alpha = parsed.alpha * Math.min(1, Math.max(0, num(css['stop-opacity'] ?? stop.attrs['stop-opacity'], 1)))
        stops.push({ offset: Math.min(1, Math.max(0, percent(stop.attrs.offset, 0))), color: alpha >= 0.999 ? parsed.color : parsed.color + hex2(alpha * 255) })
      }
      gradients.set(node.attrs.id, { node, stops })
    }
    for (const child of node.children) walk(child)
  }
  walk(root)
  return gradients
}

/** A gradient's stops, following href chains to the gradient that has them. */
function stopsOf(gradients: Map<string, GradientDef>, def: GradientDef, depth = 0): { offset: number; color: string }[] {
  if (def.stops.length > 0 || depth > 8) return def.stops
  const href = (def.node.attrs.href ?? '').replace(/^#/, '')
  const parent = gradients.get(href)
  return parent ? stopsOf(gradients, parent, depth + 1) : []
}

/** An attribute of a gradient, or of the gradient it points at. */
function inheritedAttribute(gradients: Map<string, GradientDef>, def: GradientDef, name: string, depth = 0): string | undefined {
  if (def.node.attrs[name] !== undefined) return def.node.attrs[name]
  const parent = gradients.get((def.node.attrs.href ?? '').replace(/^#/, ''))
  return parent && depth < 8 ? inheritedAttribute(gradients, parent, name, depth + 1) : undefined
}

// ---- The reader ---------------------------------------------------------

const IGNORED = new Set(['defs', 'title', 'desc', 'metadata', 'style', 'script', 'lineargradient', 'radialgradient', 'clippath', 'mask', 'pattern', 'symbol', 'marker', 'filter', 'namedview', 'foreignobject'])
const SKIPPED_ELEMENTS = new Set(['text', 'image', 'foreignobject'])

/** Reads SVG markup. Throws a CommandError when it holds no SVG. */
export function parseSvg(markup: string, options: SvgOptions = {}): ParsedSvg {
  const root = parseXml(markup)
  if (!root || (root.name !== 'svg' && root.children.length === 0 && outlineOf(root) === null)) {
    throw new CommandError('That is not SVG markup.', 'Pass the text of an SVG: <svg viewBox="0 0 24 24"><path d="…"/></svg>, or just its elements.')
  }
  const gradients = collectGradients(root)
  const byId = new Map<string, XmlNode>()
  const index = (node: XmlNode) => {
    if (node.attrs.id) byId.set(node.attrs.id, node)
    for (const child of node.children) index(child)
  }
  index(root)

  const skipped = new Set<string>()
  const shapes: SvgShape[] = []
  const baseStyle: Style = {
    fill: '#000000',
    fillOpacity: 1,
    fillRule: 'nonzero',
    stroke: 'none',
    strokeOpacity: 1,
    strokeWidth: 1,
    cap: 'butt',
    join: 'miter',
    dash: [],
    dashOffset: 0,
    color: options.color ?? '#000000',
  }

  /** A paint value as a paint, in the space of the shape's final path; null for none. */
  const paintOf = (value: string, style: Style, opacity: number, bounds: { left: number; top: number; width: number; height: number }, matrix: Matrix): SvgPaint | null => {
    const v = value.trim()
    if (v === '' || v === 'none') return null
    const ref = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/i.exec(v)
    if (ref) {
      const def = gradients.get(ref[1] as string)
      const stops = def ? stopsOf(gradients, def) : []
      if (def && stops.length > 0) {
        const radial = def.node.name === 'radialgradient'
        const units = inheritedAttribute(gradients, def, 'gradientunits')
        const own = parseTransform(inheritedAttribute(gradients, def, 'gradienttransform'))
        const bbox = units !== 'userSpaceOnUse'
        // Gradient space to the picture's space: the gradient's own transform, then (for bounding-box units) the box, or (for user units) the element's transform.
        const toPicture: Matrix = bbox ? multiply([bounds.width || 1, 0, 0, bounds.height || 1, bounds.left, bounds.top], own) : multiply(matrix, own)
        const coordinate = (name: string, fallback: number) => {
          const raw = inheritedAttribute(gradients, def, name)
          return bbox ? percent(raw, fallback) : raw === undefined ? fallback : raw.trim().endsWith('%') ? percent(raw, fallback) * (name.includes('y') || name === 'cy' ? bounds.height : bounds.width) + (name.includes('y') || name === 'cy' ? bounds.top : bounds.left) : num(raw, fallback)
        }
        const [x1, y1, x2, y2, cx, cy, r] = radial
          ? [0, 0, 0, 0, coordinate('cx', bbox ? 0.5 : bounds.left + bounds.width / 2), coordinate('cy', bbox ? 0.5 : bounds.top + bounds.height / 2), coordinate('r', bbox ? 0.5 : Math.max(bounds.width, bounds.height) / 2)]
          : [coordinate('x1', bbox ? 0 : bounds.left), coordinate('y1', bbox ? 0 : bounds.top), coordinate('x2', bbox ? 1 : bounds.left + bounds.width), coordinate('y2', bbox ? 0 : bounds.top), 0, 0, 0]
        const start = radial ? apply(toPicture, cx, cy) : apply(toPicture, x1, y1)
        const end = radial ? apply(toPicture, cx + r, cy) : apply(toPicture, x2, y2)
        return { type: radial ? 'radial' : 'linear', stops, start, end, opacity }
      }
      // A gradient that is missing: the fallback colour after the reference, else none.
      return paintOf(ref[2] ?? '', style, opacity, bounds, matrix)
    }
    const colour = v.toLowerCase() === 'currentcolor' ? parseSvgColor(style.color) : parseSvgColor(v)
    if (!colour) return null
    return { type: 'solid', color: colour.color, opacity: opacity * colour.alpha }
  }

  let groupCount = 0
  const visit = (node: XmlNode, parent: Style, matrix: Matrix, opacity: number, depth: number, groups: readonly string[] = [], groupKeys: readonly number[] = []) => {
    if (depth > 40) return
    const d = declarations(node)
    if (d.display === 'none' || d.visibility === 'hidden') return
    const style = inherit(parent, d)
    const here = multiply(matrix, parseTransform(node.attrs.transform))
    const alpha = opacity * Math.min(1, Math.max(0, num(d.opacity, 1)))
    if (node.attrs['clip-path'] && node.attrs['clip-path'] !== 'none') skipped.add('clip-path')
    if (node.attrs.mask && node.attrs.mask !== 'none') skipped.add('mask')
    if (node.attrs.filter && node.attrs.filter !== 'none') skipped.add('filter')
    if (SKIPPED_ELEMENTS.has(node.name)) {
      skipped.add(node.name)
      return
    }
    if (node.name === 'use') {
      const target = byId.get((node.attrs.href ?? '').replace(/^#/, ''))
      if (!target) skipped.add('use')
      else visit(target, style, multiply(here, [1, 0, 0, 1, num(node.attrs.x), num(node.attrs.y)]), alpha, depth + 1, groups, groupKeys)
      return
    }
    if (node.name === 'g' || node.name === 'svg' || node.name === 'a' || node.name === 'switch' || node.name === '#root') {
      const label = node.name === 'g' ? (node.attrs['inkscape:label'] || node.attrs['data-name'] || node.attrs.id || '').trim() : ''
      const inside = label === '' ? groups : [...groups, label]
      const insideKeys = label === '' ? groupKeys : [...groupKeys, groupCount++]
      for (const child of node.children) {
        if (!IGNORED.has(child.name)) visit(child, style, here, alpha, depth + 1, inside, insideKeys)
        else if (child.name === 'clippath' || child.name === 'mask' || child.name === 'filter') skipped.add(child.name)
      }
      return
    }
    const outline = outlineOf(node)
    if (outline === null) return
    let commands: PathCommand[]
    try {
      commands = transformPath(parseSvgPath(outline), here)
    } catch {
      skipped.add('a path that could not be read')
      return
    }
    const bounds = svgPathBounds(commands)
    // A line has no inside to fill, whatever fill says.
    const filled = node.name === 'line' ? null : paintOf(style.fill, style, style.fillOpacity, bounds, here)
    const strokePaint = style.strokeWidth > 0 ? paintOf(style.stroke, style, style.strokeOpacity, bounds, here) : null
    if (!filled && !strokePaint) return
    const k = scaleOf(here)
    shapes.push({
      d: formatSvgPath(commands),
      fill: filled,
      stroke: strokePaint ? { paint: strokePaint, width: style.strokeWidth * k, cap: style.cap, join: style.join, dash: style.dash.map((n) => n * k), dashOffset: style.dashOffset * k } : null,
      fillRule: style.fillRule,
      opacity: alpha,
      groups: [...groups],
      groupKeys: [...groupKeys],
      ...(node.attrs.id ? { id: node.attrs.id } : {}),
    })
  }

  visit(root, baseStyle, IDENTITY, 1, 0)

  const vb = (root.attrs.viewbox ?? '').match(NUMBER)?.map(Number)
  let viewBox: ParsedSvg['viewBox']
  if (vb && vb.length === 4 && (vb[2] as number) > 0 && (vb[3] as number) > 0) viewBox = { x: vb[0] as number, y: vb[1] as number, width: vb[2] as number, height: vb[3] as number }
  else if (num(root.attrs.width) > 0 && num(root.attrs.height) > 0) viewBox = { x: 0, y: 0, width: num(root.attrs.width), height: num(root.attrs.height) }
  else {
    const all = shapes.length > 0 ? svgPathBounds(shapes.flatMap((s) => parseSvgPath(s.d))) : { left: 0, top: 0, width: 24, height: 24 }
    viewBox = { x: all.left, y: all.top, width: Math.max(1, all.width), height: Math.max(1, all.height) }
  }
  return { viewBox, shapes, skipped: [...skipped] }
}
