import { z } from 'zod'

/** A failure the caller can act on. `hint` says what to do instead. */
export class CommandError extends Error {
  readonly hint: string | undefined

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'CommandError'
    this.hint = hint
  }
}

/** Parses with a schema and turns a validation failure into a readable CommandError. */
export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown, what: string): z.output<S> {
  const result = schema.safeParse(data)
  if (!result.success) throw new CommandError(`${what} is not valid:\n${z.prettifyError(result.error)}`)
  return result.data
}
