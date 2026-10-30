import { z } from 'zod'
import { CommandError, parseOrThrow } from '../errors'
import { defineCommand } from '../registry'
import { FONT_FORMATS, InstalledFontSchema, type Project } from '../schema'

/** The names of the text layers (and layers with styled ranges) that use a family. */
function layersUsingFamily(project: Project, family: string): string[] {
  const names: string[] = []
  for (const comp of project.comps) {
    for (const track of comp.tracks) {
      for (const layer of track.layers) {
        if (layer.kind === 'text' && (layer.style.fontFamily === family || layer.ranges.some((r) => r.style.fontFamily === family))) names.push(layer.name)
      }
    }
  }
  return names
}

export const fontsAdd = defineCommand({
  name: 'fonts.add',
  summary: 'Register a font file in the project so text can use its family by name. font_install reads the file and calls this.',
  details:
    'family is what the file calls itself: set it as style.fontFamily. Several files of one family (a regular and a bold, an italic) are one family; a variable font covers a weight range. A file already registered (same path) is reused. The file stays where it is.',
  effect: 'write',
  input: z.strictObject({
    family: z.string().min(1),
    path: z.string().min(1),
    name: z.string().min(1),
    weight: z.number().int().min(100).max(900).default(400),
    italic: z.boolean().default(false),
    variable: z.strictObject({ min: z.number(), max: z.number() }).nullable().default(null),
    format: z.enum(FONT_FORMATS).default('ttf'),
  }),
  run: (input, ctx) => {
    const known = ctx.project.fonts.find((f) => f.path === input.path)
    if (known) return { id: known.id, family: known.family, reused: true }
    const font = parseOrThrow(InstalledFontSchema, { id: ctx.ids('font'), ...input }, 'The font entry')
    ctx.write('Install font', (draft) => {
      draft.fonts.push(font)
    })
    return { id: font.id, family: font.family }
  },
})

export const fontsRemove = defineCommand({
  name: 'fonts.remove',
  summary: 'Take an installed font family (every file of it) out of the project. The files on disk are not touched.',
  details: 'Text that uses the family keeps its name and draws in a fallback font until the family is installed again; the result lists those layers.',
  effect: 'write',
  input: z.strictObject({ family: z.string().min(1) }),
  run: ({ family }, ctx) => {
    const files = ctx.project.fonts.filter((f) => f.family === family)
    if (files.length === 0) {
      throw new CommandError(`No installed font family "${family}".`, `Installed: ${[...new Set(ctx.project.fonts.map((f) => f.family))].join(', ') || 'none'}.`)
    }
    const stillUsedBy = layersUsingFamily(ctx.project, family)
    ctx.write('Remove font', (draft) => {
      draft.fonts = draft.fonts.filter((f) => f.family !== family)
    })
    return { removed: family, files: files.length, ...(stillUsedBy.length > 0 ? { usedBy: stillUsedBy } : {}) }
  },
})
