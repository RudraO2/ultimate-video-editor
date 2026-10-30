import { CommandError } from '@uve/core'

/**
 * The formats an export can ask for, by AtomCut's export panel ids (`mp4`,
 * `mov`, `webm`, `gif`, `png-seq`, `audio`), plus stills of one frame (`png`,
 * as AtomCut, and `jpg` and `webp`).
 */
export const EXPORT_FORMATS = ['mp4', 'mov', 'webm', 'gif', 'png-seq', 'audio', 'png', 'jpg', 'webp'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** Stills: one frame of the comp as an image. */
export const STILL_FORMATS: readonly ExportFormat[] = ['png', 'jpg', 'webp']

export const isStillFormat = (format: ExportFormat): boolean => STILL_FORMATS.includes(format)

/** Other spellings agents use, mapped to the ids. */
const FORMAT_ALIASES: Record<string, ExportFormat> = {
  mpeg4: 'mp4',
  quicktime: 'mov',
  'animated-gif': 'gif',
  'png-sequence': 'png-seq',
  'png_seq': 'png-seq',
  pngseq: 'png-seq',
  sequence: 'png-seq',
  wav: 'audio',
  'audio-only': 'audio',
  image: 'png',
  still: 'png',
  jpeg: 'jpg',
}

/** The format `input` names (case, a leading dot and the aliases are forgiven). Throws a command error for an unknown one. */
export function parseExportFormat(input: string): ExportFormat {
  const key = input.trim().toLowerCase().replace(/^\./, '')
  const format = (EXPORT_FORMATS as readonly string[]).includes(key) ? (key as ExportFormat) : FORMAT_ALIASES[key]
  if (!format) {
    throw new CommandError(`"${input}" is not an export format.`, `Use one of: ${EXPORT_FORMATS.join(', ')}.`)
  }
  return format
}
