import { z } from 'zod'
import { CommandError } from '../errors'
import { type CommandResult, defineCommand, normalizeCommandName } from '../registry'

// "$0" is the whole result of call 0; "$1.id" or "$2.tracks[0].id" reach inside it.
const REFERENCE = /^\$(\d+)((?:\.[A-Za-z_$][\w$-]*|\[\d+\])*)$/

/** Replaces `$N.path` strings anywhere in an input with values from earlier results. */
function resolveReferences(value: unknown, results: readonly unknown[]): unknown {
  if (typeof value === 'string') {
    const match = REFERENCE.exec(value)
    if (!match) return value
    const index = Number(match[1])
    if (index >= results.length) throw new CommandError(`${value} refers to call ${index}, which has not run yet.`)
    let node = results[index]
    for (const part of match[2]?.match(/[A-Za-z_$][\w$-]*|\d+/g) ?? []) {
      node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
    }
    if (node === undefined) throw new CommandError(`${value} does not point at anything in the result of call ${index}.`)
    return node
  }
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, results))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReferences(item, results)]))
  }
  return value
}

export const apiBatch = defineCommand({
  name: 'api.batch',
  summary: 'Run several commands in one call, in order. Later inputs can use earlier results, e.g. "$0.id".',
  details:
    'Use one batch for one idea in several steps: a card and its text, staggered keys across layers. The batch stops at the first failure unless continueOnError is true. Batches do not nest.',
  effect: 'write',
  input: z.strictObject({
    calls: z
      .array(z.strictObject({ command: z.string().min(1), input: z.record(z.string(), z.unknown()).default({}) }))
      .min(1)
      .max(50),
    continueOnError: z.boolean().default(false),
  }),
  async run({ calls, continueOnError }, ctx) {
    const values: unknown[] = []
    const results: CommandResult[] = []
    for (const [index, call] of calls.entries()) {
      let result: CommandResult
      if (normalizeCommandName(call.command) === 'api.batch') {
        result = { ok: false, error: 'Batches do not nest.' }
      } else {
        try {
          result = await ctx.call(call.command, resolveReferences(call.input, values))
        } catch (error) {
          const hint = error instanceof CommandError ? error.hint : undefined
          const message = error instanceof Error ? error.message : String(error)
          result = hint ? { ok: false, error: message, hint } : { ok: false, error: message }
        }
      }
      values.push(result.ok ? result.value : null)
      results.push(result)
      if (!result.ok && !continueOnError) return { results, stoppedAt: index, skipped: calls.length - index - 1 }
    }
    return { results }
  },
})
