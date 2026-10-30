import { CommandError } from './errors'

// SVG path data, normalised: every command absolute, and only M, L, C, Q and
// Z (H and V become L, S and T become C and Q, arcs become cubic curves).
// Paths are stored this way, so two keys made from paths with the same
// commands can be blended number by number (a morph).

export type PathCommand =
  | { c: 'M' | 'L'; p: [number, number] }
  | { c: 'C'; p: [number, number, number, number, number, number] }
  | { c: 'Q'; p: [number, number, number, number] }
  | { c: 'Z'; p: [] }

const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }
const TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g

const pathError = (d: string, why: string) =>
  new CommandError(`That is not valid SVG path data: ${why}.`, `Path data looks like "M0 0 L100 0 C 140 0 160 40 160 80 Z". Got: "${d.slice(0, 60)}"`)

/** Parses SVG path data into absolute M, L, C, Q and Z commands. Throws a CommandError on bad data. */
export function parseSvgPath(d: string): PathCommand[] {
  const tokens: (string | number)[] = []
  let consumed = 0
  for (const match of d.matchAll(TOKEN)) {
    const gap = d.slice(consumed, match.index)
    if (/[^\s,]/.test(gap)) throw pathError(d, `"${gap.trim()}" is not a command or a number`)
    tokens.push(match[1] ?? Number(match[2]))
    consumed = (match.index ?? 0) + match[0].length
  }
  if (/[^\s,]/.test(d.slice(consumed))) throw pathError(d, `"${d.slice(consumed).trim()}" is not a command or a number`)
  if (tokens.length === 0) throw pathError(d, 'it is empty')
  if (typeof tokens[0] !== 'string' || tokens[0].toLowerCase() !== 'm') throw pathError(d, 'it must start with M (move to)')

  const out: PathCommand[] = []
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let lastControl: [number, number] | null = null
  let lastKind = ''
  let i = 0
  let command = ''
  while (i < tokens.length) {
    const token = tokens[i]
    if (typeof token === 'string') {
      command = token
      i++
      if (command.toLowerCase() === 'z') {
        out.push({ c: 'Z', p: [] })
        x = startX
        y = startY
        lastControl = null
        lastKind = 'z'
        continue
      }
    } else if (command === '' || command.toLowerCase() === 'z') {
      throw pathError(d, 'a number comes before any command')
    }
    const n = ARGS[command.toLowerCase()] as number
    const args = tokens.slice(i, i + n)
    if (args.length < n || args.some((a) => typeof a !== 'number')) throw pathError(d, `"${command}" needs ${n} numbers`)
    i += n
    const v = args as number[]
    const rel = command === command.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    const kind = command.toLowerCase()
    const at = (k: number): number => v[k] as number
    switch (kind) {
      case 'm': {
        x = ox + at(0)
        y = oy + at(1)
        startX = x
        startY = y
        out.push({ c: 'M', p: [x, y] })
        // Pairs after a move are lines.
        command = rel ? 'l' : 'L'
        lastControl = null
        break
      }
      case 'l':
      case 'h':
      case 'v': {
        x = kind === 'v' ? x : ox + at(0)
        y = kind === 'h' ? y : kind === 'v' ? (rel ? y : 0) + at(0) : oy + at(1)
        out.push({ c: 'L', p: [x, y] })
        lastControl = null
        break
      }
      case 'c':
      case 's': {
        const [c1x, c1y]: [number, number] =
          kind === 's' ? (lastControl && (lastKind === 'c' || lastKind === 's') ? [2 * x - lastControl[0], 2 * y - lastControl[1]] : [x, y]) : [ox + at(0), oy + at(1)]
        const k = kind === 's' ? 0 : 2
        const c2x = ox + at(k)
        const c2y = oy + at(k + 1)
        x = ox + at(k + 2)
        y = oy + at(k + 3)
        out.push({ c: 'C', p: [c1x, c1y, c2x, c2y, x, y] })
        lastControl = [c2x, c2y]
        break
      }
      case 'q':
      case 't': {
        const [qx, qy]: [number, number] =
          kind === 't' ? (lastControl && (lastKind === 'q' || lastKind === 't') ? [2 * x - lastControl[0], 2 * y - lastControl[1]] : [x, y]) : [ox + at(0), oy + at(1)]
        const k = kind === 't' ? 0 : 2
        x = ox + at(k)
        y = oy + at(k + 1)
        out.push({ c: 'Q', p: [qx, qy, x, y] })
        lastControl = [qx, qy]
        break
      }
      case 'a': {
        const ex = ox + at(5)
        const ey = oy + at(6)
        for (const curve of arcToCubics(x, y, at(0), at(1), at(2), at(3) !== 0, at(4) !== 0, ex, ey)) out.push({ c: 'C', p: curve })
        x = ex
        y = ey
        lastControl = null
        break
      }
    }
    lastKind = kind
  }
  return out
}

/** An SVG elliptical arc as cubic curves of at most a quarter turn each. */
function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  angleDeg: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): [number, number, number, number, number, number][] {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]]
  const phi = (angleDeg * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den))
  const cxp = (coef * rx * y1p) / ry
  const cyp = (-coef * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const theta = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  if (sweep && delta < 0) delta += 2 * Math.PI
  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)))
  const step = delta / pieces
  const k = (4 / 3) * Math.tan(step / 4)
  const point = (t: number): [number, number] => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]
  const tangent = (t: number): [number, number] => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos]
  const curves: [number, number, number, number, number, number][] = []
  for (let i = 0; i < pieces; i++) {
    const a = theta + i * step
    const b = a + step
    const [ax, ay] = point(a)
    const [bx, by] = i === pieces - 1 ? [x2, y2] : point(b)
    const [tax, tay] = tangent(a)
    const [tbx, tby] = tangent(b)
    curves.push([ax + k * tax, ay + k * tay, bx - k * tbx, by - k * tby, bx, by])
  }
  return curves
}

const num = (n: number) => String(Math.round(n * 1000) / 1000)

/** Path commands as compact SVG path data. */
export function formatSvgPath(commands: readonly PathCommand[]): string {
  return commands.map((cmd) => (cmd.c === 'Z' ? 'Z' : `${cmd.c}${cmd.p.map(num).join(' ')}`)).join(' ')
}

/** SVG path data in the normalised form paths are stored in. Throws a CommandError on bad data. */
export function normalizeSvgPath(d: string): string {
  return formatSvgPath(parseSvgPath(d))
}

/** A path's pieces as lines of points, curves sampled `steps` times each. */
export function flattenSvgPath(commands: readonly PathCommand[], steps = 16): { points: [number, number][]; closed: boolean }[] {
  const out: { points: [number, number][]; closed: boolean }[] = []
  let current: { points: [number, number][]; closed: boolean } | null = null
  let x = 0
  let y = 0
  for (const cmd of commands) {
    if (cmd.c === 'M') {
      current = { points: [[cmd.p[0], cmd.p[1]]], closed: false }
      out.push(current)
      ;[x, y] = cmd.p
      continue
    }
    if (!current) {
      current = { points: [[x, y]], closed: false }
      out.push(current)
    }
    if (cmd.c === 'Z') {
      current.closed = true
      const first = current.points[0] as [number, number]
      ;[x, y] = first
      current = null
      continue
    }
    if (cmd.c === 'L') current.points.push([cmd.p[0], cmd.p[1]])
    else {
      const [x0, y0] = [x, y]
      for (let s = 1; s <= steps; s++) {
        const t = s / steps
        const u = 1 - t
        if (cmd.c === 'C') {
          const [c1x, c1y, c2x, c2y, ex, ey] = cmd.p
          current.points.push([
            u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex,
            u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey,
          ])
        } else if (cmd.c === 'Q') {
          const [qx, qy, ex, ey] = cmd.p
          current.points.push([u * u * x0 + 2 * u * t * qx + t * t * ex, u * u * y0 + 2 * u * t * qy + t * t * ey])
        }
      }
    }
    const end = cmd.p.slice(-2) as [number, number]
    ;[x, y] = end
  }
  return out.filter((piece) => piece.points.length > 0)
}

/** The box around a path's outline (curves sampled finely). */
export function svgPathBounds(commands: readonly PathCommand[]): { left: number; top: number; width: number; height: number } {
  const points = flattenSvgPath(commands, 32).flatMap((piece) => piece.points)
  if (points.length === 0) return { left: 0, top: 0, width: 0, height: 0 }
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

/**
 * Blends two stored paths with the same commands, number by number (a morph).
 * Returns null when their commands differ, so the caller can hold instead.
 */
export function mixSvgPaths(a: string, b: string, p: number): string | null {
  const skeleton = (d: string) => d.replace(NUMBER, '#')
  if (skeleton(a) !== skeleton(b)) return null
  const bs = b.match(NUMBER) ?? []
  let i = 0
  return a.replace(NUMBER, (n) => {
    const from = Number(n)
    const to = Number(bs[i++] ?? n)
    return num(from + (to - from) * p)
  })
}

/** Whether a string looks like stored path data (it starts with a move). */
export const isSvgPath = (value: string): boolean => /^\s*M/.test(value)
