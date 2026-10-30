// Exact Euclidean distance fields over pixels (Felzenszwalb and Huttenlocher's
// separable transform): how far each pixel is from the nearest pixel of a set.

const INF = 1e20

/** Felzenszwalb's 1D squared distance transform of `f` (n values, stride `step` from `start`), in place. */
function distance1d(f: Float32Array, start: number, step: number, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    const fq = f[start + q * step] as number
    let s: number
    for (;;) {
      const p = v[k] as number
      s = (fq + q * q - ((f[start + p * step] as number) + p * p)) / (2 * q - 2 * p)
      if (s > (z[k] as number) || k === 0) break
      k--
    }
    if (s <= (z[k] as number) && k === 0) {
      v[0] = q
      z[0] = -INF
      z[1] = INF
      continue
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while ((z[k + 1] as number) < q) k++
    const p = v[k] as number
    d[q] = (q - p) * (q - p) + (f[start + p * step] as number)
  }
  for (let q = 0; q < n; q++) f[start + q * step] = d[q] as number
}

/** Euclidean distance from each pixel to the nearest pixel where `isFeature`, in px. */
export function distanceField(width: number, height: number, isFeature: (i: number) => boolean): Float32Array {
  const f = new Float32Array(width * height)
  for (let i = 0; i < f.length; i++) f[i] = isFeature(i) ? 0 : INF
  const n = Math.max(width, height)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  for (let x = 0; x < width; x++) distance1d(f, x, width, height, d, v, z)
  for (let y = 0; y < height; y++) distance1d(f, y * width, 1, width, d, v, z)
  for (let i = 0; i < f.length; i++) f[i] = Math.sqrt(f[i] as number)
  return f
}
