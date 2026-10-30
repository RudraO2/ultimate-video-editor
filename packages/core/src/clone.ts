// Typed locally so the core package needs neither DOM nor Node type definitions.
const nativeClone = (globalThis as unknown as { structuredClone<T>(value: T): T }).structuredClone

/** A deep, unfrozen copy of plain document data. */
export function deepClone<T>(value: T): T {
  return nativeClone(value)
}
