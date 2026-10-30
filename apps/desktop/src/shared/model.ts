// Files a glTF refers to besides itself. Plain TypeScript only: no Node or DOM
// APIs, so the main process and tests share it.

/** A uri with a scheme (data:, http:, file:, or a drive letter such as C:) is not a path beside the file. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/**
 * The files a glTF's JSON refers to by relative path (`buffers[].uri` and
 * `images[].uri`): decoded, with `/` separators, and without `.` steps. A
 * `data:` uri, a uri with a scheme, an absolute path and a path that climbs out
 * of the glTF's folder are left out. Duplicates are listed once.
 */
export function gltfReferences(json: unknown): string[] {
  if (typeof json !== 'object' || json === null) return []
  const found = new Set<string>()
  for (const key of ['buffers', 'images'] as const) {
    const list = (json as Record<string, unknown>)[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const uri = typeof item === 'object' && item !== null ? (item as { uri?: unknown }).uri : undefined
      const path = typeof uri === 'string' ? relativeReference(uri) : null
      if (path) found.add(path)
    }
  }
  return [...found]
}

function relativeReference(uri: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(uri)
  } catch {
    return null
  }
  if (decoded === '' || SCHEME.test(decoded) || /^[/\\]/.test(decoded)) return null
  const steps: string[] = []
  for (const part of decoded.split(/[/\\]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (steps.length === 0) return null
      steps.pop()
    } else steps.push(part)
  }
  return steps.length > 0 ? steps.join('/') : null
}
