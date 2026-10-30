import type { CallOptions } from '@uve/core'
import type { InspectedFont } from '../../../shared/fonts'
import { session } from '../store'
import { loadInstalledFont } from './fonts'

/** What installing one font file did. */
export interface InstalledResult {
  id: string
  family: string
  weight: number
  italic: boolean
  variable: { min: number; max: number } | null
  /** The file was in the project already. */
  reused: boolean
}

/**
 * Installs font files, as the main process read them, into the project: one
 * undo step for all of them. The family name each one reports is the name to
 * set as a text layer's fontFamily.
 */
export async function installFonts(files: readonly InspectedFont[], options: CallOptions = {}): Promise<InstalledResult[]> {
  const group = options.group ?? 'fonts:' + Date.now()
  const label = options.label ?? (files.length === 1 ? 'Install font' : 'Install fonts')
  const installed: InstalledResult[] = []
  for (const file of files) {
    const result = await session.call(
      'fonts.add',
      { family: file.family, path: file.path, name: file.name, weight: file.weight, italic: file.italic, variable: file.variable, format: file.format },
      { group, label },
    )
    if (!result.ok) throw new Error(result.error + (result.hint ? ' ' + result.hint : ''))
    const value = result.value as { id: string; reused?: boolean }
    installed.push({ id: value.id, family: file.family, weight: file.weight, italic: file.italic, variable: file.variable, reused: value.reused ?? false })
  }
  // Loading starts as soon as the project lists the font; waiting here means the caller can draw with it at once.
  await Promise.all(session.project.fonts.filter((f) => files.some((file) => file.path === f.path)).map(loadInstalledFont))
  return installed
}
