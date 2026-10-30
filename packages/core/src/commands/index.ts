import { CommandRegistry } from '../registry'
import { animationSet } from './animation'
import { layersCopy, layersDuplicate, layersRestack } from './arrange'
import { apiBatch } from './batch'
import { scriptList, scriptRead, scriptRemove, scriptRun, scriptSave } from './script'
import { captionSet } from './caption'
import { effectsAdd, effectsUpdate } from './effects'
import { fontsAdd, fontsRemove } from './fonts'
import { layersMakeUnique, layersNest } from './nest'
import { frameCreate, frameDelete, frameDuplicate, frameUpdate, pageCreate, pageDelete, pageUpdate } from './frame'
import { projectUpdate } from './comp'
import { behaviorsAdd, behaviorsInspect, behaviorsRemove, behaviorsUpdate } from './behaviors'
import { rigBind, rigBone, rigCreate, rigInspect, rigPose } from './rig'
import { switchCreate, switchShow } from './switch'
import { characterBringToLife, characterDetect } from './character'
import { physicsBody, physicsForce, physicsJoint, physicsScene } from './physics'
import { layersGroup, layersUngroup, layoutSet } from './group'
import { keyframesClear, keyframesInspect, keyframesRemove, keyframesSet, keyframesSimplify } from './keyframes'
import { layerCreate, layerPatch, layerSet, layersDelete } from './layer'
import { templateApply } from './template'
import { soundCategory } from './sound'
import { svgPlace } from './svg'
import { textSet, textStyle } from './text'
import { mediaAdd, mediaEnvelope, mediaList, mediaRemove, mediaSpeech } from './media'
import { motionEdit } from './motion'
import { keyframesSmooth } from './smooth'
import { apiDescribe, docOverview, layerGet, layerProperties, layersList } from './read'
import { timelineCloseGaps, timelineCompact, timelineCutRanges } from './ripple'
import { timelineInsertTime } from './insertTime'
import { timelineMove, timelineSplit, timelineTrim } from './timeline'
import { transitionAdd, transitionRemove } from './transition'
import { trackCreate, trackDelete, trackUpdate } from './track'
import { worldCreate, worldInspect } from './world'
import { worldAdd, worldCamera } from './worldAdd'
import { worldLook, worldMaterial } from './worldLook'
import { worldMoveInto } from './worldMove'
import { worldExtrude } from './worldExtrude'
import { worldTrack } from './worldTrack'

/** The built-in command set every session starts with. */
export const CORE_COMMANDS = [
  docOverview,
  layersList,
  layerGet,
  layerProperties,
  mediaList,
  apiDescribe,
  frameCreate,
  frameUpdate,
  frameDelete,
  frameDuplicate,
  pageCreate,
  pageUpdate,
  pageDelete,
  projectUpdate,
  mediaAdd,
  mediaRemove,
  fontsAdd,
  fontsRemove,
  svgPlace,
  trackCreate,
  trackDelete,
  trackUpdate,
  layerCreate,
  layerSet,
  layerPatch,
  layersDelete,
  layersDuplicate,
  layersCopy,
  layersRestack,
  layersNest,
  layersMakeUnique,
  layersGroup,
  layersUngroup,
  layoutSet,
  textSet,
  textStyle,
  templateApply,
  captionSet,
  keyframesSet,
  keyframesRemove,
  keyframesClear,
  keyframesInspect,
  keyframesSimplify,
  keyframesSmooth,
  motionEdit,
  animationSet,
  effectsAdd,
  effectsUpdate,
  timelineMove,
  timelineTrim,
  timelineSplit,
  timelineCloseGaps,
  timelineCompact,
  timelineCutRanges,
  timelineInsertTime,
  transitionAdd,
  transitionRemove,
  soundCategory,
  physicsScene,
  physicsBody,
  physicsForce,
  physicsJoint,
  switchCreate,
  switchShow,
  rigCreate,
  rigBone,
  rigPose,
  rigBind,
  rigInspect,
  behaviorsAdd,
  behaviorsUpdate,
  behaviorsRemove,
  behaviorsInspect,
  characterDetect,
  characterBringToLife,
  worldCreate,
  worldInspect,
  worldAdd,
  worldCamera,
  worldMaterial,
  worldExtrude,
  worldLook,
  worldMoveInto,
  worldTrack,
  apiBatch,
  scriptRun,
  mediaEnvelope,
  mediaSpeech,
  scriptSave,
  scriptList,
  scriptRead,
  scriptRemove,
] as const

export function createCoreRegistry(): CommandRegistry {
  const registry = new CommandRegistry()
  for (const def of CORE_COMMANDS) registry.register(def)
  return registry
}
