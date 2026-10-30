import { applyPatches, enablePatches, type Patch, produceWithPatches } from 'immer'
import { createCoreRegistry } from './commands'
import { type IdGenerator, randomId } from './ids'
import type { CommandContext, CommandRegistry, CommandResult, EditorView, Envelope, Measure, Silhouette } from './registry'
import type { Project } from './schema'
import { ScriptRuns } from './script/runs'

enablePatches()

interface Transaction {
  label: string
  patches: Patch[]
  /** Inverse patches in the order they must be applied to undo. */
  inverse: Patch[]
  /** Calls made with the same group, one after another, share this undo step (see `CallOptions`). */
  group?: string
}

export interface CallOptions {
  /**
   * Joins this call's changes to the newest undo step when that step has the
   * same group, so a run of calls (an agent's turn) is undone at once. Any
   * other step in between, such as an edit by hand, starts a new one.
   */
  group?: string
  /** Names the undo step when this call starts it. */
  label?: string
}

export interface SessionOptions {
  project: Project
  registry?: CommandRegistry
  ids?: IdGenerator
  /** How many undo steps to keep. */
  historyLimit?: number
  /** Where the user is in the editor (see `EditorView`); read when a command runs. */
  view?: () => EditorView
  /** Measures layers for commands that need real sizes (see `Measure`). */
  measure?: Measure
  /** Traces pictures' silhouettes for physics (see `Silhouette`). */
  silhouette?: Silhouette
  /** Reads voices' loudness for talk and nod (see `Envelope`). */
  envelope?: Envelope
}

export type CallFn = (name: string, input?: unknown) => Promise<CommandResult>

/**
 * An open project and its history. Every change goes through a command. Each
 * top-level call, or each `transact` block, becomes exactly one undo step, and
 * a command that fails leaves no trace. Calls run one at a time, in order.
 */
export class Session {
  readonly registry: CommandRegistry
  readonly ids: IdGenerator
  private state: Project
  private readonly undoStack: Transaction[] = []
  private readonly redoStack: Transaction[] = []
  private readonly historyLimit: number
  private openTransaction: Transaction | null = null
  private readonly listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private changes = 0
  /** Where the user is in the editor; the desktop app sets it once its view state exists. */
  view: () => EditorView
  /** Measures layers; the desktop app sets it from its renderer. */
  measure: Measure | undefined
  /** Traces pictures' silhouettes; the desktop app sets it. */
  silhouette: Silhouette | undefined
  /** Reads voices' loudness; the desktop app sets it. */
  envelope: Envelope | undefined
  /** Script runs, live and just finished; read without waiting for the command queue. */
  readonly scripts = new ScriptRuns()

  constructor(options: SessionOptions) {
    this.state = options.project
    this.registry = options.registry ?? createCoreRegistry()
    this.ids = options.ids ?? randomId
    this.historyLimit = options.historyLimit ?? 200
    this.view = options.view ?? (() => ({}))
    this.measure = options.measure
    this.silhouette = options.silhouette
    this.envelope = options.envelope
  }

  get project(): Project {
    return this.state
  }

  get canUndo(): boolean {
    return this.openTransaction === null && this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.openTransaction === null && this.redoStack.length > 0
  }

  get undoLabel(): string | undefined {
    return this.undoStack.at(-1)?.label
  }

  get redoLabel(): string | undefined {
    return this.redoStack.at(-1)?.label
  }

  /**
   * Counts changes to the project: every write, undo, redo and load moves it
   * on. Comparing it with the value at the last save tells whether there are
   * unsaved changes.
   */
  get revision(): number {
    return this.changes
  }

  /** The group of the newest undo step, if it was made by grouped calls. */
  get undoGroup(): string | undefined {
    return this.undoStack.at(-1)?.group
  }

  /** Calls `listener` after every change to the project or history. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Runs one command as one undo step, or as part of the newest one when `options.group` matches it. */
  call(name: string, input: unknown = {}, options: CallOptions = {}): Promise<CommandResult> {
    return this.enqueue(() => this.inTransaction(options.label ?? '', (ctx) => ctx.call(name, input), options.group))
  }

  /** Runs several commands as one undo step named `label`, for example an agent's whole request. */
  transact<T>(label: string, body: (call: CallFn) => Promise<T>): Promise<T> {
    return this.enqueue(() => this.inTransaction(label, (ctx) => body(ctx.call)))
  }

  undo(): boolean {
    if (this.openTransaction) return false
    const entry = this.undoStack.pop()
    if (!entry) return false
    this.state = applyPatches(this.state, entry.inverse)
    this.redoStack.push(entry)
    this.emit()
    return true
  }

  redo(): boolean {
    if (this.openTransaction) return false
    const entry = this.redoStack.pop()
    if (!entry) return false
    this.state = applyPatches(this.state, entry.patches)
    this.undoStack.push(entry)
    this.emit()
    return true
  }

  /** Replaces the open project, for example after opening a file, and clears the history. */
  load(project: Project): void {
    if (this.openTransaction) throw new Error('Cannot load a project while a transaction is running')
    this.state = project
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.emit()
  }

  /**
   * Like `load`, but waits for the calls and transactions already queued (an
   * agent's call, a drag in progress) to finish first.
   */
  replace(project: Project): Promise<void> {
    return this.enqueue(async () => this.load(project))
  }

  private emit(): void {
    this.changes++
    for (const listener of this.listeners) listener()
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async inTransaction<T>(label: string, body: (ctx: CommandContext) => Promise<T>, group?: string): Promise<T> {
    const tx: Transaction = group === undefined ? { label, patches: [], inverse: [] } : { label, patches: [], inverse: [], group }
    this.openTransaction = tx
    try {
      return await body(this.contextFor(tx))
    } finally {
      this.openTransaction = null
      if (tx.patches.length > 0) {
        if (!tx.label) tx.label = 'Edit'
        const newest = this.undoStack.at(-1)
        if (group !== undefined && newest?.group === group) {
          newest.patches.push(...tx.patches)
          newest.inverse.unshift(...tx.inverse)
        } else {
          this.undoStack.push(tx)
        }
        if (this.undoStack.length > this.historyLimit) this.undoStack.shift()
        this.redoStack.length = 0
        this.emit()
      }
    }
  }

  private contextFor(tx: Transaction): CommandContext {
    const session = this
    const ctx: CommandContext = {
      get project() {
        return session.state
      },
      registry: this.registry,
      ids: this.ids,
      get view() {
        return session.view()
      },
      get measure() {
        return session.measure
      },
      get silhouette() {
        return session.silhouette
      },
      get envelope() {
        return session.envelope
      },
      scripts: this.scripts,
      write(label, recipe) {
        const [next, patches, inverse] = produceWithPatches(session.state, recipe)
        if (patches.length === 0) return
        session.state = next
        if (!tx.label) tx.label = label
        tx.patches.push(...patches)
        tx.inverse.unshift(...inverse)
        session.emit()
      },
      async call(name, input = {}) {
        const before = session.state
        const marks = { patches: tx.patches.length, inverse: tx.inverse.length, label: tx.label }
        const result = await session.registry.run(name, input, ctx)
        if (!result.ok && session.state !== before) {
          // A failed command leaves no trace: restore the state and drop its patches.
          session.state = before
          tx.patches.length = marks.patches
          tx.inverse.splice(0, tx.inverse.length - marks.inverse)
          tx.label = marks.label
          session.emit()
        }
        return result
      },
    }
    return ctx
  }
}
