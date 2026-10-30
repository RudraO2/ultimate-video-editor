import { z } from 'zod'
import { defineCommand } from '../registry'

// Frames (comps) and pages have their own file: frame.ts.

export const projectUpdate = defineCommand({
  name: 'project.update',
  summary: 'Rename the project.',
  effect: 'write',
  input: z.strictObject({ name: z.string().trim().min(1) }),
  run: ({ name }, ctx) => {
    ctx.write('Rename project', (draft) => {
      draft.name = name
    })
    return { name }
  },
})
