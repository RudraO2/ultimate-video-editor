import { CommandError } from './errors'

// Patch paths are dotted keys with optional list steps:
//   style.color · effects[0] · effects[id=fx_1].enabled · strokes[-] (append)

type Step =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'match'; field: string; value: string }
  | { kind: 'append' }

export type PatchOp =
  | { op: 'set'; path: string; value?: unknown }
  | { op: 'merge'; path: string; value: Record<string, unknown> }
  | { op: 'insert'; path: string; value?: unknown }
  | { op: 'remove'; path: string }
  | { op: 'move'; path: string; to: number }

const SEGMENT = /^([A-Za-z_$][\w$]*)?((?:\[[^\]]*\])*)$/
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const PATH_HINT = 'Paths look like style.color, effects[0], effects[id=fx_1].enabled or strokes[-].'

export function parsePath(path: string): Step[] {
  const steps: Step[] = []
  for (const segment of path.split('.')) {
    const match = SEGMENT.exec(segment)
    if (!match || (!match[1] && !match[2])) throw new CommandError(`Cannot read path "${path}".`, PATH_HINT)
    if (match[1]) {
      if (UNSAFE_KEYS.has(match[1])) throw new CommandError(`"${match[1]}" is not allowed in a path.`)
      steps.push({ kind: 'key', key: match[1] })
    }
    for (const [, inner = ''] of (match[2] ?? '').matchAll(/\[([^\]]*)\]/g)) {
      if (inner === '-') steps.push({ kind: 'append' })
      else if (/^\d+$/.test(inner)) steps.push({ kind: 'index', index: Number(inner) })
      else {
        const eq = inner.indexOf('=')
        if (eq <= 0) throw new CommandError(`Cannot read "[${inner}]" in path "${path}".`, PATH_HINT)
        steps.push({ kind: 'match', field: inner.slice(0, eq), value: inner.slice(eq + 1) })
      }
    }
  }
  if (steps.length === 0) throw new CommandError('The path is empty.', PATH_HINT)
  return steps
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function listIndex(list: unknown[], step: Step, path: string): number {
  if (step.kind === 'index') {
    if (step.index < list.length) return step.index
    throw new CommandError(`"${path}": index ${step.index} is past the end of a list of ${list.length}.`)
  }
  if (step.kind === 'match') {
    const i = list.findIndex((item) => isRecord(item) && String(item[step.field]) === step.value)
    if (i >= 0) return i
    throw new CommandError(`"${path}": no item with ${step.field}=${step.value}.`)
  }
  throw new CommandError(`"${path}": "[-]" only works as the last step of set or insert.`)
}

/** Follows every step but the last, returning the container the last step acts on. */
function parentOf(root: Record<string, unknown>, steps: Step[], path: string, create: boolean): unknown {
  let node: unknown = root
  for (const step of steps.slice(0, -1)) {
    if (step.kind === 'key') {
      if (!isRecord(node)) throw new CommandError(`"${path}": "${step.key}" is not inside an object.`)
      if (node[step.key] === undefined && create) node[step.key] = {}
      node = node[step.key]
    } else {
      if (!Array.isArray(node)) throw new CommandError(`"${path}": a list step was used on something that is not a list.`)
      node = node[listIndex(node, step, path)]
    }
    if (node === undefined) throw new CommandError(`"${path}" does not exist.`)
  }
  return node
}

function applyOp(root: Record<string, unknown>, op: PatchOp): void {
  const steps = parsePath(op.path)
  const last = steps[steps.length - 1] as Step
  const parent = parentOf(root, steps, op.path, op.op === 'set')

  switch (op.op) {
    case 'set':
    case 'insert': {
      if (last.kind === 'key') {
        if (op.op === 'insert') throw new CommandError(`"${op.path}": insert needs a list position such as [0] or [-].`)
        if (!isRecord(parent)) throw new CommandError(`"${op.path}": the parent is not an object.`)
        parent[last.key] = op.value
      } else if (!Array.isArray(parent)) {
        throw new CommandError(`"${op.path}": the parent is not a list.`)
      } else if (last.kind === 'append') {
        parent.push(op.value)
      } else if (op.op === 'insert' && last.kind === 'index') {
        parent.splice(Math.min(last.index, parent.length), 0, op.value)
      } else {
        parent[listIndex(parent, last, op.path)] = op.value
      }
      return
    }
    case 'merge': {
      const target =
        last.kind === 'key'
          ? isRecord(parent)
            ? parent[last.key]
            : undefined
          : Array.isArray(parent)
            ? parent[listIndex(parent, last, op.path)]
            : undefined
      if (!isRecord(target)) throw new CommandError(`"${op.path}": merge needs an object there.`)
      for (const key of Object.keys(op.value)) {
        if (UNSAFE_KEYS.has(key)) throw new CommandError(`"${key}" is not allowed in a merge.`)
      }
      Object.assign(target, op.value)
      return
    }
    case 'remove': {
      if (last.kind === 'key') {
        if (!isRecord(parent) || !(last.key in parent)) throw new CommandError(`"${op.path}" does not exist.`)
        delete parent[last.key]
      } else if (Array.isArray(parent)) {
        parent.splice(listIndex(parent, last, op.path), 1)
      } else {
        throw new CommandError(`"${op.path}": the parent is not a list.`)
      }
      return
    }
    case 'move': {
      if (!Array.isArray(parent) || last.kind === 'key') {
        throw new CommandError(`"${op.path}": move works on list items, e.g. effects[1].`)
      }
      const [item] = parent.splice(listIndex(parent, last, op.path), 1)
      parent.splice(Math.min(op.to, parent.length), 0, item)
      return
    }
  }
}

/** Applies patch operations in order to a plain (non-frozen) object. */
export function applyPatchOps(root: Record<string, unknown>, ops: readonly PatchOp[]): void {
  for (const op of ops) applyOp(root, op)
}
