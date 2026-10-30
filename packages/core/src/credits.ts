import type { Project } from './schema'

// What the project owes: the licence and credit of the files and icons taken
// from libraries (sounds, icons). Gathered from where they sit in the
// document, so it is always up to date and needs no list of its own.

export interface Credit {
  kind: 'sound' | 'media' | 'icon'
  /** What it is: a file name, or an icon set. */
  name: string
  license: string
  /** Who to credit, or where it came from. */
  credit: string
  /** How many icons or layers use it (icons). */
  uses?: number
}

/** The credits of a project, one for each file and each icon set in use. */
export function creditsOf(project: Project): Credit[] {
  const credits: Credit[] = []
  for (const media of project.media) {
    if (!media.credit) continue
    credits.push({
      kind: media.kind === 'audio' ? 'sound' : 'media',
      name: media.name,
      license: media.credit.license,
      credit: media.credit.attribution !== '' ? media.credit.attribution : media.credit.source,
    })
  }
  const icons = new Map<string, Credit & { ids: Set<string> }>()
  for (const comp of project.comps) {
    for (const track of comp.tracks) {
      for (const layer of track.layers) {
        if (layer.origin?.kind !== 'icon') continue
        const set = layer.origin.id.split(':')[0] ?? layer.origin.id
        const known = icons.get(set)
        if (known) known.ids.add(layer.origin.id)
        else icons.set(set, { kind: 'icon', name: set + ' icons', license: layer.origin.license ?? 'unknown', credit: layer.origin.author, ids: new Set([layer.origin.id]) })
      }
    }
  }
  for (const { ids, ...credit } of [...icons.values()].sort((a, b) => a.name.localeCompare(b.name))) credits.push({ ...credit, uses: ids.size })
  return credits
}

/** A credit as one line for a description or a credits card. */
export function creditLine(credit: Credit): string {
  const who = credit.credit !== '' ? credit.credit : 'unknown author'
  return credit.kind === 'icon' ? credit.name + ' by ' + who + ' (' + credit.license + ')' : credit.name + ': ' + who + ' (' + credit.license + ')'
}
