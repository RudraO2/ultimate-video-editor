#!/usr/bin/env node
// Runs the benchmark briefs through a headless Claude Code session driving the
// running editor over MCP, one brief at a time, and makes a contact sheet of
// each exported video.
//
//   node docs/benchmarks/run.mjs --out <folder> [--only 01,03] [--model sonnet] [--max-turns 60]
//
// Needs: the editor running (pnpm dev), `claude` and `ffmpeg` on the PATH.
// The output folder gets the test media, each brief's .uve, .mp4, contact
// sheet (.png) and the agent's transcript, and results.json. Keep it outside
// the repository (for example in a temporary folder).

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
)
if (!args.out) throw new Error('Pass --out <folder> (outside the repository).')
const out = resolve(args.out)
const mediaDir = join(out, 'media')
const model = args.model ?? 'sonnet'
const maxTurns = args['max-turns'] ?? '60'
const only = args.only ? args.only.split(',') : null
mkdirSync(mediaDir, { recursive: true })

// Test media, made once: the ffmpeg inputs and options of each file (the output path goes last).
const VIDEO = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']
const MEDIA = {
  'clip.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', ...VIDEO],
  'long.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', ...VIDEO],
  'song.wav': ['-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*220*t)+0.15*sin(2*PI*277*t)+0.12*sin(2*PI*330*t)*(0.5+0.5*sin(2*PI*2*t)):s=48000:d=12'],
  'product-1.png': ['-f', 'lavfi', '-i', 'gradients=s=1080x1080:c0=0x1d2b64:c1=0xf8cdda:seed=1', '-frames:v', '1'],
  'product-2.png': ['-f', 'lavfi', '-i', 'gradients=s=1080x1080:c0=0x0f2027:c1=0x2c5364:seed=2', '-frames:v', '1'],
  'product-3.png': ['-f', 'lavfi', '-i', 'gradients=s=1080x1080:c0=0x42275a:c1=0x734b6d:seed=3', '-frames:v', '1'],
  'logo.png': ['-f', 'lavfi', '-i', 'color=c=0x7c5cff:s=512x512', '-frames:v', '1'],
}
// Real media (music, voice lines) lives in ~/uve-assets/benchmark-media; a file found there is copied in
// instead of generated, and a file a brief names that exists only there is copied too.
const assetDir = join(homedir(), 'uve-assets', 'benchmark-media')
for (const [name, options] of Object.entries(MEDIA)) {
  const path = join(mediaDir, name)
  if (existsSync(join(assetDir, name))) copyFileSync(join(assetDir, name), path)
  else if (!existsSync(path)) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...options, path])
}
const MEDIA_NAME = /`([\w.-]+\.(?:mp4|wav|mp3|png))`/g

// Sound of an export: has it an audio stream, integrated loudness and true peak (ffmpeg ebur128, Summary block).
function measureSound(file) {
  const streams = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  if (!streams.trim()) return { hasAudio: false, integratedLufs: null, truePeakDbtp: null }
  const log = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stderr
  const summary = log.slice(log.lastIndexOf('Summary:'))
  const lufs = summary.match(/\bI:\s*(-?[\d.]+|-inf)\s*LUFS/)
  const peak = summary.match(/Peak:\s*(-?[\d.]+|-inf)\s*dBFS/)
  const num = (m) => (m && Number.isFinite(Number(m[1])) ? Number(m[1]) : null)
  return { hasAudio: true, integratedLufs: num(lufs), truePeakDbtp: num(peak) }
}

// MCP connection.
const { url, token } = JSON.parse(readFileSync(join(homedir(), '.uve', 'mcp.json'), 'utf8'))
let sessionId = null
let rpcId = 0
async function rpc(method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
  sessionId = res.headers.get('mcp-session-id') ?? sessionId
  return res.json()
}
async function tool(name, input = {}) {
  const r = await rpc('tools/call', { name, arguments: input })
  const text = r.result?.content?.find((c) => c.type === 'text')?.text ?? JSON.stringify(r.error)
  if (r.result?.isError || r.error) throw new Error(`${name}: ${text}`)
  return JSON.parse(text)
}
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'benchmark-runner', version: '1' } })

const mcpConfig = join(out, 'mcp.json')
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { uve: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2))

const resultsFile = join(out, 'results.json')
const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : {}

for (const file of readdirSync(join(here, 'briefs')).sort()) {
  const id = file.replace(/\.md$/, '')
  if (only && !only.some((o) => id.startsWith(o))) continue
  const md = readFileSync(join(here, 'briefs', file), 'utf8')
  const brief = md.split('**Brief:**')[1]?.split('**AtomCut')[0]?.trim()
  const mediaLine = md.split('**Media:**')[1]?.split('\n')[0] ?? ''
  const media = [...mediaLine.matchAll(MEDIA_NAME)].map((m) => m[1])
  console.log(`\n== ${id}`)

  // A clean project with the brief's media in it.
  const overview = await tool('doc_overview')
  if (overview.editor.file.unsavedChanges) await tool('project_save', { path: join(out, `_before-${id}.uve`) })
  await tool('project_new', { name: id })
  for (const name of media) if (existsSync(join(assetDir, name))) copyFileSync(join(assetDir, name), join(mediaDir, name))
  for (const name of media) await tool('media_import', { localPath: join(mediaDir, name) })
  await tool('project_save', { path: join(out, `_start-${id}.uve`) })

  const video = join(out, `${id}.mp4`)
  const prompt = `${brief}

Work only through the uve MCP tools; read the resource uve://skill/SKILL.md first. A new project is open${media.length ? ` with ${media.join(', ')} in its media library` : ''}. When you are done, export it with export_video to the path ${video} (overwrite: true) and save it with project_save to ${join(out, `${id}.uve`)}. Then reply in two or three sentences: what you made, and anything you could not do.`

  const started = Date.now()
  const run = spawnSync(
    'claude',
    ['-p', prompt, '--model', model, '--mcp-config', mcpConfig, '--strict-mcp-config', '--allowedTools', 'mcp__uve,ListMcpResourcesTool,ReadMcpResourceTool', '--max-turns', maxTurns, '--output-format', 'stream-json', '--verbose'],
    { cwd: out, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  // The whole transcript, one JSON event per line; the last "result" event is the summary.
  writeFileSync(join(out, `${id}.agent.jsonl`), run.stdout || run.stderr || '')
  const events = (run.stdout || '').split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
  const summary = events.findLast((e) => e.type === 'result') ?? { error: (run.stderr || run.stdout || '').slice(0, 2000) }
  // Tool calls that failed, with their error text: the first place to look for gaps.
  const errors = events
    .filter((e) => e.type === 'user')
    .flatMap((e) => e.message?.content ?? [])
    .filter((c) => c.type === 'tool_result' && c.is_error)
    .map((c) => (Array.isArray(c.content) ? c.content.map((p) => p.text ?? '').join(' ') : String(c.content)).slice(0, 300))

  let sheet = null
  if (existsSync(video)) {
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' }))
    sheet = join(out, `${id}.sheet.png`)
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', video, '-vf', `fps=12/${duration},scale=360:-2,tile=4x3`, '-frames:v', '1', sheet])
  }
  results[id] = {
    model,
    seconds: Math.round((Date.now() - started) / 1000),
    turns: summary.num_turns ?? null,
    costUsd: summary.total_cost_usd ?? null,
    exported: existsSync(video),
    sound: existsSync(video) ? measureSound(video) : null,
    sheet,
    toolErrors: errors,
    reply: summary.result ?? summary.error ?? null,
  }
  writeFileSync(resultsFile, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results[id], null, 2))
}
