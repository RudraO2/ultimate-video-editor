import { describe, expect, it } from 'vitest'
import { iconGroup, iconIdParts, iconStyleOf, iconSvg, iconTitle, isUsableLicense, needsCredit } from './icons'

describe('icon ids', () => {
  it('splits set:name and refuses anything else', () => {
    expect(iconIdParts('lucide:arrow-right')).toEqual({ prefix: 'lucide', name: 'arrow-right' })
    expect(iconIdParts('material-symbols:3d-rotation')).toEqual({ prefix: 'material-symbols', name: '3d-rotation' })
    expect(iconIdParts('fa6-solid:house_chimney')).toEqual({ prefix: 'fa6-solid', name: 'house_chimney' })
    expect(iconIdParts('noset')).toBeNull()
    expect(iconIdParts(':name')).toBeNull()
    expect(iconIdParts('Set:Name')).toBeNull()
    expect(iconIdParts('../etc:passwd')).toBeNull()
    expect(iconIdParts('a:b/c')).toBeNull()
  })

  it('titles an icon by its name', () => {
    expect(iconTitle('arrow-right')).toBe('Arrow right')
    expect(iconTitle('fr-4x3')).toBe('Fr 4x3')
    expect(iconTitle('a_b')).toBe('A b')
  })
})

describe('licences', () => {
  it('leaves out copyleft and non-commercial sets, keeps the rest', () => {
    for (const bad of ['GPL-2.0-only', 'GPL-3.0-or-later', 'AGPL-3.0', 'LGPL-2.1', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0']) expect(isUsableLicense(bad), bad).toBe(false)
    for (const good of ['MIT', 'Apache-2.0', 'ISC', 'OFL-1.1', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MPL-2.0', 'Unlicense', 'BSD-3-Clause']) expect(isUsableLicense(good), good).toBe(true)
  })

  it('asks for credit only under Creative Commons Attribution', () => {
    expect(needsCredit('CC-BY-4.0')).toBe(true)
    expect(needsCredit('CC-BY-SA-3.0')).toBe(true)
    expect(needsCredit('MIT')).toBe(false)
    expect(needsCredit('CC0-1.0')).toBe(false)
  })
})

describe('icon styles and groups', () => {
  it('tells line, solid and colour icons apart from their markup', () => {
    expect(iconStyleOf('<path fill="none" stroke="currentColor" stroke-width="2" d="M0 0"/>', false)).toBe('line')
    expect(iconStyleOf('<g fill="none" stroke="currentColor"><path d="M0 0"/></g>', false)).toBe('line')
    expect(iconStyleOf('<path fill="currentColor" d="M0 0h4v4z"/>', false)).toBe('solid')
    expect(iconStyleOf('<path d="M0 0h4v4z"/>', false)).toBe('solid')
    expect(iconStyleOf('<path fill="currentColor" d="M0 0"/><path stroke="currentColor" d="M1 1"/>', false)).toBe('solid')
    expect(iconStyleOf('<path fill="#f00" d="M0 0"/>', true)).toBe('color')
  })

  it('folds Iconify categories into a few groups', () => {
    expect(iconGroup('UI 24px')).toBe('Interface')
    expect(iconGroup('UI Multicolor')).toBe('Interface')
    expect(iconGroup('Material')).toBe('Material')
    expect(iconGroup('Archive / Unmaintained')).toBe('Archive')
    expect(iconGroup('Flags / Maps')).toBe('Flags and maps')
    expect(iconGroup('whatever')).toBe('Other')
  })
})

describe('iconSvg', () => {
  const data = { body: '<path fill="currentColor" d="M0 0h8v8z"/>', width: 24, height: 12, left: 0, top: 0 }

  it('builds a standalone picture with the icon box as its viewBox, scaled to the size', () => {
    const svg = iconSvg(data, { size: 48 })
    expect(svg).toContain('viewBox="0 0 24 12"')
    expect(svg).toContain('width="48"')
    expect(svg).toContain('height="24"')
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
  })

  it('replaces currentColor with a colour', () => {
    expect(iconSvg(data, { color: '#ff0000' })).toContain('fill="#ff0000"')
    expect(iconSvg(data)).toContain('fill="currentColor"')
  })
})
