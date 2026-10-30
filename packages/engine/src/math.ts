/**
 * A 4×4 matrix in column-major order, as WebGL expects. Comp space is
 * right-handed with +x right, +y down and +z away from the viewer.
 */
export type Mat4 = number[]

/** Builds a matrix from values written row by row, which reads like the maths. */
export function mat4(...rows: number[]): Mat4 {
  const m = new Array<number>(16)
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m[c * 4 + r] = rows[r * 4 + c] ?? 0
  return m
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + r] as number) * (b[c * 4 + k] as number)
      out[c * 4 + r] = sum
    }
  }
  return out
}

/** Multiplies several matrices left to right: compose(A, B, C) = A·B·C. */
export function compose(...matrices: Mat4[]): Mat4 {
  return matrices.reduce((acc, m) => multiply(acc, m))
}

export const translate = (x: number, y: number, z: number): Mat4 =>
  mat4(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1)

export const scale = (x: number, y: number, z: number): Mat4 => mat4(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1)

/** Tilt around the horizontal axis. Positive angles lean the top edge away from the viewer. */
export function rotateX(radians: number): Mat4 {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return mat4(1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1)
}

/** Turn around the vertical axis. Positive angles turn the right edge away from the viewer. */
export function rotateY(radians: number): Mat4 {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return mat4(c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1)
}

/** Rotation in the picture plane. Positive angles turn clockwise on screen. */
export function rotateZ(radians: number): Mat4 {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return mat4(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
}

/** Applies a matrix to a point, returning homogeneous coordinates [x, y, z, w]. */
export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number, number] {
  const at = (i: number) => m[i] as number
  return [
    at(0) * x + at(4) * y + at(8) * z + at(12),
    at(1) * x + at(5) * y + at(9) * z + at(13),
    at(2) * x + at(6) * y + at(10) * z + at(14),
    at(3) * x + at(7) * y + at(11) * z + at(15),
  ]
}

export const degToRad = (degrees: number): number => (degrees * Math.PI) / 180
