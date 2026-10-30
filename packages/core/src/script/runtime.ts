import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from 'quickjs-emscripten-core'
import type { CommandResult } from '../registry'

// Typed locally so the core package needs neither DOM nor Node type definitions.
const timers = globalThis as unknown as {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

/** The comp a script runs in: every call without a comp id lands there. Frozen for the whole run. */
export interface ScriptHere {
  frameId: string
  name: string
  width: number
  height: number
  fps: number
  durationMs: number
  mode: string
}

export interface ScriptLog {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
  /** The script's line that logged it, when known. */
  line?: number
}

export interface ScriptError {
  name: string
  message: string
  hint?: string
  /** The command whose failure stopped the run. */
  command?: string
  /** The script's line, 1-based. */
  line?: number
}

export type ScriptOutcome =
  | { status: 'ok'; value: unknown; calls: number }
  | { status: 'error' | 'timeout' | 'stopped'; error: ScriptError; calls: number }

export interface ScriptRunOptions {
  code: string
  /** Every command the script may call, by dotted name, with its one-line summary. */
  commands: readonly { name: string; summary: string }[]
  /** Runs one command. Calls arrive one at a time, in order. */
  call(name: string, input: unknown): Promise<CommandResult>
  /** Answers `ac.help(id)`. */
  help(id: string): unknown
  here: ScriptHere | null
  /** The run stops itself past this many milliseconds. */
  timeoutMs: number
  /** Seeds `Math.random`, so a script's randomness is the same on every run. */
  seed: number
  /** True once someone asked the run to stop. */
  stopRequested(): boolean
  /** Resolves when someone asks the run to stop (the run then stops at once, even mid-wait). */
  stopSignal?: Promise<void>
  onLog?(log: ScriptLog): void
  /** Called as a command starts (its name) and ends (undefined). */
  onCall?(name: string | undefined): void
  /** Refuse calls past this many. */
  maxCalls?: number
  /** Memory the script may hold, in bytes. */
  memoryBytes?: number
}

const MAX_LOG_CHARS = 2000
const MAX_VALUE_CHARS = 200_000
const FILE = 'script.js'
const YIELD_EVERY_MS = 12

let modulePromise: Promise<QuickJSWASMModule> | null = null

/** Loads QuickJS (WebAssembly embedded in a module) once, on the first run. */
function quickjs(): Promise<QuickJSWASMModule> {
  modulePromise ??= (async () => {
    const [{ newQuickJSWASMModuleFromVariant }, variant] = await Promise.all([
      import('quickjs-emscripten-core'),
      import('@jitl/quickjs-singlefile-mjs-release-sync'),
    ])
    return newQuickJSWASMModuleFromVariant(variant.default)
  })()
  return modulePromise
}

/**
 * Builds the guest's world from the host bridge, then removes the bridge: the
 * script sees `ac`, `here`, `console` and plain JavaScript, nothing else.
 * Calls capture their origin stack before they wait, so a failure names the
 * script line that made the call.
 */
const PRELUDE = String.raw`(function (host, commands, seed) {
  const g = globalThis;
  const lineOf = (stack) => {
    const m = /script\.js:(\d+)/.exec(String(stack || ''));
    return m ? Number(m[1]) - 1 : undefined;
  };
  const show = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.name + ': ' + v.message;
    if (v === undefined) return 'undefined';
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  };
  const call = (name, input) => {
    const origin = new Error().stack;
    let json;
    try { json = JSON.stringify(input === undefined ? {} : input); } catch (e) {
      return Promise.reject(new TypeError(name + ': the input is not plain data'));
    }
    return host.call(name, json === undefined ? '{}' : json).then((text) => {
      const r = JSON.parse(text);
      if (r.ok) return r.value;
      const err = new Error(name + ': ' + r.error);
      err.name = r.kind === 'refused' ? 'ScriptError' : 'CommandError';
      if (r.hint) err.hint = r.hint;
      err.command = name;
      err.line = lineOf(origin);
      throw err;
    });
  };
  const ac = {};
  for (const name of commands) {
    const parts = name.split('.');
    let node = ac;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = (input) => call(name, input);
  }
  ac.call = (name, input) => call(String(name), input);
  ac.help = (id) => call('$help', { id: id === undefined ? '' : String(id) });
  const consoleObj = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    consoleObj[level] = (...args) => host.log(level, args.map(show).join(' '), lineOf(new Error().stack) || 0);
  }
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const RealDate = g.Date;
  function FrozenDate(...args) {
    if (!new.target) return new RealDate(0).toString();
    return args.length ? new RealDate(...args) : new RealDate(0);
  }
  FrozenDate.now = () => 0;
  FrozenDate.UTC = RealDate.UTC;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.prototype = RealDate.prototype;
  g.Date = FrozenDate;
  const finish = (main) => main.then(
    (value) => {
      let text;
      try { text = JSON.stringify(value === undefined ? null : value); } catch (e) { text = JSON.stringify(show(value)); }
      host.done(text === undefined ? 'null' : text);
    },
    (e) => {
      const err = e && typeof e === 'object' ? e : { name: 'Error', message: String(e) };
      host.fail(JSON.stringify({
        name: String(err.name || 'Error'),
        message: String(err.message === undefined ? e : err.message),
        hint: err.hint === undefined ? undefined : String(err.hint),
        command: err.command === undefined ? undefined : String(err.command),
        line: typeof err.line === 'number' ? err.line : lineOf(err.stack),
      }));
    },
  );
  return { ac, console: consoleObj, finish };
})`

/**
 * Runs a script in a fresh QuickJS sandbox. The script is the body of an
 * async function over `ac`, `here` and `console`; it can reach the editor only
 * through `ac` (one command at a time, through `call`), and nothing else: no
 * files, network, timers or processes. It stops itself past `timeoutMs`, when
 * asked to stop, when it runs out of memory, or after `maxCalls` calls.
 */
export async function runScript(options: ScriptRunOptions): Promise<ScriptOutcome> {
  const QuickJS = await quickjs()
  const deadline = Date.now() + options.timeoutMs
  const maxCalls = options.maxCalls ?? 10_000
  let calls = 0
  let settled = false
  let outcome: ScriptOutcome | null = null
  let resolveOutcome!: (o: ScriptOutcome) => void
  const finished = new Promise<ScriptOutcome>((resolve) => (resolveOutcome = resolve))
  const settle = (o: ScriptOutcome) => {
    if (settled) return
    settled = true
    outcome = o
    resolveOutcome(o)
  }

  const runtime: QuickJSRuntime = QuickJS.newRuntime()
  runtime.setMemoryLimit(options.memoryBytes ?? 64 * 1024 * 1024)
  runtime.setMaxStackSize(1024 * 1024)
  runtime.setInterruptHandler(() => settled || options.stopRequested() || Date.now() > deadline)
  const vm: QuickJSContext = runtime.newContext()
  const deferreds = new Set<QuickJSDeferredPromise>()
  // Calls run strictly one after another, even when the script does not await them.
  let chain: Promise<void> = Promise.resolve()
  let lastYield = Date.now()

  const interruption = (): ScriptOutcome => {
    if (options.stopRequested()) return { status: 'stopped', error: { name: 'Stopped', message: 'The script was stopped.' }, calls }
    if (Date.now() > deadline) {
      return {
        status: 'timeout',
        error: {
          name: 'Timeout',
          message: `The script ran past its ${options.timeoutMs} ms limit.`,
          hint: 'Look for a loop that never ends, or pass a larger timeoutMs (at most 300000).',
        },
        calls,
      }
    }
    return { status: 'error', error: { name: 'InternalError', message: 'The script ran out of memory or stack.' }, calls }
  }

  /** Runs the guest's queued promise jobs; an interrupt or a crash there ends the run. */
  const pump = () => {
    if (settled) return
    const result = runtime.executePendingJobs()
    if (result.error) {
      const dumped = vm.dump(result.error) as { message?: string } | undefined
      result.error.dispose()
      if (String(dumped?.message).includes('interrupted')) settle(interruption())
      else settle({ status: 'error', error: { name: 'InternalError', message: String(dumped?.message ?? dumped) }, calls })
    }
  }

  const host = vm.newObject()
  const fnCall = vm.newFunction('call', (nameHandle, inputHandle) => {
    const name = vm.getString(nameHandle)
    const inputJson = vm.getString(inputHandle)
    const deferred = vm.newPromise()
    deferreds.add(deferred)
    chain = chain.then(async () => {
      let answer: { ok: boolean; value?: unknown; error?: string; hint?: string; kind?: string }
      // Commands resolve as microtasks, so a long run of calls would starve timers, input and
      // painting; give the event loop a turn every few milliseconds.
      if (Date.now() - lastYield > YIELD_EVERY_MS) {
        await new Promise<void>((resolve) => timers.setTimeout(resolve, 0))
        lastYield = Date.now()
      }
      if (!settled && (options.stopRequested() || Date.now() > deadline)) settle(interruption())
      if (settled) return
      if (name !== '$help' && ++calls > maxCalls) {
        answer = { ok: false, kind: 'refused', error: `More than ${maxCalls} calls in one run.`, hint: 'Split the work into several runs.' }
      } else if (name === '$help') {
        answer = { ok: true, value: options.help(JSON.parse(inputJson).id as string) }
      } else {
        options.onCall?.(name)
        try {
          answer = await options.call(name, JSON.parse(inputJson))
        } catch (error) {
          answer = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        options.onCall?.(undefined)
      }
      if (settled || !deferred.alive) return
      const text = vm.newString(JSON.stringify(answer))
      deferred.resolve(text)
      text.dispose()
      deferreds.delete(deferred)
      deferred.dispose()
      pump()
    })
    return deferred.handle
  })
  const fnLog = vm.newFunction('log', (levelHandle, textHandle, lineHandle) => {
    const level = vm.getString(levelHandle) as ScriptLog['level']
    let text = vm.getString(textHandle)
    if (text.length > MAX_LOG_CHARS) text = `${text.slice(0, MAX_LOG_CHARS)}…`
    const line = vm.getNumber(lineHandle)
    options.onLog?.(line > 0 ? { level, text, line } : { level, text })
  })
  const fnDone = vm.newFunction('done', (textHandle) => {
    const text = vm.getString(textHandle)
    let value: unknown = null
    try {
      value = text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : JSON.parse(text)
    } catch {
      value = text
    }
    settle({ status: 'ok', value, calls })
  })
  const fnFail = vm.newFunction('fail', (textHandle) => {
    const error = JSON.parse(vm.getString(textHandle)) as ScriptError
    if (error.message === 'interrupted' && !error.command) settle(interruption())
    else settle({ status: 'error', error, calls })
  })
  vm.setProp(host, 'call', fnCall)
  vm.setProp(host, 'log', fnLog)
  vm.setProp(host, 'done', fnDone)
  vm.setProp(host, 'fail', fnFail)
  for (const fn of [fnCall, fnLog, fnDone, fnFail]) fn.dispose()

  let timer: unknown
  try {
    const handles: QuickJSHandle[] = []
    const take = (h: QuickJSHandle) => (handles.push(h), h)
    const prelude = vm.evalCode(PRELUDE, 'prelude.js')
    if (prelude.error) throw new Error(`Script prelude failed: ${JSON.stringify(vm.dump(take(prelude.error)))}`)
    const makeWorld = take(prelude.value)
    const parsedNames = take(vm.unwrapResult(vm.evalCode(`(${JSON.stringify(options.commands.map((c) => c.name))})`)))
    const world = take(vm.unwrapResult(vm.callFunction(makeWorld, vm.undefined, host, parsedNames, take(vm.newNumber(options.seed)))))
    host.dispose()

    // The script is the body of an async function; its line N is line N + 1 of the file.
    const compiled = vm.evalCode(`(async function (ac, console, here) {\n${options.code}\n})`, FILE)
    if (compiled.error) {
      const dumped = vm.dump(take(compiled.error)) as { name?: string; message?: string; stack?: string }
      const m = /script\.js:(\d+)/.exec(String(dumped?.stack ?? ''))
      const line = m ? Number(m[1]) - 1 : undefined
      settle({
        status: 'error',
        error: { name: dumped?.name ?? 'SyntaxError', message: String(dumped?.message ?? dumped), ...(line ? { line } : {}) },
        calls,
      })
    } else {
      const main = take(compiled.value)
      const hereHandle = take(
        options.here
          ? vm.unwrapResult(vm.evalCode(`Object.freeze(${JSON.stringify(options.here)})`))
          : vm.null,
      )
      const ac = take(vm.getProp(world, 'ac'))
      const consoleHandle = take(vm.getProp(world, 'console'))
      const finish = take(vm.getProp(world, 'finish'))
      const started = vm.callFunction(main, vm.undefined, ac, consoleHandle, hereHandle)
      if (started.error) {
        const dumped = vm.dump(take(started.error)) as { message?: string }
        if (String(dumped?.message).includes('interrupted')) settle(interruption())
        else settle({ status: 'error', error: { name: 'Error', message: String(dumped?.message ?? dumped) }, calls })
      } else {
        const promise = take(started.value)
        const wired = vm.callFunction(finish, vm.undefined, promise)
        if (wired.error) take(wired.error)
        else take(wired.value)
        pump()
      }
    }
    for (const h of handles) if (h.alive && h !== vm.null && h !== vm.undefined) h.dispose()

    if (!settled) {
      timer = timers.setTimeout(() => settle(interruption()), Math.max(0, deadline - Date.now()) + 5)
      options.stopSignal?.then(() => settle(interruption()))
    }
    await finished
    // Let a command that was already running finish, so nothing writes after the run returns.
    await chain
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer)
    for (const d of deferreds) if (d.alive) d.dispose()
    try {
      vm.dispose()
      runtime.dispose()
    } catch {
      // A run cut short can leave guest objects behind; the runtime is thrown away either way.
    }
  }
  return outcome ?? finishedOutcome(calls)
}

function finishedOutcome(calls: number): ScriptOutcome {
  return { status: 'error', error: { name: 'Error', message: 'The script ended without a result.' }, calls }
}
