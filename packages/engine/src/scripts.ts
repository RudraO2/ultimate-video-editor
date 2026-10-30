// Indian scripts and the type that has them. A text in Devanagari or Tamil
// drawn in a Latin family (Inter, a display face) would fall back to whatever
// the system has, which differs per machine and may lack conjuncts. So each
// script names a Google Noto family (SIL Open Font License) that text in it
// falls back to: the layer's own family still draws the Latin letters and
// digits, and the script's family the rest.

export interface ScriptFont {
  script: string
  /** The Google Fonts family text in this script falls back to. */
  family: string
  /** A few letters, so a web font loads the part of its file that has them. */
  sample: string
  test: RegExp
}

export const SCRIPT_FONTS: readonly ScriptFont[] = [
  { script: 'Devanagari', family: 'Noto Sans Devanagari', sample: 'अआकखगक्षत्रहिंदी', test: /[ऀ-ॿ꣠-ꣿ]/ },
  { script: 'Bengali', family: 'Noto Sans Bengali', sample: 'অআকখগবাংলা', test: /[ঀ-৿]/ },
  { script: 'Gurmukhi', family: 'Noto Sans Gurmukhi', sample: 'ਅਆਕਖਗਪੰਜਾਬੀ', test: /[਀-੿]/ },
  { script: 'Gujarati', family: 'Noto Sans Gujarati', sample: 'અઆકખગગુજરાતી', test: /[઀-૿]/ },
  { script: 'Oriya', family: 'Noto Sans Oriya', sample: 'ଅଆକଖଗଓଡ଼ିଆ', test: /[଀-୿]/ },
  { script: 'Tamil', family: 'Noto Sans Tamil', sample: 'அஆகஙசதமிழ்', test: /[஀-௿]/ },
  { script: 'Telugu', family: 'Noto Sans Telugu', sample: 'అఆకఖగతెలుగు', test: /[ఀ-౿]/ },
  { script: 'Kannada', family: 'Noto Sans Kannada', sample: 'ಅಆಕಖಗಕನ್ನಡ', test: /[ಀ-೿]/ },
  { script: 'Malayalam', family: 'Noto Sans Malayalam', sample: 'അആകഖഗമലയാളം', test: /[ഀ-ൿ]/ },
]

/** The script fonts a text needs, in the order above. */
export function scriptFontsOf(text: string): ScriptFont[] {
  return SCRIPT_FONTS.filter((s) => s.test.test(text))
}

/** Letters of every script, for loading a font list with its fallbacks: only the families in the list load. */
export const FONT_PROBE_TEXT = 'Hg ' + SCRIPT_FONTS.map((s) => s.sample).join(' ')
