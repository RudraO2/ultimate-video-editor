import { describe, expect, it } from 'vitest'
import { fontFormatOf, fontInfoFromTables, fontMimeOf, sfntTables, woff2Directory, woffDirectory } from './fontFile'

// Fonts are built byte by byte here: a table directory with the few tables the
// reader looks at (name, OS/2, head, fvar).

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const tag = (s: string) => [...s].map((c) => c.charCodeAt(0))
const fixed = (n: number) => u32(Math.round(n * 65536) >>> 0)

/** A name table with Windows English strings by name id. */
function nameTable(names: Record<number, string>): number[] {
  const entries = Object.entries(names).map(([id, text]) => ({ id: Number(id), data: [...text].flatMap((c) => u16(c.charCodeAt(0))) }))
  const headerLength = 6 + entries.length * 12
  let offset = 0
  const records: number[] = []
  const strings: number[] = []
  for (const e of entries) {
    records.push(...u16(3), ...u16(1), ...u16(0x409), ...u16(e.id), ...u16(e.data.length), ...u16(offset))
    strings.push(...e.data)
    offset += e.data.length
  }
  return [...u16(0), ...u16(entries.length), ...u16(headerLength), ...records, ...strings]
}

function os2Table(weight: number, selection: number): number[] {
  const bytes = new Array(78).fill(0)
  bytes.splice(4, 2, ...u16(weight))
  bytes.splice(62, 2, ...u16(selection))
  return bytes
}

function fvarTable(min: number, def: number, max: number): number[] {
  const header = [...u16(1), ...u16(0), ...u16(16), ...u16(2), ...u16(1), ...u16(20), ...u16(0), ...u16(0)]
  const axis = [...tag('wght'), ...fixed(min), ...fixed(def), ...fixed(max), ...u16(0), ...u16(256)]
  return [...header, ...axis]
}

/** An sfnt file from named tables. */
function sfnt(tables: Record<string, number[]>, flavor = [0, 1, 0, 0]): Uint8Array {
  const names = Object.keys(tables)
  const directoryLength = 12 + names.length * 16
  let offset = directoryLength
  const directory: number[] = [...flavor, ...u16(names.length), ...u16(0), ...u16(0), ...u16(0)]
  const body: number[] = []
  for (const name of names) {
    const data = tables[name] as number[]
    directory.push(...tag(name), ...u32(0), ...u32(offset), ...u32(data.length))
    body.push(...data)
    while (body.length % 4 !== 0) body.push(0)
    offset = directoryLength + body.length
  }
  return new Uint8Array([...directory, ...body])
}

describe('font files', () => {
  it('tells containers apart by their first bytes', () => {
    expect(fontFormatOf(sfnt({ name: nameTable({ 1: 'A' }) }))).toBe('ttf')
    expect(fontFormatOf(sfnt({ name: nameTable({ 1: 'A' }) }, tag('OTTO')))).toBe('otf')
    expect(fontFormatOf(new Uint8Array([...tag('wOFF'), ...new Array(40).fill(0)]))).toBe('woff')
    expect(fontFormatOf(new Uint8Array([...tag('wOF2'), ...new Array(40).fill(0)]))).toBe('woff2')
    expect(fontFormatOf(new Uint8Array([...tag('ttcf'), ...new Array(40).fill(0)]))).toBe('ttc')
    expect(fontFormatOf(new TextEncoder().encode('[Display]\r\nnot a font at all'))).toBeNull()
    expect(fontFormatOf(new Uint8Array(4))).toBeNull()
  })

  it('reads the family, style, weight and italic of a static font', () => {
    const bytes = sfnt({ name: nameTable({ 1: 'Georgia', 2: 'Bold Italic', 4: 'Georgia Bold Italic' }), 'OS/2': os2Table(700, 0b1), head: new Array(54).fill(0) })
    const info = fontInfoFromTables(sfntTables(bytes) as NonNullable<ReturnType<typeof sfntTables>>)
    expect(info).toMatchObject({ family: 'Georgia', subfamily: 'Bold Italic', fullName: 'Georgia Bold Italic', weight: 700, italic: true, variable: null })
  })

  it('prefers the typographic family and subfamily (name ids 16 and 17)', () => {
    const bytes = sfnt({ name: nameTable({ 1: 'Acme Display Light', 2: 'Regular', 16: 'Acme Display', 17: 'Light' }), 'OS/2': os2Table(300, 0) })
    expect(fontInfoFromTables(sfntTables(bytes) as NonNullable<ReturnType<typeof sfntTables>>)).toMatchObject({ family: 'Acme Display', subfamily: 'Light', weight: 300, italic: false })
  })

  it('reads the weight range of a variable font from fvar', () => {
    const bytes = sfnt({ name: nameTable({ 1: 'Inter' }), 'OS/2': os2Table(400, 0), fvar: fvarTable(100, 400, 900) })
    expect(fontInfoFromTables(sfntTables(bytes) as NonNullable<ReturnType<typeof sfntTables>>)?.variable).toEqual({ min: 100, max: 900 })
  })

  it('rounds the weight class to a hundred and falls back to head for italic', () => {
    const bytes = sfnt({ name: nameTable({ 1: 'Mono', 2: 'Regular' }), head: [...new Array(44).fill(0), ...u16(0b10), 0, 0] })
    const info = fontInfoFromTables(sfntTables(bytes) as NonNullable<ReturnType<typeof sfntTables>>)
    expect(info).toMatchObject({ weight: 400, italic: true })
    const odd = sfnt({ name: nameTable({ 1: 'Odd' }), 'OS/2': os2Table(650, 0) })
    expect(fontInfoFromTables(sfntTables(odd) as NonNullable<ReturnType<typeof sfntTables>>)?.weight).toBe(700)
  })

  it('refuses a file without a name table, and a directory that does not fit', () => {
    expect(fontInfoFromTables(sfntTables(sfnt({ head: new Array(54).fill(0) })) as NonNullable<ReturnType<typeof sfntTables>>)).toBeNull()
    expect(sfntTables(new Uint8Array([0, 1, 0, 0, 0, 40, 0, 0, 0, 0, 0, 0]))).toBeNull()
  })

  it('reads the first font of a collection', () => {
    const inner = sfnt({ name: nameTable({ 1: 'Collected' }), 'OS/2': os2Table(400, 0) })
    // ttcf header: tag, version, count, offset of the first font (12 + 4).
    const bytes = new Uint8Array([...tag('ttcf'), ...u32(0x10000), ...u32(1), ...u32(16), ...fixOffsets(inner, 16)])
    expect(fontInfoFromTables(sfntTables(bytes) as NonNullable<ReturnType<typeof sfntTables>>, 'ttc')?.family).toBe('Collected')
  })

  it('lists the tables of a WOFF 1 file and a WOFF 2 file', () => {
    const woff = new Uint8Array([
      ...tag('wOFF'), ...u32(0x10000), ...u32(0), ...u16(2), ...u16(0), ...u32(0), ...u16(1), ...u16(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
      ...tag('name'), ...u32(100), ...u32(20), ...u32(30), ...u32(0),
      ...tag('OS/2'), ...u32(200), ...u32(78), ...u32(78), ...u32(0),
    ])
    expect(woffDirectory(woff)).toEqual([
      { tag: 'name', offset: 100, storedLength: 20, length: 30 },
      { tag: 'OS/2', offset: 200, storedLength: 78, length: 78 },
    ])
    // WOFF2: header (48 bytes), then per table a flags byte (known tag number, transform in the top bits) and its length in base-128.
    const header = [...tag('wOF2'), ...u32(0x10000), ...u32(0), ...u16(3), ...u16(0), ...u32(0), ...u32(77), ...new Array(24).fill(0)]
    const directory = [5, 0x1e, 6 | (1 << 6), 0x4e, 0x40, 10, 0x81, 0x02, 0x40]
    const packed = woff2Directory(new Uint8Array([...header, ...directory, ...new Array(8).fill(0)]))
    // name (5): length 30; OS/2 (6) with transform version 1: original 78, transformed 64; glyf (10) transformed: original 130, transform length 64.
    expect(packed?.streamLength).toBe(77)
    expect(packed?.tables.map((t) => [t.tag, t.length])).toEqual([
      ['name', 30],
      ['OS/2', 64],
      ['glyf', 64],
    ])
  })

  it('knows the MIME type of a font file by its name', () => {
    expect(fontMimeOf('C:\\Fonts\\Inter.TTF')).toBe('font/ttf')
    expect(fontMimeOf('a.woff2')).toBe('font/woff2')
    expect(fontMimeOf('notes.txt')).toBeNull()
    expect(fontMimeOf('noextension')).toBeNull()
  })
})

/** The table offsets of an sfnt copied to `shift` bytes into a bigger file point past that shift. */
function fixOffsets(font: Uint8Array, shift: number): number[] {
  const copy = new Uint8Array(font)
  const view = new DataView(copy.buffer)
  const count = view.getUint16(4)
  for (let i = 0; i < count; i++) view.setUint32(12 + i * 16 + 8, view.getUint32(12 + i * 16 + 8) + shift + 0)
  return [...copy]
}
