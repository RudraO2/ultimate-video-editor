/** One command a plan runs, with what it returned when the plan was made. */
export interface PlanStep {
  call: string
  input: unknown
  result?: unknown
}

const IDENT = /^[A-Za-z_$][\w$]*$/

/**
 * Prints a plan (the commands a dry run made, in order) as an `ac.*` script
 * that does the same when run. Ids the plan made (`made`) are not pasted: each
 * comes from the result of the step that made it (`s3.id`), so the script works
 * on the project it was planned on, with fresh ids.
 */
export function planToScript(steps: readonly PlanStep[], made: ReadonlySet<string>, header?: string): string {
  const exprs = new Map<string, string>()
  const used = new Set<number>()
  const lines: string[] = []
  const varOf = (i: number) => `s${i}`
  const stepOf = (expr: string) => Number(/^s(\d+)/.exec(expr)?.[1])

  const literal = (value: unknown): string => {
    if (typeof value === 'string') {
      const whole = exprs.get(value)
      if (whole) {
        used.add(stepOf(whole))
        return whole
      }
      let hit = false
      let text = value.replace(/[`\\$]/g, (c) => `\\${c}`)
      for (const [id, expr] of exprs) {
        if (value.includes(id)) {
          hit = true
          used.add(stepOf(expr))
          text = text.split(id).join(`\${${expr}}`)
        }
      }
      return hit ? `\`${text}\`` : JSON.stringify(value)
    }
    if (Array.isArray(value)) return `[${value.map((v) => literal(v)).join(', ')}]`
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value).filter(([, v]) => v !== undefined)
      if (entries.length === 0) return '{}'
      return `{ ${entries.map(([k, v]) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${literal(v)}`).join(', ')} }`
    }
    return JSON.stringify(value)
  }

  /** Finds the made ids in a step's result and remembers how to reach each. */
  const collect = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      if (made.has(value) && !exprs.has(value)) exprs.set(value, path)
      return
    }
    if (Array.isArray(value)) value.forEach((v, i) => collect(v, `${path}[${i}]`))
    else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) collect(v, IDENT.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`)
    }
  }

  const bodies: string[] = []
  steps.forEach((step, i) => {
    const [space, ...rest] = step.call.split('.')
    const verb = rest.join('.')
    const callee = space && verb && IDENT.test(space) && IDENT.test(verb) ? `ac.${space}.${verb}` : `ac.call(${JSON.stringify(step.call)}, `
    const args = literal(step.input ?? {})
    bodies.push(callee.startsWith('ac.call(') ? `${callee}${args})` : `${callee}(${args})`)
    collect(step.result, varOf(i))
  })
  if (header) lines.push(...header.split('\n').map((l) => `// ${l}`))
  bodies.forEach((body, i) => {
    lines.push(used.has(i) ? `const ${varOf(i)} = await ${body}` : `await ${body}`)
  })
  return `${lines.join('\n')}\n`
}
