// The app's icons: Phosphor (MIT, https://phosphoricons.com), regular weight,
// under the names the components already use. A filled icon (`fill` set, as
// on Play or a keyframe diamond) takes Phosphor's fill weight. `strokeWidth`
// is accepted and ignored: Phosphor draws each weight at its own line width.

import {
  AlignBottom as PhAlignBottom,
  AlignCenterVertical as PhAlignCenterVertical,
  AlignTop as PhAlignTop,
  ArrowDown as PhArrowDown,
  ArrowLeft as PhArrowLeft,
  ArrowLineLeft as PhArrowLineLeft,
  ArrowLineRight as PhArrowLineRight,
  ArrowUUpLeft as PhArrowUUpLeft,
  ArrowUUpRight as PhArrowUUpRight,
  ArrowUp as PhArrowUp,
  ArrowsHorizontal as PhArrowsHorizontal,
  ArrowsLeftRight as PhArrowsLeftRight,
  ArrowsOutSimple as PhArrowsOutSimple,
  BezierCurve as PhBezierCurve,
  Books as PhBooks,
  Brain as PhBrain,
  CaretDown as PhCaretDown,
  CaretRight as PhCaretRight,
  ChatCircle as PhChatCircle,
  Check as PhCheck,
  CheckCircle as PhCheckCircle,
  Circle as PhCircle,
  CircleNotch as PhCircleNotch,
  Clock as PhClock,
  CodeBlock as PhCodeBlock,
  Copy as PhCopy,
  CopySimple as PhCopySimple,
  CornersOut as PhCornersOut,
  Cube as PhCube,
  CubeFocus as PhCubeFocus,
  Cursor as PhCursor,
  Diamond as PhDiamond,
  DownloadSimple as PhDownloadSimple,
  Eraser as PhEraser,
  Eye as PhEye,
  EyeSlash as PhEyeSlash,
  FilePlus as PhFilePlus,
  FileText as PhFileText,
  FilmSlate as PhFilmSlate,
  FilmStrip as PhFilmStrip,
  FolderOpen as PhFolderOpen,
  FrameCorners as PhFrameCorners,
  GridNine as PhGridNine,
  Hand as PhHand,
  HardDrive as PhHardDrive,
  Headphones as PhHeadphones,
  Image as PhImage,
  Lightbulb as PhLightbulb,
  LinkSimple as PhLinkSimple,
  LinkSimpleBreak as PhLinkSimpleBreak,
  List as PhList,
  ListDashes as PhListDashes,
  Lock as PhLock,
  LockOpen as PhLockOpen,
  MagicWand as PhMagicWand,
  Magnet as PhMagnet,
  MagnifyingGlass as PhMagnifyingGlass,
  Microphone as PhMicrophone,
  MicrophoneSlash as PhMicrophoneSlash,
  Minus as PhMinus,
  MusicNotes as PhMusicNotes,
  NotePencil as PhNotePencil,
  Palette as PhPalette,
  Path as PhPath,
  Pause as PhPause,
  PenNib as PhPenNib,
  Play as PhPlay,
  Plug as PhPlug,
  Plus as PhPlus,
  PuzzlePiece as PhPuzzlePiece,
  Record as PhRecord,
  Repeat as PhRepeat,
  Robot as PhRobot,
  RowsPlusTop as PhRowsPlusTop,
  Scan as PhScan,
  Scissors as PhScissors,
  Selection as PhSelection,
  SelectionPlus as PhSelectionPlus,
  SelectionSlash as PhSelectionSlash,
  Shapes as PhShapes,
  Shuffle as PhShuffle,
  SkipBack as PhSkipBack,
  SlidersHorizontal as PhSlidersHorizontal,
  Sparkle as PhSparkle,
  SpeakerHigh as PhSpeakerHigh,
  SpeakerX as PhSpeakerX,
  Square as PhSquare,
  SquareSplitVertical as PhSquareSplitVertical,
  SquaresFour as PhSquaresFour,
  Stack as PhStack,
  StackMinus as PhStackMinus,
  StackPlus as PhStackPlus,
  Star as PhStar,
  Sticker as PhSticker,
  TextAUnderline as PhTextAUnderline,
  TextAa as PhTextAa,
  TextAlignCenter as PhTextAlignCenter,
  TextAlignJustify as PhTextAlignJustify,
  TextAlignLeft as PhTextAlignLeft,
  TextAlignRight as PhTextAlignRight,
  TextB as PhTextB,
  TextItalic as PhTextItalic,
  TextStrikethrough as PhTextStrikethrough,
  TextT as PhTextT,
  TextUnderline as PhTextUnderline,
  Trash as PhTrash,
  TreeStructure as PhTreeStructure,
  UploadSimple as PhUploadSimple,
  VideoCamera as PhVideoCamera,
  WarningCircle as PhWarningCircle,
  Waveform as PhWaveform,
  X as PhX,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react'
import type { ComponentType, SVGProps } from 'react'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  size?: number | string
  strokeWidth?: number | string
}

export type IconComponent = ComponentType<IconProps>

function icon(Phosphor: PhosphorIcon, name: string): IconComponent {
  const Adapted = ({ size = 24, strokeWidth: _strokeWidth, fill, ...rest }: IconProps) => (
    <Phosphor size={size} weight={fill && fill !== 'none' ? 'fill' : 'regular'} {...rest} />
  )
  Adapted.displayName = name
  return Adapted
}

/** Text size. */
export const ALargeSmall = icon(PhTextAa, 'ALargeSmall')
/** Align text centre. */
export const AlignCenter = icon(PhTextAlignCenter, 'AlignCenter')
/** Justify text. */
export const AlignJustify = icon(PhTextAlignJustify, 'AlignJustify')
/** Align text left. */
export const AlignLeft = icon(PhTextAlignLeft, 'AlignLeft')
/** Align text right. */
export const AlignRight = icon(PhTextAlignRight, 'AlignRight')
/** Text box: middle. */
export const AlignVerticalJustifyCenter = icon(PhAlignCenterVertical, 'AlignVerticalJustifyCenter')
/** Text box: bottom. */
export const AlignVerticalJustifyEnd = icon(PhAlignBottom, 'AlignVerticalJustifyEnd')
/** Text box: top. */
export const AlignVerticalJustifyStart = icon(PhAlignTop, 'AlignVerticalJustifyStart')
/** Move down. */
export const ArrowDown = icon(PhArrowDown, 'ArrowDown')
/** Back. */
export const ArrowLeft = icon(PhArrowLeft, 'ArrowLeft')
/** Transitions. */
export const ArrowLeftRight = icon(PhArrowsLeftRight, 'ArrowLeftRight')
/** Close gaps (ripple left). */
export const ArrowLeftToLine = icon(PhArrowLineLeft, 'ArrowLeftToLine')
/** Animation out. */
export const ArrowRightFromLine = icon(PhArrowLineRight, 'ArrowRightFromLine')
/** Animation in. */
export const ArrowRightToLine = icon(PhArrowLineRight, 'ArrowRightToLine')
/** Send / move up. */
export const ArrowUp = icon(PhArrowUp, 'ArrowUp')
/** Voice, sound level. */
export const AudioLines = icon(PhWaveform, 'AudioLines')
/** Insert time. */
export const BetweenHorizontalStart = icon(PhRowsPlusTop, 'BetweenHorizontalStart')
/** Bold. */
export const Bold = icon(PhTextB, 'Bold')
/** Agent. */
export const Bot = icon(PhRobot, 'Bot')
/** 3D / world. */
export const Box = icon(PhCube, 'Box')
/** Thinking. */
export const Brain = icon(PhBrain, 'Brain')
/** Bring to front. */
export const BringToFront = icon(PhStackPlus, 'BringToFront')
/** Camera layer. */
export const Camera = icon(PhVideoCamera, 'Camera')
/** Lowercase. */
export const CaseLower = icon(PhTextAa, 'CaseLower')
/** As typed. */
export const CaseSensitive = icon(PhTextAa, 'CaseSensitive')
/** Uppercase. */
export const CaseUpper = icon(PhTextAUnderline, 'CaseUpper')
/** Done / chosen. */
export const Check = icon(PhCheck, 'Check')
/** Open / dropdown. */
export const ChevronDown = icon(PhCaretDown, 'ChevronDown')
/** Closed / more. */
export const ChevronRight = icon(PhCaretRight, 'ChevronRight')
/** Ellipse / record. */
export const Circle = icon(PhCircle, 'Circle')
/** Error / warning. */
export const CircleAlert = icon(PhWarningCircle, 'CircleAlert')
/** Success. */
export const CircleCheck = icon(PhCheckCircle, 'CircleCheck')
/** Live / recording. */
export const CircleDot = icon(PhRecord, 'CircleDot')
/** App logo. */
export const Clapperboard = icon(PhFilmSlate, 'Clapperboard')
/** Recent. */
export const Clock = icon(PhClock, 'Clock')
/** Copy. */
export const Copy = icon(PhCopy, 'Copy')
/** Duplicate. */
export const CopyPlus = icon(PhCopySimple, 'CopyPlus')
/** Keyframe. */
export const Diamond = icon(PhDiamond, 'Diamond')
/** Export. */
export const Download = icon(PhDownloadSimple, 'Download')
/** Clear log. */
export const Eraser = icon(PhEraser, 'Eraser')
/** Visible. */
export const Eye = icon(PhEye, 'Eye')
/** Hidden. */
export const EyeOff = icon(PhEyeSlash, 'EyeOff')
/** New script. */
export const FilePlus2 = icon(PhFilePlus, 'FilePlus2')
/** Page / document. */
export const FileText = icon(PhFileText, 'FileText')
/** Video layer. */
export const Film = icon(PhFilmStrip, 'Film')
/** Show in folder. */
export const FolderOpen = icon(PhFolderOpen, 'FolderOpen')
/** Frame. */
export const Frame = icon(PhFrameCorners, 'Frame')
/** Grid. */
export const Grid3x3 = icon(PhGridNine, 'Grid3x3')
/** Group. */
export const Group = icon(PhSelectionPlus, 'Group')
/** Pan tool. */
export const Hand = icon(PhHand, 'Hand')
/** Installed fonts. */
export const HardDrive = icon(PhHardDrive, 'HardDrive')
/** Solo / listen. */
export const Headphones = icon(PhHeadphones, 'Headphones')
/** Image / Media. */
export const Image = icon(PhImage, 'Image')
/** Italic. */
export const Italic = icon(PhTextItalic, 'Italic')
/** Layers. */
export const Layers = icon(PhStack, 'Layers')
/** Grid view. */
export const LayoutGrid = icon(PhSquaresFour, 'LayoutGrid')
/** Library. */
export const LibraryBig = icon(PhBooks, 'LibraryBig')
/** Light (3D). */
export const Lightbulb = icon(PhLightbulb, 'Lightbulb')
/** Linked scale. */
export const Link2 = icon(PhLinkSimple, 'Link2')
/** Simplify keys. */
export const ListMinus = icon(PhListDashes, 'ListMinus')
/** Working. */
export const LoaderCircle = icon(PhCircleNotch, 'LoaderCircle')
/** Locked. */
export const Lock = icon(PhLock, 'Lock')
/** Unlocked. */
export const LockOpen = icon(PhLockOpen, 'LockOpen')
/** Snapping. */
export const Magnet = icon(PhMagnet, 'Magnet')
/** Full screen. */
export const Maximize = icon(PhCornersOut, 'Maximize')
/** Fit timeline. */
export const Maximize2 = icon(PhArrowsOutSimple, 'Maximize2')
/** Main menu. */
export const Menu = icon(PhList, 'Menu')
/** Chat. */
export const MessageCircle = icon(PhChatCircle, 'MessageCircle')
/** Speak. */
export const Mic = icon(PhMicrophone, 'Mic')
/** Stop speaking. */
export const MicOff = icon(PhMicrophoneSlash, 'MicOff')
/** Zoom out / remove. */
export const Minus = icon(PhMinus, 'Minus')
/** Select tool. */
export const MousePointer2 = icon(PhCursor, 'MousePointer2')
/** 3D move. */
export const Move3d = icon(PhCubeFocus, 'Move3d')
/** Letter spacing. */
export const MoveHorizontal = icon(PhArrowsHorizontal, 'MoveHorizontal')
/** Music / sound. */
export const Music = icon(PhMusicNotes, 'Music')
/** Nodes view. */
export const Network = icon(PhTreeStructure, 'Network')
/** Colour view. */
export const Palette = icon(PhPalette, 'Palette')
/** Timeline view. */
export const PanelBottom = icon(PhSquareSplitVertical, 'PanelBottom')
/** Pause. */
export const Pause = icon(PhPause, 'Pause')
/** Pen tool / path. */
export const PenTool = icon(PhPenNib, 'PenTool')
/** Play. */
export const Play = icon(PhPlay, 'Play')
/** Connect agent. */
export const Plug = icon(PhPlug, 'Plug')
/** Add. */
export const Plus = icon(PhPlus, 'Plus')
/** Plugins. */
export const Puzzle = icon(PhPuzzlePiece, 'Puzzle')
/** Redo. */
export const Redo2 = icon(PhArrowUUpRight, 'Redo2')
/** Loop. */
export const Repeat = icon(PhRepeat, 'Repeat')
/** Analyse footage. */
export const ScanSearch = icon(PhScan, 'ScanSearch')
/** Split / cut. */
export const Scissors = icon(PhScissors, 'Scissors')
/** Search. */
export const Search = icon(PhMagnifyingGlass, 'Search')
/** Send to back. */
export const SendToBack = icon(PhStackMinus, 'SendToBack')
/** Shapes / icons. */
export const Shapes = icon(PhShapes, 'Shapes')
/** Pick another. */
export const Shuffle = icon(PhShuffle, 'Shuffle')
/** Go to start. */
export const SkipBack = icon(PhSkipBack, 'SkipBack')
/** Advanced mode / Design / settings. */
export const SlidersHorizontal = icon(PhSlidersHorizontal, 'SlidersHorizontal')
/** Effects / Animations / Agents. */
export const Sparkles = icon(PhSparkle, 'Sparkles')
/** Curves / Animate. */
export const Spline = icon(PhBezierCurve, 'Spline')
/** Rectangle / stop. */
export const Square = icon(PhSquare, 'Square')
/** Scripts. */
export const SquareCode = icon(PhCodeBlock, 'SquareCode')
/** Empty layer. */
export const SquareDashed = icon(PhSelection, 'SquareDashed')
/** New chat. */
export const SquarePen = icon(PhNotePencil, 'SquarePen')
/** Favourite. */
export const Star = icon(PhStar, 'Star')
/** Stickers. */
export const Sticker = icon(PhSticker, 'Sticker')
/** Strikethrough. */
export const Strikethrough = icon(PhTextStrikethrough, 'Strikethrough')
/** Delete. */
export const Trash2 = icon(PhTrash, 'Trash2')
/** Text. */
export const Type = icon(PhTextT, 'Type')
/** Underline. */
export const Underline = icon(PhTextUnderline, 'Underline')
/** Undo. */
export const Undo2 = icon(PhArrowUUpLeft, 'Undo2')
/** Ungroup. */
export const Ungroup = icon(PhSelectionSlash, 'Ungroup')
/** Unlinked scale. */
export const Unlink2 = icon(PhLinkSimpleBreak, 'Unlink2')
/** Add font file. */
export const Upload = icon(PhUploadSimple, 'Upload')
/** Sound on / Sound tab. */
export const Volume2 = icon(PhSpeakerHigh, 'Volume2')
/** Muted. */
export const VolumeX = icon(PhSpeakerX, 'VolumeX')
/** Easy mode. */
export const Wand2 = icon(PhMagicWand, 'Wand2')
/** Animate tab. */
export const Waypoints = icon(PhPath, 'Waypoints')
/** Wrap text. */
export const WrapText = icon(PhTextAlignLeft, 'WrapText')
/** Close / remove. */
export const X = icon(PhX, 'X')
