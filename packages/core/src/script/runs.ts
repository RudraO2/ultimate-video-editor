import { randomId } from '../ids'
import type { ScriptError, ScriptLog, ScriptOutcome } from './runtime'

export type ScriptRunStatus = 'running' | ScriptOutcome['status']

export interface ScriptRunRecord {
  id: string
  /** The saved script's path, or absent for code run once. */
  file?: string
  status: ScriptRunStatus
  startedAt: number
  /** How long it ran (so far, while running). */
  ms: number
  calls: number
  /** The command it is waiting on right now. */
  awaiting?: string
  logs: (ScriptLog & { n: number })[]
  /** Lines over the cap that were not kept. */
  dropped: number
  error?: ScriptError
}

/** A run in progress, as `script.run` drives it. */
export interface ScriptRunHandle {
  readonly record: ScriptRunRecord
  stopRequested(): boolean
  readonly stopSignal: Promise<void>
  log(line: ScriptLog): void
  awaiting(name: string | undefined): void
  end(outcome: ScriptOutcome): void
}

const KEEP_RUNS = 20
const KEEP_LOGS = 1000

/**
 * The script runs of a session, live and just finished: what `script_runs`,
 * `script_logs` and `script_stop` read, and what the Scripts panel shows. It
 * holds no document state, so reading it never waits for a running script.
 */
export class ScriptRuns {
  private readonly runs: ScriptRunRecord[] = []
  private readonly stops = new Map<string, () => void>()
  private readonly listeners = new Set<() => void>()

  begin(file?: string): ScriptRunHandle {
    const record: ScriptRunRecord = {
      id: randomId('run'),
      ...(file ? { file } : {}),
      status: 'running',
      startedAt: Date.now(),
      ms: 0,
      calls: 0,
      logs: [],
      dropped: 0,
    }
    this.runs.push(record)
    if (this.runs.length > KEEP_RUNS) this.runs.splice(0, this.runs.length - KEEP_RUNS)
    let stopped = false
    let fire!: () => void
    const stopSignal = new Promise<void>((resolve) => (fire = resolve))
    this.stops.set(record.id, () => {
      stopped = true
      fire()
    })
    this.emit()
    let n = 0
    return {
      record,
      stopRequested: () => stopped,
      stopSignal,
      log: (line) => {
        n++
        if (record.logs.length >= KEEP_LOGS) {
          record.logs.shift()
          record.dropped++
        }
        record.logs.push({ ...line, n })
        this.emit()
      },
      awaiting: (name) => {
        if (name) {
          record.awaiting = name
          record.calls++
        } else {
          delete record.awaiting
        }
        record.ms = Date.now() - record.startedAt
        this.emit()
      },
      end: (outcome) => {
        record.status = outcome.status
        record.calls = outcome.calls
        record.ms = Date.now() - record.startedAt
        delete record.awaiting
        if (outcome.status !== 'ok') record.error = outcome.error
        this.stops.delete(record.id)
        this.emit()
      },
    }
  }

  /** Newest last. */
  list(): readonly ScriptRunRecord[] {
    return this.runs
  }

  get(id: string): ScriptRunRecord | undefined {
    return this.runs.find((r) => r.id === id)
  }

  /** The run in progress, if any. */
  get active(): ScriptRunRecord | undefined {
    return this.runs.find((r) => r.status === 'running')
  }

  /** Lines after `since` (a line number from `next`), or the newest `tail` lines. */
  logs(id: string, since?: number, tail = 20): { lines: (ScriptLog & { n: number })[]; next: number; status: ScriptRunStatus } | undefined {
    const run = this.get(id)
    if (!run) return undefined
    const after = since === undefined ? run.logs : run.logs.filter((l) => l.n > since)
    const lines = after.slice(-tail)
    return { lines, next: run.logs.at(-1)?.n ?? since ?? 0, status: run.status }
  }

  /** Asks a running script to stop; false when no such run is going. */
  stop(id: string): boolean {
    const stop = this.stops.get(id)
    if (!stop) return false
    stop()
    return true
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
