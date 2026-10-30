import { findAnimationPreset } from './animationPresets'
import { findEffectDef, type EffectDomain } from './effects'
import data from './looks.json'

// AtomCut's 103 text looks ("templates"), as data with the owner's reported
// permission (see docs/research/atomcut-inspiration.md). A look is a finished
// text style: type, effects, an entrance, a typing sound, and for captions
// the look of the word being spoken. layer.create {template} and
// template.apply turn one into layer data.

/** The pill behind text, with palette references for its colour. */
interface LookHighlight {
  color: string
  radius: number
  paddingX: number
  paddingY: number
}

export interface TextLook {
  id: string
  name: string
  category: string
  tags: string[]
  tagline: string
  sampleText: string
  palette: { ink: string; accent: string; shade: string }
  style: {
    fontFamily: string
    fontSize: number
    fontWeight?: number
    letterSpacing?: number
    lineHeight?: number
    align?: 'left' | 'center' | 'right'
    italic?: boolean
    decoration?: 'none' | 'underline' | 'strikethrough'
    textCase?: 'none' | 'upper' | 'lower' | 'title'
    opacity?: number
    highlight?: LookHighlight
    color: string
    textEffects?: Record<string, unknown>[]
  }
  effects?: Record<string, unknown>[]
  animations?: { in?: { preset: string; [field: string]: unknown } | null; out?: unknown }
  sound?: { pack: string; volume?: number }
  /** How the word being spoken looks in a caption: style props (AtomCut's names, palette references allowed) and a scale. */
  focus?: { props?: Record<string, unknown>; scale?: number }
}

export const TEXT_LOOKS = data.textLooks as unknown as readonly TextLook[]

/** A look by its id, or by its name (any case). */
export function findLook(ref: string): TextLook | undefined {
  const wanted = ref.trim().toLowerCase()
  return TEXT_LOOKS.find((l) => l.id === ref) ?? TEXT_LOOKS.find((l) => l.id.toLowerCase() === wanted || l.name.toLowerCase() === wanted)
}

/** A palette reference such as "@ink", or "@shade/70" (70 % alpha), resolved to its colour. */
function paletteColor(look: TextLook, value: string | undefined): string {
  if (!value) return look.palette.ink
  if (!value.startsWith('@')) return value
  const [name = '', percent] = value.slice(1).split('/')
  const base = (look.palette[name as keyof TextLook['palette']] ?? look.palette.ink).slice(0, 7)
  if (percent === undefined) return base
  return base + Math.round((Number(percent) / 100) * 255).toString(16).padStart(2, '0')
}

/**
 * A look's effect cards for layer.create, colours resolved; "@text" takes
 * each glyph's own colour. Cards this editor cannot draw are left out.
 */
function lookEffects(look: TextLook, domain: EffectDomain): Record<string, unknown>[] {
  const cards = (domain === 'text' ? look.style.textEffects : look.effects) ?? []
  return cards
    .filter((card) => typeof card.type === 'string' && findEffectDef(domain, card.type) !== undefined)
    .map((card) => {
      const color = card.color
      if (typeof color !== 'string') return card
      if (color === '@text') {
        const { color: _, ...rest } = card
        return { ...rest, source: 'text' }
      }
      return { ...card, color: paletteColor(look, color), ...(domain === 'text' ? { source: 'custom' } : {}) }
    })
}

const highlightOf = (look: TextLook, h: LookHighlight) => ({ color: paletteColor(look, h.color), radius: h.radius, paddingX: h.paddingX, paddingY: h.paddingY })

/** The look's typing sound as a voice for a layer's sounds stack, without an id; fired by each unit of the entrance. */
export function lookSound(look: TextLook): Record<string, unknown> | null {
  return look.sound ? { pack: look.sound.pack, volume: look.sound.volume ?? 0.3, trigger: { kind: 'text' }, phase: 'in' } : null
}

/** The text style fields of a look: all of them, with the look's colours resolved. */
export function lookStyle(look: TextLook): Record<string, unknown> {
  const { style } = look
  const textEffects = lookEffects(look, 'text')
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: Math.min(900, Math.max(100, Math.round((style.fontWeight ?? 400) / 100) * 100)),
    letterSpacing: style.letterSpacing ?? 0,
    ...(style.lineHeight ? { lineHeight: style.lineHeight } : {}),
    ...(style.align ? { align: style.align } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.decoration && style.decoration !== 'none' ? { decoration: style.decoration } : {}),
    ...(style.textCase && style.textCase !== 'none' ? { textCase: style.textCase } : {}),
    ...(style.highlight ? { highlight: highlightOf(look, style.highlight) } : {}),
    color: paletteColor(look, style.color),
    ...(textEffects.length > 0 ? { textEffects } : {}),
  }
}

/** The layer.create input for a text look (the fields our text layers have). */
export function lookLayerInput(look: TextLook) {
  const effects = lookEffects(look, 'layer')
  const sound = lookSound(look)
  return {
    kind: 'text',
    name: look.name,
    text: look.sampleText,
    style: lookStyle(look),
    ...(look.style.opacity !== undefined && look.style.opacity < 1 ? { transform: { opacity: look.style.opacity } } : {}),
    ...(effects.length > 0 ? { effects } : {}),
    ...(sound ? { sounds: [sound] } : {}),
  }
}

/** The animation.set input that gives a look's entrance to layer `id` (which may be a batch reference such as "$0.id"), or null when it has none. */
export function lookAnimationInput(look: TextLook, id: string): Record<string, unknown> | null {
  const intro = look.animations?.in
  if (!intro) return null
  // A preset that moves the whole layer has no units to stagger: those fields are for text.
  if (findAnimationPreset(intro.preset)?.scope === 'layer') {
    const { unit: _unit, staggerMs: _stagger, delayMs: _delay, jitterMs: _jitter, scatterPx: _px, scatterDeg: _deg, ...whole } = intro
    return { id, slot: 'in', target: 'layer', ...whole }
  }
  return { id, slot: 'in', ...intro }
}

/** How a look wants the spoken word of a caption: a caption state ({style, scale}), or null when it says nothing about it. */
export function lookCaptionFocus(look: TextLook): { style: Record<string, unknown>; scale: number } | null {
  if (!look.focus) return null
  const style: Record<string, unknown> = {}
  const highlight: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(look.focus.props ?? {})) {
    if (key.startsWith('highlight.')) highlight[key.slice(10)] = typeof value === 'string' ? paletteColor(look, value) : value
    else style[key] = typeof value === 'string' && value.startsWith('@') ? paletteColor(look, value) : value
  }
  if (Object.keys(highlight).length > 0) style.highlight = { radius: 8, paddingX: 10, paddingY: 4, color: paletteColor(look, '@accent'), ...highlight }
  return { style, scale: look.focus.scale ?? 1 }
}
