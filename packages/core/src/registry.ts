import type { Draft } from 'immer'
import { z } from 'zod'
import { FIELD_ALIASES } from './compat'
import { CommandError } from './errors'
import type { IdGenerator } from './ids'
import type { Comp, MediaAsset, Project } from './schema'
import type { ScriptRuns } from './script/runs'

export type CommandResult = { ok: true; value: unknown } | { ok: false; error: string; hint?: string }

/** What a running command can see and do. */
export interface CommandContext {
  /** The current project, including writes made earlier in this transaction. */
  readonly project: Project
  /** Applies a change. The label names the undo step when this is its first write. */
  write(label: string, recipe: (draft: Draft<Project>) => void): void
  /** Runs another command inside the same transaction (used by api.batch). */
  call(name: string, input?: unknown): Promise<CommandResult>
  readonly registry: CommandRegistry
  readonly ids: IdGenerator
  /** Where the user is in the editor, when there is one: commands use it for omitted comp ids and times. */
  readonly view: EditorView
  /** Where layers really are, from an app that can measure them (see `Measure`); absent in plain sessions. */
  readonly measure?: Measure
  /** Traces a picture's outline from its alpha (`MediaAsset.silhouette`), from an app that can read pixels; absent in plain sessions. */
  readonly silhouette?: Silhouette
  /** Reads a voice's loudness from its audio (`MediaAsset.envelope`), from an app that can decode sound; absent in plain sessions. */
  readonly envelope?: Envelope
  /** The session's script runs (live and just finished), which `script.run` reports into; absent in bare contexts. */
  readonly scripts?: ScriptRuns
}

/** Reads a voice's loudness over time: values 0..1, `rate` per second, or undefined when it cannot be read. */
export type Envelope = (media: MediaAsset) => Promise<{ rate: number; values: number[] } | undefined>

/** Reads a picture's silhouette: polygons in fractions of its width and height, or undefined when it cannot be read. */
export type Silhouette = (media: MediaAsset) => Promise<[number, number][][] | undefined>

/** Where a layer really is at a moment, once its groups and layouts apply. */
export interface Placement {
  /** The pivot, comp space. */
  x: number
  y: number
  /** Total rotation and scale, its groups' included. */
  rotation: number
  scaleX: number
  scaleY: number
  /** Total opacity, its groups' included. */
  opacity: number
  /** The axis-aligned box it covers, comp space. */
  bounds: { left: number; top: number; width: number; height: number }
  /** A group's box before its own transform, in its parent's space (a group's pivot sits at a fraction of it); groups only. */
  box?: { left: number; top: number; width: number; height: number }
  /** The size a layout stretched it to (shape width and height, text box width, a nested layout's size). */
  width?: number
  height?: number
}

/**
 * Measures a comp at a comp time: each visible layer's placement by id. The
 * core cannot measure text, so an app with a renderer supplies this; commands
 * that bake a layout or infer one from how members sit need it.
 */
export type Measure = (comp: Comp, timeMs: number) => ReadonlyMap<string, Placement>

/** The editor's playhead (comp time) and the comp it shows; empty without an editor. */
export interface EditorView {
  playheadMs?: number
  compId?: string
  /** The working range of the open comp (playback and export limits), absent when it is off. */
  workRange?: { startMs: number; endMs: number }
}

/** Renames AtomCut's names for fields (`frameId`) to ours (`compId`) when the command has ours and it is not also given. */
export function renameFieldAliases(schema: z.ZodType, input: unknown): unknown {
  if (!(schema instanceof z.ZodObject) || typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const shape = schema.shape as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const [alias, field] of Object.entries(FIELD_ALIASES)) {
    if (!(alias in input) || alias in shape || !(field in shape) || field in input) continue
    out ??= { ...(input as Record<string, unknown>) }
    out[field] = out[alias]
    delete out[alias]
  }
  return out ?? input
}

export interface CommandDef<S extends z.ZodType = z.ZodType, R = unknown> {
  /** Dotted name such as `layer.set`. Tools may also use `layer_set`. */
  name: string
  /** Older names that still run this command (a command that was renamed); they are not listed. */
  aliases?: readonly string[]
  /** One line saying what the command does. */
  summary: string
  /** Longer guidance for agents: conventions, examples, pitfalls. */
  details?: string
  effect: 'read' | 'write'
  input: S
  run(input: z.output<S>, ctx: CommandContext): R | Promise<R>
}

/** Identity helper that keeps a command's input type tied to its schema. */
/** The scalar types a field takes, through optional, default, nullable and union wrappers. */
function scalarTypes(schema: unknown, out = new Set<string>()): Set<string> {
  const def = (schema as { def?: { type?: string; innerType?: unknown; options?: unknown[] } } | undefined)?.def
  if (!def?.type) return out
  if (def.innerType) return scalarTypes(def.innerType, out)
  if (def.type === 'union') for (const option of def.options ?? []) scalarTypes(option, out)
  else out.add(def.type)
  return out
}

/**
 * The input with its top-level "true", "false" and numeric strings turned into
 * the boolean or number its field takes (fields that also take a string keep
 * theirs); the same object when nothing changes.
 */
export function looseScalars(schema: z.ZodType, input: unknown): unknown {
  if (!(schema instanceof z.ZodObject) || typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const shape = schema.shape as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !(key in shape)) continue
    const types = scalarTypes(shape[key])
    if (types.has('string')) continue
    let next: unknown = value
    if (types.has('boolean') && (value === 'true' || value === 'false')) next = value === 'true'
    else if (types.has('number') && /^-?\d+(\.\d+)?$/.test(value.trim())) next = Number(value)
    if (next === value) continue
    out ??= { ...(input as Record<string, unknown>) }
    out[key] = next
  }
  return out ?? input
}

export function defineCommand<S extends z.ZodType, R>(def: CommandDef<S, R>): CommandDef<S, R> {
  return def
}

/** `layer_set` → `layer.set`: tool names cannot contain dots in every client. */
export function normalizeCommandName(name: string): string {
  return name.includes('.') ? name : name.replace('_', '.')
}

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDef>()
  private readonly aliases = new Map<string, CommandDef>()

  register(def: CommandDef): void {
    if (this.commands.has(def.name)) throw new Error(`Command "${def.name}" is already registered`)
    this.commands.set(def.name, def)
    for (const alias of def.aliases ?? []) this.aliases.set(normalizeCommandName(alias), def)
  }

  get(name: string): CommandDef | undefined {
    const normal = normalizeCommandName(name)
    return this.commands.get(name) ?? this.commands.get(normal) ?? this.aliases.get(normal)
  }

  list(): CommandDef[] {
    return [...this.commands.values()]
  }

  /** JSON Schema of a command's input, as callers should send it. */
  inputSchema(name: string): Record<string, unknown> | undefined {
    const def = this.get(name)
    return def ? (z.toJSONSchema(def.input, { io: 'input' }) as Record<string, unknown>) : undefined
  }

  /** Validates the input and runs the command. Never throws; failures come back as results. */
  async run(name: string, input: unknown, ctx: CommandContext): Promise<CommandResult> {
    const def = this.get(name)
    if (!def) return { ok: false, error: `Unknown command "${name}".`, hint: this.suggest(name) }
    let parsed = def.input.safeParse(renameFieldAliases(def.input, input ?? {}))
    // Some models send flags and numbers as strings ("true", "12"): read them as meant, only when that makes the input valid.
    if (!parsed.success) {
      const named = renameFieldAliases(def.input, input ?? {})
      const loose = looseScalars(def.input, named)
      if (loose !== named) {
        const again = def.input.safeParse(loose)
        if (again.success) parsed = again
      }
    }
    if (!parsed.success) {
      return {
        ok: false,
        error: `Invalid input for ${def.name}:\n${z.prettifyError(parsed.error)}`,
        hint: `api.describe {"command": "${def.name}"} shows the input shape.`,
      }
    }
    try {
      const value = await def.run(parsed.data, ctx)
      return { ok: true, value: value ?? null }
    } catch (error) {
      if (error instanceof CommandError) {
        return error.hint ? { ok: false, error: error.message, hint: error.hint } : { ok: false, error: error.message }
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private suggest(name: string): string {
    const wanted = normalizeCommandName(name).split('.')[0] ?? ''
    const close = this.list()
      .map((d) => d.name)
      .filter((n) => n.startsWith(`${wanted}.`) || n.split('.')[0]?.startsWith(wanted.slice(0, 4)))
    return close.length > 0
      ? `Did you mean ${close.slice(0, 6).join(', ')}?`
      : 'api.describe with no arguments lists every command.'
  }
}
