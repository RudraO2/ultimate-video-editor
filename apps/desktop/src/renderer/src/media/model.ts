import { modelFormatOf, probeModel } from '@uve/engine'

// Reading a model file for the library. The engine reaches model files through
// the granted-media scheme (`configureModels` in main.tsx).

/** The format of a model file by its name; null when it is not one. */
export const modelFormatOfName = modelFormatOf

/** A model file's format, clips and size; rejects with a message fit to show the user. */
export const probeModelFile = probeModel
