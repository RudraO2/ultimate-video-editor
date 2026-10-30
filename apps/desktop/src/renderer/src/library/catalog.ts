import { ANIMATION_PRESETS, TRANSITION_PRESETS } from '@uve/core'

// AtomCut's preset catalog, as data with the owner's reported permission (see
// docs/research/atomcut-inspiration.md). The 103 text looks (templates), the
// 44 animation presets and the 23 transitions all live in @uve/core
// (looks.ts, animationPresets.ts, transitions.ts), where their commands apply
// them: this file only gives the panels their names.

export { findLook, lookAnimationInput, lookLayerInput, TEXT_LOOKS, type TextLook } from '@uve/core'

export const ANIMATIONS = ANIMATION_PRESETS
export const TRANSITIONS = TRANSITION_PRESETS
