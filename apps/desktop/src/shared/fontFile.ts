// What a font file says about itself: its family, style, weight and whether it
// is a variable font, read from the sfnt tables (`name`, `OS/2`, `head`,
// `fvar`). Shared by the main process, which reads the files, and the tests.
// Plain TypeScript only: no Node or DOM APIs. WOFF and WOFF2 are compressed
// containers: the main process unpacks their tables, then calls
// `fontInfoFromTables`.

export type FontFormat = 'ttf' | 'otf' | 'ttc' | 'woff' | 'woff2'

/** The extensions of the font files the editor installs. */
export const FONT_EXTENSIONS: readonly string[] = ['ttf', 'otf', 'ttc', 'woff', 'woff2']

/** The MIME type of each, for serving a granted font file. */
export const FONT_MIME: Readonly<Record<string, string>> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  ttc: 'font/collection',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

/** The MIME type of a font file, from its name; null for other files. */
export function fontMimeOf(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  return Object.hasOwn(FONT_MIME, ext) ? (FONT_MIME[ext] ?? null) : null
}

/** What a font file says about itself. */
export interface FontInfo {
  /** The family name to set as `fontFamily`: the typographic family, else the plain one. */
  family: string
  subfamily: string
  fullName: string
  /** The weight class, 100 to 900 (400 when the file does not say). */
  weight: number
  italic: boolean
  /** The weight range of a variable font; null for a static one. */
  variable: { min: number; max: number } | null
  format: FontFormat
}

export type SfntTables = Map<string, Uint8Array>

const tagOf = (bytes: Uint8Array, at: number) => String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0)

/** The container a file is, from its first bytes; null when it is not a font. */
export function fontFormatOf(bytes: Uint8Array): FontFormat | null {
  if (bytes.length < 12) return null
  const tag = tagOf(bytes, 0)
  if (tag === 'wOFF') return 'woff'
  if (tag === 'wOF2') return 'woff2'
  if (tag === 'ttcf') return 'ttc'
  if (tag === 'OTTO') return 'otf'
  if (tag === '\u0000\u0001\u0000\u0000' || tag === 'true') return 'ttf'
  return null
}

/** The tables of an uncompressed sfnt (TrueType, OpenType, or the first font of a collection); null when the directory does not fit the file. */
export function sfntTables(bytes: Uint8Array): SfntTables | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let base = 0
  if (tagOf(bytes, 0) === 'ttcf') {
    if (bytes.length < 16) return null
    base = view.getUint32(12)
  }
  if (base + 12 > bytes.length) return null
  const count = view.getUint16(base + 4)
  if (base + 12 + count * 16 > bytes.length) return null
  const tables: SfntTables = new Map()
  for (let i = 0; i < count; i++) {
    const record = base + 12 + i * 16
    const offset = view.getUint32(record + 8)
    const length = view.getUint32(record + 12)
    if (offset + length > bytes.length) return null
    tables.set(tagOf(bytes, record), bytes.subarray(offset, offset + length))
  }
  return tables
}

/** The strings of a `name` table, by name id; the best platform and language wins (Windows English, then any Windows, Unicode, Mac Roman). */
function readNames(table: Uint8Array): Map<number, string> {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength)
  const count = view.getUint16(2)
  const stringsAt = view.getUint16(4)
  const best = new Map<number, { rank: number; text: string }>()
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12
    if (record + 12 > table.length) break
    const platform = view.getUint16(record)
    const language = view.getUint16(record + 4)
    const id = view.getUint16(record + 6)
    const length = view.getUint16(record + 8)
    const offset = stringsAt + view.getUint16(record + 10)
    if (offset + length > table.length) continue
    const raw = table.subarray(offset, offset + length)
    let text = ''
    let rank: number
    if (platform === 3 || platform === 0) {
      for (let k = 0; k + 1 < raw.length; k += 2) text += String.fromCharCode(((raw[k] ?? 0) << 8) | (raw[k + 1] ?? 0))
      rank = platform === 3 ? (language === 0x409 ? 4 : 3) : 2
    } else if (platform === 1) {
      for (const byte of raw) text += String.fromCharCode(byte)
      rank = language === 0 ? 1 : 0
    } else continue
    text = text.trim()
    if (text === '') continue
    const known = best.get(id)
    if (!known || rank > known.rank) best.set(id, { rank, text })
  }
  return new Map([...best].map(([id, { text }]) => [id, text]))
}

/** The family, style, weight and variable range from a font's tables; null when it has no usable `name` table. */
export function fontInfoFromTables(tables: SfntTables, format: FontFormat = 'ttf'): FontInfo | null {
  const nameTable = tables.get('name')
  if (!nameTable || nameTable.length < 6) return null
  const names = readNames(nameTable)
  const family = names.get(16) ?? names.get(1)
  if (!family) return null
  const subfamily = names.get(17) ?? names.get(2) ?? 'Regular'

  let weight = 400
  let italic = /italic|oblique/i.test(subfamily)
  const os2 = tables.get('OS/2')
  if (os2 && os2.length >= 64) {
    const view = new DataView(os2.buffer, os2.byteOffset, os2.byteLength)
    const wanted = view.getUint16(4)
    if (wanted >= 1) weight = Math.min(900, Math.max(100, Math.round(wanted / 100) * 100))
    const selection = view.getUint16(62)
    italic = (selection & 1) !== 0 || (selection & (1 << 9)) !== 0 || italic
  } else {
    const head = tables.get('head')
    if (head && head.length >= 46) italic = (new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(44) & 2) !== 0 || italic
  }

  let variable: FontInfo['variable'] = null
  const fvar = tables.get('fvar')
  if (fvar && fvar.length >= 16) {
    const view = new DataView(fvar.buffer, fvar.byteOffset, fvar.byteLength)
    const axesAt = view.getUint16(4)
    const axes = view.getUint16(8)
    const size = view.getUint16(10)
    for (let i = 0; i < axes; i++) {
      const record = axesAt + i * size
      if (record + 16 > fvar.length) break
      if (tagOf(fvar, record) === 'wght') variable = { min: view.getInt32(record + 4) / 65536, max: view.getInt32(record + 12) / 65536 }
    }
  }
  return { family, subfamily, fullName: names.get(4) ?? `${family} ${subfamily}`, weight, italic, variable, format }
}

/** The tag of each WOFF2 table with a known number (the spec's table of 63). */
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
] as const

/** A table of a WOFF container: where its bytes are in the unpacked data, or (WOFF 1) in the file. */
export interface PackedTable {
  tag: string
  /** WOFF 1: the file offset of the table's data. */
  offset: number
  /** WOFF 1: the stored length, which differs from `length` when the table is deflated. */
  storedLength: number
  /** The table's length when unpacked (WOFF 2: the length in the unpacked stream). */
  length: number
}

/** The table directory of a WOFF 1 file. */
export function woffDirectory(bytes: Uint8Array): PackedTable[] | null {
  if (bytes.length < 44 || tagOf(bytes, 0) !== 'wOFF') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint16(12)
  if (44 + count * 20 > bytes.length) return null
  const tables: PackedTable[] = []
  for (let i = 0; i < count; i++) {
    const record = 44 + i * 20
    tables.push({ tag: tagOf(bytes, record), offset: view.getUint32(record + 4), storedLength: view.getUint32(record + 8), length: view.getUint32(record + 12) })
  }
  return tables
}

/** The table directory of a WOFF2 file, and where its compressed stream starts and how long it is. */
export function woff2Directory(bytes: Uint8Array): { tables: PackedTable[]; streamAt: number; streamLength: number } | null {
  if (bytes.length < 48 || tagOf(bytes, 0) !== 'wOF2') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint16(12)
  const streamLength = view.getUint32(20)
  let at = 48
  const base128 = (): number | null => {
    let value = 0
    for (let i = 0; i < 5; i++) {
      const byte = bytes[at++]
      if (byte === undefined) return null
      value = value * 128 + (byte & 0x7f)
      if ((byte & 0x80) === 0) return value
    }
    return null
  }
  const tables: PackedTable[] = []
  let used = 0
  for (let i = 0; i < count; i++) {
    const flags = bytes[at++]
    if (flags === undefined) return null
    const known = flags & 0x3f
    let tag: string
    if (known === 63) {
      tag = tagOf(bytes, at)
      at += 4
    } else tag = WOFF2_TAGS[known] ?? ''
    const original = base128()
    if (original === null) return null
    const version = (flags >> 6) & 3
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0
    let length = original
    if (transformed) {
      const transformLength = base128()
      if (transformLength === null) return null
      length = transformLength
    }
    tables.push({ tag, offset: 0, storedLength: length, length })
    used += length
  }
  void used
  return { tables, streamAt: at, streamLength }
}
