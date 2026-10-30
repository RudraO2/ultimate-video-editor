/** Makes a new unique id with the given prefix, for example `layer_k3x9q2m1`. */
export type IdGenerator = (prefix: string) => string

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

// Typed locally so the core package needs neither DOM nor Node type definitions.
const webCrypto = (globalThis as unknown as { crypto: { getRandomValues(array: Uint8Array): Uint8Array } }).crypto

/** Short random ids that agents can read and type comfortably. */
export const randomId: IdGenerator = (prefix) => {
  const bytes = webCrypto.getRandomValues(new Uint8Array(8))
  let suffix = ''
  for (const byte of bytes) suffix += ALPHABET[byte % ALPHABET.length]
  return `${prefix}_${suffix}`
}

/** Predictable ids (`layer_1`, `layer_2`, …) for tests and reproducible scripts. */
export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>()
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1
    counters.set(prefix, next)
    return `${prefix}_${next}`
  }
}
