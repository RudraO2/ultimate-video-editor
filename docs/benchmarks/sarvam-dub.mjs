// Sarvam's Dubbing API on one exported video: the other side of the S1 A/B (our rebuild per language
// against Sarvam's dub of the same export, plus a hybrid of the dubbed voice with our text).
//
//   node docs/benchmarks/sarvam-dub.mjs --in <video.mp4> --langs hi-IN,ta-IN --out <folder>
//        [--src en-IN] [--exports video,audio,srt] [--voice-cloning true] [--register modern-colloquial] [--yes]
//
// Costs ₹40 per source minute per language (billed per second). Without --yes it only prints the
// estimate. The job id is kept in <out>/job.json: running again resumes that job (polls and downloads)
// instead of paying for a new one. Downloads land as <out>/<lang>.<export>.<ext>. The key comes from
// SARVAM_API_KEY (or, on Windows, the user environment variable of that name); it is never printed.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : [])),
)
if (!args.in || !args.langs || !args.out) {
  console.error('usage: node sarvam-dub.mjs --in <video> --langs hi-IN,ta-IN --out <folder> [--src en-IN] [--exports video,audio,srt] [--yes]')
  process.exit(1)
}
const BASE = 'https://api.sarvam.ai/dubbing'
const key =
  process.env.SARVAM_API_KEY ||
  (process.platform === 'win32'
    ? execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('SARVAM_API_KEY','User')"], { encoding: 'utf8' }).trim()
    : '')
if (!key) throw new Error('Set SARVAM_API_KEY first.')
const input = resolve(args.in)
const out = resolve(args.out)
mkdirSync(out, { recursive: true })
const langs = args.langs.split(',').map((l) => l.trim())
const exportsWanted = (args.exports ?? 'video,audio,srt').split(',')
const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input], { encoding: 'utf8' }))
const estimate = Math.round(((Math.ceil(seconds) / 60) * 40 * langs.length) * 100) / 100
const jobFile = join(out, 'job.json')
let job = existsSync(jobFile) ? JSON.parse(readFileSync(jobFile, 'utf8')) : null

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'api-subscription-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${json?.error?.message ?? json?.message ?? text.slice(0, 300)}`)
  return json
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!job) {
  console.log(`${basename(input)}: ${seconds.toFixed(1)} s × ${langs.length} language(s) ≈ ₹${estimate}`)
  if (args.yes !== 'true') {
    console.log('Estimate only. Add --yes to create the job and pay for it.')
    process.exit(0)
  }
  const created = await api('POST', '/jobs', {
    src_lang: args.src ?? 'en-IN',
    target_langs: langs,
    export_options: exportsWanted,
    voice_cloning: args['voice-cloning'] !== 'false',
    num_speakers: 1,
    disable_watermark: true,
    ...(args.register ? { register: args.register } : {}),
    job_name: basename(input),
  })
  const { job_id: id, upload_url: uploadUrl } = created.data
  job = { id, input, langs, exportsWanted, estimate, createdAt: new Date().toISOString(), started: false }
  writeFileSync(jobFile, JSON.stringify(job, null, 2))
  console.log(`job ${id}: uploading`)
  // The signed URL gets the bytes alone: never the key.
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'x-ms-blob-type': 'BlockBlob' }, body: readFileSync(input) })
  if (!put.ok) throw new Error(`upload: ${put.status} ${(await put.text()).slice(0, 300)}`)
}
if (!job.started) {
  await api('POST', `/jobs/${job.id}/start`)
  job.started = true
  writeFileSync(jobFile, JSON.stringify(job, null, 2))
  console.log(`job ${job.id}: started`)
}

for (;;) {
  const live = (await api('GET', `/jobs/${job.id}/live-status`)).data
  console.log(`${new Date().toISOString().slice(11, 19)} ${live.status} ${live.progress}% ${live.current_step_label ?? ''}`)
  if (live.status === 'failed' || live.status === 'deleted') throw new Error(`job ${live.status}: ${live.error_message ?? ''}`)
  if (live.status === 'completed' || live.status === 'partial_failure') break
  await sleep(10_000)
}

const ext = { video: 'mp4', audio: 'wav', mp3: 'mp3', srt: 'srt', vtt: 'vtt', audio_vocals: 'wav' }
for (let round = 0; round < 60; round++) {
  const list = (await api('GET', `/jobs/${job.id}/export-status?limit=100`)).data.exports ?? []
  const pending = list.filter((e) => e.status === 'in_progress')
  for (const e of list.filter((x) => x.status === 'completed' && x.download_url)) {
    const file = join(out, `${e.target_language}.${e.export_type}.${ext[e.export_type] ?? 'bin'}`)
    if (existsSync(file)) continue
    const r = await fetch(e.download_url)
    if (!r.ok) throw new Error(`download ${e.export_type} ${e.target_language}: ${r.status}`)
    writeFileSync(file, Buffer.from(await r.arrayBuffer()))
    console.log(`saved ${file}`)
  }
  // Each language and export finishes on its own: wait until every pair is on disk.
  const saved = job.langs.flatMap((l) => job.exportsWanted.filter((x) => existsSync(join(out, `${l}.${x}.${ext[x] ?? "bin"}`))))
  if (saved.length >= job.langs.length * job.exportsWanted.length || (pending.length === 0 && round > 30)) break
  await sleep(10_000)
}
job.done = new Date().toISOString()
writeFileSync(jobFile, JSON.stringify(job, null, 2))
console.log(`job ${job.id}: done (estimate ₹${job.estimate})`)
