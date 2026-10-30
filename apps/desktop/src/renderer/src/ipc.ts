const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Runs a main-process request. When it fails, the error keeps only the main
 * process's own message, without Electron's "Error invoking remote method"
 * prefix, so it can be shown to the user or an agent as it is.
 */
export async function hostRequest<T>(request: Promise<T>): Promise<T> {
  try {
    return await request
  } catch (error) {
    throw new Error(messageOf(error).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''))
  }
}
