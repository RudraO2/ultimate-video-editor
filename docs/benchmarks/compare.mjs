// Side-by-side judge: two videos (a reference and ours) to one contact sheet and one sound table.
//
//   node docs/benchmarks/compare.mjs --a <reference.mp4> --b <ours.mp4> --out <folder>
//        [--labels "AtomCut,Ours"] [--count 12] [--a-words a.json] [--b-words b.json]
//        [--a-times 1.5,9,…] [--b-times 1.2,8,…]
//
// The sheet pairs frame i of A with frame i of B, at the same fraction of each video (the two cuts
// may differ in length), or at the shot times given with --a-times and --b-times (seconds, same
// count each). The sound table gives, per video, integrated loudness, true peak and loudness range
// (ffmpeg ebur128), and, when word times are given (transcribe.py's JSON: segments with
// `words: [[word, start, end]]`), the median momentary loudness while someone speaks against the
// median in pauses of 400 ms or more: how far the voice stands above the bed. A mix cannot be
// unmixed, so this contrast is the measurable trace of ducking. Writes compare.png and compare.md.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : [])),
)
if (!args.a || !args.b || !args.out) {
  console.error('usage: node compare.mjs --a <reference> --b <ours> --out <folder> [--labels A,B] [--count 12] [--a-words f] [--b-words f] [--a-times …] [--b-times …]')
  process.exit(1)
}
const out = resolve(args.out)
mkdirSync(out, { recursive: true })
const [labelA, labelB] = (args.labels ?? 'Reference,Ours').split(',')
// Tiles follow the reference's shape: landscape 480×270, four to a row; portrait 240×427, eight to a row.
const [srcW, srcH] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', args.a], { encoding: 'utf8' }).trim().split(',').map(Number)
const portrait = srcH > srcW
const W = portrait ? 240 : 480
const H = portrait ? 427 : 270
const perRow = portrait ? 8 : 4

const duration = (file) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }))

function times(file, list, count) {
  if (list) return list.split(',').map(Number)
  const d = duration(file)
  return Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * d)
}

const count = Number(args.count ?? 12)
const tA = times(args.a, args['a-times'], count)
const tB = times(args.b, args['b-times'], count)
if (tA.length !== tB.length) throw new Error('--a-times and --b-times need the same count')

// One still per time, letterboxed to W×H so both videos tile alike whatever their size.
function still(file, t, path) {
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', fit, path])
  return path
}
const frames = tA.flatMap((t, i) => [still(args.a, t, join(out, `_a${i}.png`)), still(args.b, tB[i], join(out, `_b${i}.png`))])

// Pairs side by side (A B │ A B …), read left to right, top to bottom.
const layout = frames.map((_, i) => `${(i % perRow) * W}_${Math.floor(i / perRow) * H}`).join('|')
const sheet = join(out, 'compare.png')
execFileSync('ffmpeg', [
  '-loglevel', 'error', '-y',
  ...frames.flatMap((f) => ['-i', f]),
  '-filter_complex', `${frames.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${frames.length}:layout=${layout}:fill=black`,
  '-frames:v', '1', sheet,
])

// ebur128 prints a momentary value every 100 ms and a summary at the end.
function measure(file) {
  const r = spawn(file)
  const summary = r.slice(r.lastIndexOf('Summary:'))
  const num = (re) => Number(summary.match(re)?.[1])
  const momentary = [...r.matchAll(/t:\s*([\d.]+)\s+TARGET:[^M]*M:\s*(-?[\d.]+|-inf)/g)].map((m) => [Number(m[1]), m[2] === '-inf' ? -120 : Number(m[2])])
  return {
    integratedLufs: num(/I:\s*(-?[\d.]+) LUFS/),
    truePeakDbtp: num(/Peak:\s*(-?[\d.]+) dBFS/),
    lraLu: num(/LRA:\s*(-?[\d.]+) LU/),
    momentary,
  }
}
function spawn(file) {
  // ffmpeg writes the ebur128 log to stderr.
  const run = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return run.stderr
}

const median = (xs) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// Momentary loudness (a 400 ms window, stamped at its end) while words are spoken, against pauses.
function voiceContrast(m, wordsFile) {
  if (!wordsFile || !existsSync(wordsFile)) return null
  const words = JSON.parse(readFileSync(wordsFile, 'utf8')).flatMap((s) => s.words ?? []).map(([, s, e]) => [s, e])
  const inWord = (t) => words.some(([s, e]) => t >= s && t <= e)
  const gaps = []
  for (let i = 1; i < words.length; i++) if (words[i][0] - words[i - 1][1] >= 0.4) gaps.push([words[i - 1][1] + 0.1, words[i][0] - 0.05])
  const inGap = (t) => gaps.some(([s, e]) => t - 0.4 >= s && t <= e)
  const speech = m.filter(([t]) => inWord(t - 0.2)).map(([, v]) => v)
  const pause = m.filter(([t]) => inGap(t)).map(([, v]) => v).filter((v) => v > -70)
  const sp = median(speech)
  const pa = median(pause)
  return { speechLufs: sp, pauseLufs: pa, contrastDb: sp - pa, pauses: gaps.length }
}

const a = measure(args.a)
const b = measure(args.b)
const ca = voiceContrast(a.momentary, args['a-words'])
const cb = voiceContrast(b.momentary, args['b-words'])
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–')

const rows = [
  ['Length', `${duration(args.a).toFixed(1)} s`, `${duration(args.b).toFixed(1)} s`],
  ['Integrated loudness', `${f1(a.integratedLufs)} LUFS`, `${f1(b.integratedLufs)} LUFS`],
  ['True peak', `${f1(a.truePeakDbtp)} dBTP`, `${f1(b.truePeakDbtp)} dBTP`],
  ['Loudness range', `${f1(a.lraLu)} LU`, `${f1(b.lraLu)} LU`],
]
if (ca || cb) {
  rows.push(['Median momentary while speaking', `${f1(ca?.speechLufs)} LUFS`, `${f1(cb?.speechLufs)} LUFS`])
  rows.push(['Median momentary in pauses (bed and effects)', `${f1(ca?.pauseLufs)} LUFS (${ca?.pauses ?? 0} pauses)`, `${f1(cb?.pauseLufs)} LUFS (${cb?.pauses ?? 0} pauses)`])
  rows.push(['Voice over bed', `${f1(ca?.contrastDb)} dB`, `${f1(cb?.contrastDb)} dB`])
}
const md = [
  `# ${labelA} against ${labelB}`,
  '',
  `Sheet: \`compare.png\`, ${perRow / 2} pairs per row (${labelA} left, ${labelB} right), ${tA.length} pairs at ${args['a-times'] ? 'the given shot times' : 'the same fraction of each video'}.`,
  '',
  `| | ${labelA} | ${labelB} |`,
  '| --- | --- | --- |',
  ...rows.map((r) => `| ${r.join(' | ')} |`),
  '',
  `Times (s), ${labelA}: ${tA.map((t) => t.toFixed(1)).join(', ')}`,
  `Times (s), ${labelB}: ${tB.map((t) => t.toFixed(1)).join(', ')}`,
  '',
].join('\n')
writeFileSync(join(out, 'compare.md'), md)
console.log(md)
