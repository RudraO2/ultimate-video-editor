import { CommandError, type Comp } from '@uve/core'
import { renderPlan } from '@uve/engine'
import { ChevronRight, Download, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  EXPORT_QUALITIES,
  type ExportForm,
  fieldsOf,
  formatOf,
  fpsLabel,
  fpsPresetsFor,
  GIF_MAX_FPS,
  IMAGE_FORMATS,
  initialForm,
  QUALITY_LABELS,
  RESOLUTION_PRESETS,
  resolutionOf,
  resolutionScale,
  SCALE_PRESETS,
  scaleLabel,
  scaledSize,
  settingsOf,
  summaryOf,
  videoFormatsFor,
} from '../export/dialog'
import { exportActiveComp, exportRenderOptions, exportSpan } from '../export/job'
import { qualityBitrate } from '../export/options'
import { compHasSound } from '../export/render'
import { activeComp, useEditor } from '../store'

// The export settings dialog, as AtomCut's export panel: it opens before the
// save dialog (Ctrl+E, the rail's Export button, Main menu ▸ Export). The
// rules (which rows a format shows, the settings they come to) are in
// `export/dialog.ts`; this draws them and checks every change.

/** Opens the export settings, unless an export is already shown. */
export function openExportSetup(): void {
  if (useEditor.getState().exportJob) return
  useEditor.setState({ exportSetupOpen: true })
}

const closeSetup = () => useEditor.setState({ exportSetupOpen: false })

const field = 'h-7 min-w-0 rounded-lg bg-field px-2 text-xs outline-none hover:bg-hover focus:ring-1 focus:ring-accent'

/** A number as typed: an empty box is NaN, which the export check refuses. */
const typed = (value: string) => (value.trim() === '' ? Number.NaN : Number(value))

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-24 shrink-0 pt-1.5 text-[11px] text-muted">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string
  value: T
  options: readonly { id: T; label: string; disabled?: boolean; title?: string }[]
  onPick: (id: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={o.disabled}
          title={o.title}
          aria-pressed={value === o.id}
          onClick={() => onPick(o.id)}
          className={`h-7 flex-1 rounded-lg px-2 text-xs disabled:opacity-40 ${value === o.id ? 'active-tint' : 'bg-field text-muted hover:bg-hover hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Switch({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className={`flex h-5 w-9 items-center rounded-full px-0.5 ${on ? 'active-tint justify-end' : 'bg-field justify-start text-muted'}`}
    >
      <span className="size-4 rounded-full bg-current" />
    </button>
  )
}

function SetupForm({ comp }: { comp: Comp }) {
  const project = useEditor((s) => s.project)
  const [rangeOn] = useState(() => exportSpan(comp) !== undefined)
  const [form, setForm] = useState<ExportForm>(() => initialForm(comp, { timeMs: useEditor.getState().timeMs, rangeOn }))
  const [advanced, setAdvanced] = useState(false)
  const patch = (changes: Partial<ExportForm>) => setForm((f) => ({ ...f, ...changes }))

  const format = formatOf(form)
  const fields = fieldsOf(format, rangeOn)
  const isStatic = comp.mode === 'static'
  const hasSound = useMemo(() => compHasSound(project, comp), [project, comp])
  const settings = useMemo(() => settingsOf(form, rangeOn), [form, rangeOn])

  // Every change is checked as the export will check it, so the button is only live for settings that can be met.
  const check = useMemo(() => {
    try {
      const render = exportRenderOptions(project, comp, settings)
      const plan = renderPlan(comp, render.span, { scale: render.scale, fps: render.fps })
      return { plan, summary: summaryOf(format, plan, render.atMs), error: null as null | { message: string; hint?: string } }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { plan: null, summary: '', error: { message, hint: e instanceof CommandError ? e.hint : undefined } }
    }
  }, [project, comp, settings, format])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSetup()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault()
    if (check.error) return
    closeSetup()
    void exportActiveComp(settings)
  }

  const resolutions = RESOLUTION_PRESETS.filter((p) => resolutionScale(comp, p.side) !== null)
  const preset = resolutionOf(comp, form.scale)
  const scales = SCALE_PRESETS.includes(form.scale) || !Number.isFinite(form.scale) ? SCALE_PRESETS : [...SCALE_PRESETS, form.scale].sort((a, b) => a - b)
  const sizeText = (scale: number) => {
    const { width, height } = scaledSize(comp, scale)
    return `${width}×${height}`
  }
  const bitrateNote = (q: (typeof EXPORT_QUALITIES)[number]) => {
    if (!check.plan || (format !== 'mp4' && format !== 'webm')) return ''
    const mbps = qualityBitrate(q, check.plan.width, check.plan.height, check.plan.fps) / 1_000_000
    return ` · ~${Math.max(1, Math.round(mbps))} Mbps`
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-setup-title"
        className="flex max-h-[90vh] w-[30rem] flex-col rounded-lg border border-line bg-panel shadow-2xl"
      >
        <div className="flex items-start gap-2 p-4 pb-3">
          <Download size={16} className="mt-0.5 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="export-setup-title" className="font-semibold">
              Export
            </h2>
            <p className="mt-0.5 truncate text-xs text-muted">
              Exporting composition “{comp.name}” · {comp.width}×{comp.height}
            </p>
          </div>
          <button type="button" onClick={closeSetup} aria-label="Close" title="Close (Esc)" className="rounded p-1 text-muted hover:bg-hover hover:text-ink">
            <X size={15} aria-hidden />
          </button>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-2">
            <Row label="Kind">
              <Segmented
                label="Export kind"
                value={form.kind}
                options={[
                  { id: 'image', label: 'Image' },
                  { id: 'video', label: 'Video', disabled: isStatic, title: isStatic ? 'A static frame exports as an image' : undefined },
                ]}
                onPick={(kind) => patch({ kind })}
              />
            </Row>

            <Row label="Format">
              {form.kind === 'video' ? (
                <select
                  aria-label="Export format"
                  value={form.videoFormat}
                  onChange={(e) => patch({ videoFormat: e.target.value as ExportForm['videoFormat'] })}
                  className={`${field} w-full`}
                >
                  {videoFormatsFor(hasSound).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Segmented label="Image format" value={form.imageFormat} options={IMAGE_FORMATS} onPick={(imageFormat) => patch({ imageFormat })} />
              )}
            </Row>

            {fields.range && (
              <Row label="Range">
                <Segmented
                  label="Range"
                  value={form.range}
                  options={[
                    { id: 'full', label: 'Full' },
                    { id: 'span', label: 'Working range' },
                  ]}
                  onPick={(range) => patch({ range })}
                />
              </Row>
            )}

            {fields.size && (
              <Row label="Size">
                <div className="flex gap-2">
                  <select
                    aria-label="Resolution preset"
                    value={preset ? String(preset.side) : 'custom'}
                    onChange={(e) => {
                      const scale = resolutionScale(comp, Number(e.target.value))
                      if (scale !== null) patch({ scale })
                    }}
                    className={`${field} flex-1`}
                  >
                    {!preset && (
                      <option value="custom" disabled>
                        Custom
                      </option>
                    )}
                    {resolutions.map((p) => (
                      <option key={p.side} value={p.side}>
                        {`${p.label}${p.tag ? ` ${p.tag}` : ''} · ${sizeText(resolutionScale(comp, p.side) as number)}`}
                      </option>
                    ))}
                  </select>
                  <select aria-label="Scale" value={String(form.scale)} onChange={(e) => patch({ scale: Number(e.target.value) })} className={`${field} flex-1`}>
                    {scales.map((s) => (
                      <option key={s} value={String(s)}>
                        {`${scaleLabel(s)} · ${sizeText(s)}`}
                      </option>
                    ))}
                  </select>
                </div>
              </Row>
            )}

            {fields.fps && (
              <Row label="Frame rate">
                <div className="flex gap-2">
                  <input
                    type="number"
                    step="any"
                    aria-label="Frame rate"
                    value={Number.isNaN(form.fps) ? '' : form.fps}
                    onChange={(e) => patch({ fps: typed(e.target.value) })}
                    className={`${field} w-20`}
                  />
                  <select
                    aria-label="Frame rate presets"
                    value=""
                    onChange={(e) => e.target.value && patch({ fps: Number(e.target.value) })}
                    className={`${field} flex-1`}
                  >
                    <option value="">Presets</option>
                    {fpsPresetsFor(format).map((p) => (
                      <option key={p.fps} value={p.fps}>
                        {`${fpsLabel(p.fps)} — ${p.label}`}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  This comp runs at {fpsLabel(comp.fps)} fps.
                  {format === 'gif' && form.fps > GIF_MAX_FPS && ` GIF plays at most ${GIF_MAX_FPS} fps.`}
                </p>
              </Row>
            )}

            {fields.includeAudio && (
              <Row label="Include sound">
                <Switch label="Include sound" on={form.includeAudio} onToggle={() => patch({ includeAudio: !form.includeAudio })} />
              </Row>
            )}
            {fields.transparent && (
              <Row label="Transparent">
                <Switch label="Transparent" on={form.transparent} onToggle={() => patch({ transparent: !form.transparent })} />
              </Row>
            )}
            {fields.motionBlur && (
              <Row label="Motion blur">
                <Switch label="Motion blur" on={form.motionBlur} onToggle={() => patch({ motionBlur: !form.motionBlur })} />
              </Row>
            )}

            {fields.atMs && (
              <Row label="Still time">
                {isStatic ? (
                  <p className="pt-1.5 text-[11px] text-muted">A static frame exports its still.</p>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="any"
                      min={0}
                      aria-label="Still at"
                      value={Number.isFinite(form.atMs) ? Number((form.atMs / 1000).toFixed(3)) : ''}
                      onChange={(e) => {
                        const seconds = typed(e.target.value)
                        patch({ atMs: Number.isFinite(seconds) ? Math.min(Math.max(0, seconds * 1000), comp.durationMs) : 0 })
                      }}
                      className={`${field} w-24`}
                    />
                    <span className="text-xs text-muted">s</span>
                  </div>
                )}
              </Row>
            )}

            {(fields.quality || fields.audioBitrate) && (
              <div className="rounded-lg border border-line">
                <button
                  type="button"
                  aria-expanded={advanced}
                  aria-label="Advanced"
                  onClick={() => setAdvanced(!advanced)}
                  className="flex w-full items-center gap-1.5 px-2.5 py-2 text-[11px] font-semibold tracking-wider text-muted uppercase hover:text-ink"
                >
                  <ChevronRight size={13} className={advanced ? 'rotate-90' : ''} aria-hidden />
                  Advanced
                </button>
                {advanced && (
                  <div className="space-y-3 px-2.5 pb-3">
                    {fields.quality && (
                      <Row label="Quality">
                        <select
                          aria-label="Quality"
                          value={form.quality}
                          onChange={(e) => patch({ quality: e.target.value as ExportForm['quality'] })}
                          className={`${field} w-full`}
                        >
                          {EXPORT_QUALITIES.map((q) => (
                            <option key={q} value={q}>
                              {`${QUALITY_LABELS[q]}${bitrateNote(q)}`}
                            </option>
                          ))}
                        </select>
                      </Row>
                    )}
                    {fields.audioBitrate && (
                      <Row label="Audio bitrate">
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            step="any"
                            aria-label="Audio bitrate"
                            value={Number.isNaN(form.audioBitrate) ? '' : form.audioBitrate}
                            onChange={(e) => patch({ audioBitrate: typed(e.target.value) })}
                            className={`${field} w-24`}
                          />
                          <span className="text-xs text-muted">kbps</span>
                        </div>
                      </Row>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2 p-4 pt-3">
            {check.error ? (
              <div role="alert" className="rounded-lg bg-red-500/10 px-2.5 py-2 text-xs text-red-200">
                <p>{check.error.message}</p>
                {check.error.hint && <p className="mt-1 text-red-200/70">{check.error.hint}</p>}
              </div>
            ) : (
              <p className="font-mono text-[11px] text-muted">{check.summary}</p>
            )}
            <button
              type="submit"
              disabled={check.error !== null}
              className="w-full truncate rounded px-3 py-2 text-xs font-medium bg-accent text-white hover:bg-accent/85 disabled:opacity-50"
            >
              Export {comp.name}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** The export settings, shown before the save dialog; its form starts afresh each time it opens. */
export function ExportSetupDialog() {
  const open = useEditor((s) => s.exportSetupOpen)
  const comp = useEditor((s) => activeComp(s))
  return open ? <SetupForm comp={comp} /> : null
}
