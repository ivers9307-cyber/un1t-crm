'use client'

// TV.1 — TV admin UI.
//
// Each TV row shows:
//   - Label, URL (with copy button — paste into UC Cast Pro's
//     Web URL setting once when registering the cast)
//   - What's currently displayed
//   - Buttons: Push image (upload OR URL), Clear (back to idle),
//     Delete (remove the TV from the location)
//
// All mutations go direct via the browser Supabase client — RLS
// already allows authenticated-in-location operators full CRUD
// on tv_displays + tv_content. The /tv/[token] page reads via
// service-role through /api/tv/[token]/content; this page never
// needs to touch that public path.

import { useState, useCallback, useRef } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { Tv, Plus, Copy, Check, Trash2, Upload, Link2, X, Image as ImageIcon, AlertCircle, RotateCcw, RotateCw, LayoutTemplate, Pencil, Type } from 'lucide-react'
import TemplateEditor, { bucketPublicUrl } from './TemplateEditor'
import TemplateCanvas from '@/components/TemplateCanvas'
import { setRunStyle, clearRunStyle, rangeStyle, lineRangeAt, shiftRuns } from '@/lib/tv-template'

// TV-TEMPLATE.2 — weight options offered on the push screen.
const PUSH_FONT_WEIGHTS = [
  { value: 400, label: 'Regular' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extrabold' },
  { value: 900, label: 'Black' },
]

// TV-TEMPLATE.4 — quick-insert emoji palette for the zone editor.
const PUSH_EMOJIS = [
  '🔥', '💪', '🏆', '⚡', '✅', '❌', '⭐', '🎯',
  '⏰', '📅', '📍', '💯', '👏', '🙌', '🤝', '🚀',
  '❤️', '🏃', '🏋️', '🤸', '🥇', '➕', '‼️', '👉',
]

// TV-ROTATION.1 — screen-rotation options offered per display.
// Value is clockwise degrees, matched 1:1 by the CSS rotate() the
// /tv/cast page applies (see TVDisplay.jsx + migration 189).
const ORIENTATION_OPTIONS = [
  { value: 0,   label: 'Landscape' },
  { value: 90,  label: 'Portrait — rotated right' },
  { value: 270, label: 'Portrait — rotated left' },
  { value: 180, label: 'Landscape — upside down' },
]

export default function TVAdmin({ initialDisplays, initialTemplates, locationId, currentUserId }) {
  const db = createBrowserClient()
  const [displays, setDisplays] = useState(initialDisplays)
  const [templates, setTemplates] = useState(initialTemplates || [])
  const [registerOpen, setRegisterOpen] = useState(false)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    const { data } = await db.from('tv_displays')
      .select('*, tv_content(*)')
      .eq('location_id', locationId)
      .order('created_at', { ascending: true })
    setDisplays(data || [])
  }, [db, locationId])

  const refreshTemplates = useCallback(async () => {
    const { data } = await db.from('tv_templates')
      .select('*')
      .eq('location_id', locationId)
      .order('name', { ascending: true })
    setTemplates(data || [])
  }, [db, locationId])

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-baseline justify-between mb-1 flex-wrap gap-2">
        <h2 className="text-2xl font-bold">TV Displays</h2>
        <button
          onClick={() => setRegisterOpen(true)}
          className="inline-flex items-center gap-1.5 text-sm bg-un1t-text text-un1t-bg font-medium px-3 py-1.5 rounded-md hover:bg-un1t-accent"
        >
          <Plus size={14} /> Register TV
        </button>
      </div>
      <p className="text-sm text-un1t-subtle mb-5">
        Each TV gets a unique URL. Paste it into UC Cast Pro&apos;s &ldquo;Web URL&rdquo; content source — the cast will render whatever the CRM serves at that URL.
      </p>

      {error && (
        <div className="mb-4 flex items-center gap-2 text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      <div className="space-y-4">
        {displays.length === 0 && !registerOpen && (
          <div className="bg-un1t-surface border border-un1t-border rounded-lg p-12 text-center">
            <Tv size={32} className="text-un1t-muted mx-auto mb-3" />
            <p className="text-sm text-un1t-subtle mb-1">No TVs registered yet.</p>
            <p className="text-xs text-un1t-muted">Click &ldquo;Register TV&rdquo; to add one and get a URL for UC Cast Pro.</p>
          </div>
        )}

        {displays.map(d => (
          <TVCard
            key={d.id}
            display={d}
            templates={templates}
            currentUserId={currentUserId}
            onError={setError}
            onChange={refresh}
            db={db}
          />
        ))}
      </div>

      {/* TV-TEMPLATE.1 — reusable base-image templates. */}
      <TemplatesSection
        templates={templates}
        locationId={locationId}
        currentUserId={currentUserId}
        db={db}
        onError={setError}
        onChange={refreshTemplates}
      />

      {registerOpen && (
        <RegisterTVModal
          onClose={() => setRegisterOpen(false)}
          onCreate={async (label) => {
            setError(null)
            const { error: e } = await db.from('tv_displays')
              .insert({ location_id: locationId, label })
            if (e) { setError(e.message); return }
            await refresh()
            setRegisterOpen(false)
          }}
        />
      )}
    </div>
  )
}

// ── Templates section ───────────────────────────────────────────
//
// TV-TEMPLATE.1 — a template is a fixed branded base image plus
// fixed text zones. Built once here; staff fill the zone text and
// push it from the "Push image → Template" tab.

function TemplatesSection({ templates, locationId, currentUserId, db, onError, onChange }) {
  const [editing, setEditing] = useState(null)   // template object | 'new' | null

  async function deleteTemplate(tpl) {
    if (!confirm(`Delete template "${tpl.name}"? Any TV currently showing it will fall back to the idle screen.`)) return
    onError(null)
    const { error } = await db.from('tv_templates').delete().eq('id', tpl.id)
    if (error) { onError(error.message); return }
    await onChange()
  }

  return (
    <section className="mt-10">
      <div className="flex items-baseline justify-between mb-1 flex-wrap gap-2">
        <h3 className="text-lg font-semibold inline-flex items-center gap-2">
          <LayoutTemplate size={16} className="text-un1t-subtle" /> Templates
        </h3>
        <button
          onClick={() => setEditing('new')}
          className="inline-flex items-center gap-1.5 text-sm bg-un1t-text text-un1t-bg font-medium px-3 py-1.5 rounded-md hover:bg-un1t-accent"
        >
          <Plus size={14} /> New template
        </button>
      </div>
      <p className="text-sm text-un1t-subtle mb-4">
        A fixed branded image with text zones. Staff retype the text and push it to a TV — the design stays on-brand.
      </p>

      {templates.length === 0 ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-8 text-center">
          <LayoutTemplate size={28} className="text-un1t-muted mx-auto mb-3" />
          <p className="text-sm text-un1t-subtle mb-1">No templates yet.</p>
          <p className="text-xs text-un1t-muted">Create one to let staff push branded messages without designing a fresh image each time.</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {templates.map(t => (
            <div key={t.id} className="bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden flex">
              <div className="w-28 shrink-0 bg-un1t-bg flex items-center justify-center">
                <img
                  src={bucketPublicUrl(t.base_image_path)}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="flex-1 min-w-0 p-3 flex flex-col">
                <div className="text-sm font-medium text-un1t-text truncate">{t.name}</div>
                <div className="text-xs text-un1t-muted mt-0.5 inline-flex items-center gap-1">
                  <Type size={11} /> {(t.zones?.length || 0)} text {t.zones?.length === 1 ? 'zone' : 'zones'}
                </div>
                <div className="mt-auto pt-2 flex items-center gap-2">
                  <button
                    onClick={() => setEditing(t)}
                    className="inline-flex items-center gap-1 text-xs text-un1t-subtle hover:text-un1t-text border border-un1t-border hover:border-un1t-text/30 px-2 py-1 rounded-md"
                  >
                    <Pencil size={12} /> Edit
                  </button>
                  <button
                    onClick={() => deleteTemplate(t)}
                    className="inline-flex items-center text-xs text-red-400 hover:text-red-300 border border-un1t-border hover:border-red-400/40 px-2 py-1 rounded-md"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <TemplateEditor
          template={editing === 'new' ? null : editing}
          locationId={locationId}
          currentUserId={currentUserId}
          db={db}
          onClose={() => setEditing(null)}
          onSaved={onChange}
        />
      )}
    </section>
  )
}

// ── Per-TV row ──────────────────────────────────────────────────

function TVCard({ display, templates, currentUserId, onError, onChange, db }) {
  const content = Array.isArray(display.tv_content) ? display.tv_content[0] : display.tv_content
  const tvUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/tv/cast/${display.token}`
    : `/tv/cast/${display.token}`

  const [copied, setCopied] = useState(false)
  const [pushOpen, setPushOpen] = useState(false)

  async function clearContent() {
    if (!confirm(`Clear ${display.label}? The TV will fall back to the idle screen.`)) return
    onError(null)
    const { error } = await db.from('tv_content')
      .delete()
      .eq('tv_display_id', display.id)
    if (error) onError(error.message)
    await onChange()
  }

  async function deleteTV() {
    if (!confirm(`Delete ${display.label}? The TV URL will stop working — you'll need to update UC Cast Pro if it's currently using this URL.`)) return
    onError(null)
    const { error } = await db.from('tv_displays')
      .delete()
      .eq('id', display.id)
    if (error) onError(error.message)
    await onChange()
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
      <div className="p-4 flex flex-wrap items-start gap-3 border-b border-un1t-border">
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center gap-2">
            <Tv size={16} className="text-un1t-subtle" />
            <span className="text-sm font-medium text-un1t-text">{display.label}</span>
            {!display.active && <span className="text-[10px] text-un1t-muted uppercase">Inactive</span>}
          </div>
          <div className="mt-2 flex items-center gap-2 max-w-full">
            <code className="text-[11px] text-un1t-subtle bg-un1t-bg border border-un1t-border rounded px-2 py-1 flex-1 truncate">
              {tvUrl}
            </code>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(tvUrl)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              className="inline-flex items-center gap-1 text-xs text-un1t-subtle hover:text-un1t-text px-2 py-1 rounded border border-un1t-border"
              title="Copy URL"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPushOpen(true)}
            className="inline-flex items-center gap-1.5 text-sm bg-un1t-text text-un1t-bg font-medium px-3 py-1.5 rounded-md hover:bg-un1t-accent"
          >
            <ImageIcon size={14} /> Push image
          </button>
          {content && (
            <button
              onClick={clearContent}
              className="inline-flex items-center gap-1 text-sm text-un1t-subtle hover:text-un1t-text border border-un1t-border hover:border-un1t-text/30 px-3 py-1.5 rounded-md"
              title="Revert to idle screen"
            >
              <RotateCcw size={14} /> Clear
            </button>
          )}
          <button
            onClick={deleteTV}
            className="inline-flex items-center text-sm text-red-400 hover:text-red-300 border border-un1t-border hover:border-red-400/40 px-2 py-1.5 rounded-md"
            title="Delete TV"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="px-4 py-3">
        {/* TV-REMEMBER.2 — a small visual preview of what's actually on
            the TV right now, so staff don't have to guess from text
            alone before deciding whether to push something new. */}
        <NowShowingThumb content={content} templates={templates} />
        <div className="text-xs text-un1t-subtle flex items-center gap-3 flex-wrap mt-2">
          <span className="text-un1t-muted uppercase tracking-wide">Now showing</span>
          {content ? (
            <>
              <span className="text-un1t-text">{content.label || content.source_ref}</span>
              <span className="text-un1t-muted">·</span>
              <span className="text-un1t-muted">{content.source_type}</span>
              <span className="text-un1t-muted">·</span>
              <span className="text-un1t-muted">pushed {new Date(content.pushed_at).toLocaleString('en-IE', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</span>
            </>
          ) : (
            <span className="text-un1t-muted">Idle — UN1T mark + clock</span>
          )}
          <OrientationControl display={display} db={db} onError={onError} onChange={onChange} />
        </div>
      </div>

      {pushOpen && (
        <PushModal
          onClose={() => setPushOpen(false)}
          onPush={async ({ source_type, source_ref, label, template_values }) => {
            onError(null)
            const { error } = await db.from('tv_content').upsert({
              tv_display_id: display.id,
              source_type,
              source_ref,
              label,
              // Reset to null for non-template pushes so a previous
              // template's text never lingers on the row.
              template_values: template_values ?? null,
              pushed_at: new Date().toISOString(),
              pushed_by: currentUserId,
              triggered_by: `manual:${currentUserId}`,
            }, { onConflict: 'tv_display_id' })
            if (error) { onError(error.message); return }
            await onChange()
            setPushOpen(false)
          }}
          locationId={display.location_id}
          templates={templates}
          content={content}
        />
      )}
    </div>
  )
}

// ── Now-showing thumbnail ────────────────────────────────────────
//
// TV-REMEMBER.2 — a compact preview of the live content: an <img>
// for storage/url pushes, or the shared TemplateCanvas (read-only)
// for a template push so the text/styling renders exactly as it
// does on the TV. No thumbnail (falls back to the text row alone)
// when there's nothing pushed, or the template behind a template
// push has since been deleted.

function NowShowingThumb({ content, templates }) {
  if (!content) return null

  if (content.source_type === 'storage') {
    return (
      <div className="w-40 aspect-video rounded-md overflow-hidden bg-black border border-un1t-border">
        <img src={bucketPublicUrl(content.source_ref)} alt="" className="w-full h-full object-cover" />
      </div>
    )
  }

  if (content.source_type === 'url') {
    return (
      <div className="w-40 aspect-video rounded-md overflow-hidden bg-black border border-un1t-border">
        <img src={content.source_ref} alt="" className="w-full h-full object-cover" />
      </div>
    )
  }

  if (content.source_type === 'template') {
    const tpl = templates?.find(t => t.id === content.source_ref)
    if (!tpl) return null
    return (
      <div className="w-40 aspect-video relative rounded-md overflow-hidden bg-black border border-un1t-border">
        <TemplateCanvas
          content={{
            resolved_url: bucketPublicUrl(tpl.base_image_path),
            template: { zones: tpl.zones || [], values: content.template_values || {} },
          }}
          editable={false}
        />
      </div>
    )
  }

  return null
}

// ── Orientation control ─────────────────────────────────────────
//
// TV-ROTATION.1 — picks how the panel is physically hung. Writes
// tv_displays.rotation; the /tv/cast page picks the change up on
// its next 3s poll, so the operator can re-aim a TV live without
// touching the cast device.

function OrientationControl({ display, db, onError, onChange }) {
  const [saving, setSaving] = useState(false)
  const rotation = display.rotation ?? 0

  async function setRotation(value) {
    if (value === rotation) return
    onError(null)
    setSaving(true)
    const { error } = await db.from('tv_displays')
      .update({ rotation: value })
      .eq('id', display.id)
    setSaving(false)
    if (error) { onError(error.message); return }
    await onChange()
  }

  return (
    <label className="ml-auto inline-flex items-center gap-1.5 text-un1t-muted">
      {rotation === 0 ? <RotateCw size={12} /> : <RotateCw size={12} className="text-un1t-subtle" />}
      <span className="uppercase tracking-wide">Orientation</span>
      <select
        value={rotation}
        disabled={saving}
        onChange={e => setRotation(Number(e.target.value))}
        className="bg-un1t-bg border border-un1t-border rounded px-2 py-1 text-un1t-text focus:outline-none focus:border-un1t-muted disabled:opacity-50"
      >
        {ORIENTATION_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

// ── Register modal ──────────────────────────────────────────────

function RegisterTVModal({ onClose, onCreate }) {
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!label.trim()) return
    setSaving(true)
    try { await onCreate(label.trim()) } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-un1t-surface border border-un1t-border rounded-lg w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Register TV</h3>
          <button onClick={onClose} className="text-un1t-subtle hover:text-un1t-text"><X size={16} /></button>
        </div>
        <label className="block text-xs text-un1t-subtle mb-1">Label</label>
        <input
          autoFocus
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="e.g. Lobby TV"
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
        />
        <p className="text-xs text-un1t-muted mt-2">
          A unique URL gets generated. Paste it into UC Cast Pro&apos;s Web URL content source on the device.
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="text-sm text-un1t-subtle hover:text-un1t-text px-3 py-1.5 rounded-md">Cancel</button>
          <button
            onClick={submit}
            disabled={saving || !label.trim()}
            className="text-sm bg-un1t-text text-un1t-bg font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Register'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Push modal — upload / URL / template ────────────────────────
//
// TV-REMEMBER.1 — seed each zone with its template defaults, then
// overlay any prior push values (the TV's current template_values)
// on top so an operator reopening the push screen for a recurring
// board starts from what's already live, not a blank slate. Legacy
// prior values may be a plain string (text-only) rather than an
// object — normalise the same way resolveZone() does. Zones no
// longer present in the template are dropped; zones added since the
// prior push fall back to their template defaults.
function seedZoneValues(tpl, priorValues) {
  const seed = {}
  for (const z of tpl?.zones || []) {
    const prior = priorValues?.[z.id]
    const p = prior && typeof prior === 'object' ? prior : (prior != null ? { text: prior } : null)
    // TV-STYLE.5 — per-range style overrides. Only seeded when the
    // prior push (or the zone default) actually has them: a legacy
    // colour-run-only value must keep styleRuns UNSET so the
    // editor's first style edit knows to migrate colorRuns.
    const styleRuns = Array.isArray(p?.styleRuns)
      ? p.styleRuns
      : (Array.isArray(z.styleRuns) ? z.styleRuns : null)
    seed[z.id] = {
      text: p?.text ?? z.defaultText ?? '',
      fontSize: p?.fontSize ?? z.fontSize ?? 6,
      fontWeight: p?.fontWeight ?? z.fontWeight ?? 700,
      color: p?.color || z.color || '#FFFFFF',
      align: p?.align || z.align || 'center',
      vAlign: p?.vAlign || z.vAlign || 'middle',
      uppercase: p?.uppercase ?? !!z.uppercase,
      lineHeight: p?.lineHeight ?? z.lineHeight ?? 1.15,
      // Geometry — seeded from prior push if present, else the
      // template; the operator can drag/resize on the preview.
      x: p?.x ?? z.x ?? 0,
      y: p?.y ?? z.y ?? 0,
      width: p?.width ?? z.width ?? 100,
      height: p?.height ?? z.height ?? 100,
      // Per-selection colour overrides (legacy TV-TEMPLATE.5 shape).
      colorRuns: Array.isArray(p?.colorRuns) ? p.colorRuns : (Array.isArray(z.colorRuns) ? z.colorRuns : []),
      ...(styleRuns ? { styleRuns } : {}),
    }
  }
  return seed
}

function PushModal({ onClose, onPush, locationId, templates, content }) {
  // TV-REMEMBER.1 — if the TV is currently showing a template push,
  // reopen the modal pre-seeded from that push instead of blank
  // template defaults, so staff restyling the same recurring board
  // don't redo the same work every time.
  const initialTemplateId = (content?.source_type === 'template' && templates?.some(t => t.id === content.source_ref))
    ? content.source_ref
    : ''

  const [mode, setMode] = useState(initialTemplateId ? 'template' : 'upload')   // 'upload' | 'url' | 'template'
  const [file, setFile] = useState(null)
  const [externalUrl, setExternalUrl] = useState('')
  const [label, setLabel] = useState('')
  const [templateId, setTemplateId] = useState(initialTemplateId)
  // { zoneId: { text, fontSize, fontWeight, color, align, vAlign,
  //   uppercase, lineHeight, geometry, colorRuns, styleRuns? } }
  const [zoneText, setZoneText] = useState(() => (
    initialTemplateId
      ? seedZoneValues(templates?.find(t => t.id === initialTemplateId), content.template_values)
      : {}
  ))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const selectedTemplate = templates?.find(t => t.id === templateId) || null

  function pickTemplate(id) {
    setTemplateId(id)
    const tpl = templates?.find(t => t.id === id)
    // Only overlay the current TV's prior values when the picked
    // template is the SAME one already on the TV — switching to a
    // different template starts fresh from its own defaults.
    const priorValues = (content?.source_type === 'template' && content.source_ref === id)
      ? content.template_values
      : null
    setZoneText(seedZoneValues(tpl, priorValues))
  }

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      if (mode === 'upload') {
        if (!file) { setError('Pick an image to upload.'); setBusy(false); return }
        // Server-side upload — the browser client can't write the
        // tv-content bucket (see /api/admin/tv-displays/upload).
        const fd = new FormData()
        fd.append('file', file)
        fd.append('kind', 'content')
        fd.append('location_id', locationId)
        const res = await fetch('/api/admin/tv-displays/upload', { method: 'POST', body: fd })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !json.success) throw new Error(json.error || 'Upload failed.')
        await onPush({
          source_type: 'storage',
          source_ref: json.path,
          label: label.trim() || file.name,
        })
      } else if (mode === 'url') {
        if (!externalUrl.trim()) { setError('Paste a URL.'); setBusy(false); return }
        await onPush({
          source_type: 'url',
          source_ref: externalUrl.trim(),
          label: label.trim() || null,
        })
      } else {
        if (!selectedTemplate) { setError('Pick a template.'); setBusy(false); return }
        await onPush({
          source_type: 'template',
          source_ref: selectedTemplate.id,
          label: label.trim() || selectedTemplate.name,
          template_values: zoneText,
        })
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const isTemplate = mode === 'template'
  const previewContent = selectedTemplate
    ? {
        resolved_url: bucketPublicUrl(selectedTemplate.base_image_path),
        label: selectedTemplate.name,
        template: { zones: selectedTemplate.zones || [], values: zoneText },
      }
    : null

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className={`bg-un1t-surface border border-un1t-border rounded-lg w-full flex flex-col ${isTemplate ? 'max-w-5xl h-[88vh]' : 'max-w-md max-h-[92vh]'}`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-un1t-border shrink-0">
          <h3 className="text-lg font-semibold">Push to TV</h3>
          <button onClick={onClose} className="text-un1t-subtle hover:text-un1t-text"><X size={16} /></button>
        </div>

        {/* Tab strip */}
        <div className="px-4 pt-3 shrink-0">
          <div className="inline-flex border border-un1t-border rounded-md overflow-hidden">
            {[
              { key: 'template', Icon: LayoutTemplate, label: 'Template' },
              { key: 'upload',   Icon: Upload,         label: 'Upload' },
              { key: 'url',      Icon: Link2,          label: 'URL' },
            ].map(({ key, Icon, label }) => (
              <button
                key={key}
                onClick={() => setMode(key)}
                className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 ${mode === key ? 'bg-un1t-border text-un1t-text' : 'text-un1t-subtle hover:bg-un1t-border/30'}`}
              >
                <Icon size={12} /> {label}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 flex flex-col">
          {isTemplate && (
            (!templates || templates.length === 0) ? (
              <div className="p-4">
                <p className="text-xs text-un1t-muted bg-un1t-bg border border-un1t-border rounded-md px-3 py-3">
                  No templates yet. Create one in the Templates section to push branded messages.
                </p>
              </div>
            ) : (
              <div className="flex flex-col flex-1 min-h-0">
                <div className="px-4 pt-3 shrink-0">
                  <label className="block text-xs text-un1t-subtle mb-1">Template</label>
                  <select
                    value={templateId}
                    onChange={e => pickTemplate(e.target.value)}
                    className="w-full max-w-sm bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
                  >
                    <option value="">Choose a template…</option>
                    {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>

                {!selectedTemplate ? (
                  <div className="p-4 text-xs text-un1t-muted">Choose a template to preview and edit it.</div>
                ) : (
                  <div className="flex gap-4 flex-1 min-h-0 p-4">
                    {/* Live preview — identical render to the TV.
                        Editable: zones can be dragged + corner-resized. */}
                    <div className="flex-1 min-w-0 relative rounded-md border border-un1t-border bg-black overflow-hidden">
                      <TemplateCanvas
                        content={previewContent}
                        editable
                        onZoneChange={(zoneId, patch) => setZoneText(v => ({
                          ...v,
                          [zoneId]: { ...v[zoneId], ...patch },
                        }))}
                      />
                    </div>
                    {/* Per-zone text editing */}
                    <div className="w-80 shrink-0 overflow-y-auto pr-0.5">
                      {(selectedTemplate.zones || []).length === 0 ? (
                        <p className="text-[11px] text-un1t-muted">This template has no text zones — it pushes as-is.</p>
                      ) : (
                        <div className="space-y-2">
                          {(selectedTemplate.zones || []).map(z => (
                            <ZonePushEditor
                              key={z.id}
                              zone={z}
                              value={zoneText[z.id]}
                              onChange={patch => setZoneText(v => ({
                                ...v,
                                [z.id]: { ...v[z.id], ...patch },
                              }))}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          )}

          {mode === 'upload' && (
            <div className="p-4">
              <input
                type="file"
                accept="image/*"
                onChange={e => setFile(e.target.files?.[0] || null)}
                className="block w-full text-xs text-un1t-subtle file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-un1t-border file:text-un1t-text hover:file:bg-un1t-muted"
              />
              {file && (
                <p className="text-[11px] text-un1t-muted mt-1.5">{file.name} · {Math.round(file.size / 1024)} KB</p>
              )}
            </div>
          )}

          {mode === 'url' && (
            <div className="p-4">
              <input
                type="url"
                value={externalUrl}
                onChange={e => setExternalUrl(e.target.value)}
                placeholder="https://…image.jpg"
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
              />
              <p className="text-[11px] text-un1t-muted mt-1.5">
                The cast loads this URL directly. Make sure it&apos;s publicly accessible.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-un1t-border p-4 shrink-0">
          <div className="flex items-end gap-3 flex-wrap">
            <label className="flex-1 min-w-[180px]">
              <span className="block text-xs text-un1t-subtle mb-1">Label (optional)</span>
              <input
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="e.g. Welcome Sarah"
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
              />
            </label>
            <div className="flex gap-2">
              <button onClick={onClose} className="text-sm text-un1t-subtle hover:text-un1t-text px-3 py-2 rounded-md">Cancel</button>
              <button
                onClick={submit}
                disabled={busy}
                className="text-sm bg-un1t-text text-un1t-bg font-medium px-4 py-2 rounded-md hover:bg-un1t-accent disabled:opacity-50"
              >
                {busy ? 'Pushing…' : 'Push to TV'}
              </button>
            </div>
          </div>
          {error && (
            <p className="text-xs text-red-400 mt-2 flex items-center gap-1">
              <AlertCircle size={12} /> {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Per-zone push editor ────────────────────────────────────────
//
// TV-TEMPLATE.5 / TV-STYLE.5 — on the push screen each zone gets
// its text, an emoji palette, a per-selection / per-line style
// toolbar (size, colour, bold, underline), and full zone-level
// styling controls. Size is exact (no auto-fit); position + box
// size are set by dragging on the preview. Everything is
// snapshotted into tv_content.template_values.

function ZonePushEditor({ zone, value, onChange }) {
  const v = value || {}
  const taRef = useRef(null)
  // Last selection (or collapsed caret) the user made in the
  // textarea. A real mouse click on a toolbar button blurs the
  // textarea and the live selection can be gone by the time the
  // click handler runs — so we capture it continuously (on select /
  // mouseup / keyup / blur, and on each button's own mousedown) and
  // the style handlers use the captured range. Mirrored into state
  // so the B/U active indicators re-render as the caret moves.
  const selRef = useRef({ start: 0, end: 0 })
  const [sel, setSel] = useState({ start: 0, end: 0 })
  const [selColor, setSelColor] = useState('#FFD400')
  const [selNote, setSelNote] = useState('')
  const cls = 'w-full bg-un1t-bg border border-un1t-border rounded px-2 py-1 text-xs text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted'

  function captureSelection() {
    const ta = taRef.current
    if (!ta) return
    const next = { start: ta.selectionStart ?? 0, end: ta.selectionEnd ?? 0 }
    selRef.current = next
    setSel(s => (s.start === next.start && s.end === next.end) ? s : next)
  }

  // TV-STYLE.5 — the range a style edit applies to: the highlighted
  // text if the selection is non-empty, else the whole line under
  // the caret.
  function targetOf(r) {
    return r.end > r.start ? r : lineRangeAt(v.text ?? '', r.start)
  }

  // The runs a style edit starts from. A legacy colour-only push
  // carries v.colorRuns with no v.styleRuns — those seed the edit
  // (colour runs are valid style runs), and the first style edit
  // blanks colorRuns in the same patch (see styleEdit) so clearing
  // a colour here actually removes the legacy run resolveZone would
  // otherwise keep folding in underneath.
  const editRuns = Array.isArray(v.styleRuns)
    ? v.styleRuns
    : (Array.isArray(v.colorRuns) ? v.colorRuns : [])

  // Uniform style over the current target — drives the B/U active
  // states and the toggle direction.
  const target = targetOf(sel)
  const targetStyle = rangeStyle(editRuns, target.start, target.end)

  // Run one style operation against the captured target and write
  // the result to v.styleRuns (migrating legacy colorRuns on the
  // first edit).
  function styleEdit(fn) {
    const r = targetOf(selRef.current)
    if (!(r.end > r.start)) { setSelNote('Click into a line or highlight some text first.'); return }
    setSelNote('')
    const patch = { styleRuns: fn(editRuns, r.start, r.end) }
    if (!Array.isArray(v.styleRuns) && Array.isArray(v.colorRuns) && v.colorRuns.length > 0) {
      patch.colorRuns = []
    }
    onChange(patch)
    requestAnimationFrame(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionRange(r.start, r.end)
    })
  }

  // B / U flip on uniformity: whole target already has the prop →
  // clear it there, else set it everywhere in the target.
  function toggleProp(prop) {
    styleEdit((runs, start, end) => (
      rangeStyle(runs, start, end)[prop] === true
        ? clearRunStyle(runs, start, end, [prop])
        : setRunStyle(runs, start, end, { [prop]: true })
    ))
  }
  // Size steps the target's uniform effective size (falling back to
  // the zone size) by ±1, clamped to the 2–40 fontSize range.
  function stepSize(delta) {
    styleEdit((runs, start, end) => {
      const eff = rangeStyle(runs, start, end).fontSize ?? (v.fontSize ?? zone.fontSize ?? 6)
      return setRunStyle(runs, start, end, { fontSize: Math.min(40, Math.max(2, eff + delta)) })
    })
  }
  function paintColor() {
    styleEdit((runs, start, end) => setRunStyle(runs, start, end, { color: selColor }))
  }
  // Clears EVERY style prop (size, colour, bold, underline) on the
  // target — back to the zone's base styling.
  function clearStyles() {
    styleEdit((runs, start, end) => clearRunStyle(runs, start, end))
  }

  // Any text edit remaps the runs so styling stays attached to the
  // same words through inserts + deletes. The captured selection is
  // dropped — offsets no longer apply.
  function changeText(next) {
    selRef.current = { start: 0, end: 0 }
    setSel({ start: 0, end: 0 })
    const prev = v.text ?? ''
    const patch = { text: next }
    if (Array.isArray(v.styleRuns)) patch.styleRuns = shiftRuns(v.styleRuns, prev, next)
    if (Array.isArray(v.colorRuns) && v.colorRuns.length > 0) patch.colorRuns = shiftRuns(v.colorRuns, prev, next)
    onChange(patch)
  }

  function insertEmoji(emoji) {
    const ta = taRef.current
    const text = v.text ?? ''
    const start = ta?.selectionStart ?? text.length
    const end = ta?.selectionEnd ?? text.length
    changeText(text.slice(0, start) + emoji + text.slice(end))
    requestAnimationFrame(() => {
      if (!ta) return
      ta.focus()
      const pos = start + emoji.length
      ta.setSelectionRange(pos, pos)
    })
  }

  // Toolbar button — same border/hover language as the Apply/Reset
  // buttons this toolbar replaces, plus a pressed state for B/U.
  function toolBtn(active) {
    return `text-[11px] px-2 py-1 rounded border ${active
      ? 'bg-un1t-border border-un1t-text/40 text-un1t-text'
      : 'border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/40'}`
  }

  return (
    <div className="bg-un1t-bg/50 border border-un1t-border rounded-md p-2.5">
      <div className="text-[11px] text-un1t-subtle uppercase tracking-wide mb-1.5">{zone.label}</div>
      <textarea
        ref={taRef}
        value={v.text ?? ''}
        onChange={e => changeText(e.target.value)}
        onSelect={captureSelection}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        onBlur={captureSelection}
        rows={7}
        placeholder={zone.defaultText || 'Type the text for this zone…'}
        className={`${cls} resize-y mb-1.5`}
      />

      {/* Emoji palette — inserts at the caret. */}
      <div className="flex flex-wrap gap-0.5 mb-2">
        {PUSH_EMOJIS.map(em => (
          <button
            key={em}
            type="button"
            onClick={() => insertEmoji(em)}
            title={`Insert ${em}`}
            className="w-7 h-7 text-base leading-none rounded hover:bg-un1t-border/60"
          >
            {em}
          </button>
        ))}
      </div>

      {/* TV-STYLE.5 — per-selection / per-line style toolbar. Acts
          on the highlighted text, or the whole line under the caret
          when nothing is highlighted. */}
      <div className="flex items-center gap-1.5 mb-1 flex-wrap">
        <span className="text-[10px] text-un1t-muted">Style selection / line:</span>
        <button
          type="button" onMouseDown={captureSelection} onClick={() => stepSize(-1)}
          title="Smaller text" className={toolBtn(false)}
        >
          −
        </button>
        <button
          type="button" onMouseDown={captureSelection} onClick={() => stepSize(1)}
          title="Bigger text" className={toolBtn(false)}
        >
          +
        </button>
        <input
          type="color"
          value={selColor}
          onChange={e => setSelColor(e.target.value)}
          title="Pick a colour, then Apply"
          className="w-7 h-7 bg-un1t-bg border border-un1t-border rounded cursor-pointer"
        />
        <button
          type="button" onMouseDown={captureSelection} onClick={paintColor}
          title="Colour the selection / line" className={toolBtn(false)}
        >
          Apply
        </button>
        <button
          type="button" onMouseDown={captureSelection} onClick={() => toggleProp('bold')}
          title="Bold" aria-pressed={targetStyle.bold === true}
          className={`${toolBtn(targetStyle.bold === true)} font-bold`}
        >
          B
        </button>
        <button
          type="button" onMouseDown={captureSelection} onClick={() => toggleProp('underline')}
          title="Underline" aria-pressed={targetStyle.underline === true}
          className={`${toolBtn(targetStyle.underline === true)} underline`}
        >
          U
        </button>
        <button
          type="button" onMouseDown={captureSelection} onClick={clearStyles}
          title="Remove all styling from the selection / line" className={toolBtn(false)}
        >
          Clear
        </button>
      </div>
      <p className={`text-[10px] mb-2 ${selNote ? 'text-amber-400' : 'text-un1t-muted'}`}>
        {selNote || 'Highlight words to style just them — or click into a line to style that whole line.'}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-[10px] text-un1t-muted mb-0.5">Size</span>
          <input
            type="number" min={2} max={40} step={0.5}
            value={v.fontSize ?? 6}
            onChange={e => {
              const n = Number(e.target.value)
              onChange({ fontSize: Number.isFinite(n) ? Math.min(40, Math.max(2, n)) : 6 })
            }}
            className={cls}
          />
        </label>
        <label className="block">
          <span className="block text-[10px] text-un1t-muted mb-0.5">Line spacing</span>
          <input
            type="number" min={0.8} max={3} step={0.05}
            value={v.lineHeight ?? 1.15}
            onChange={e => {
              const n = Number(e.target.value)
              onChange({ lineHeight: Number.isFinite(n) ? Math.min(3, Math.max(0.8, n)) : 1.15 })
            }}
            className={cls}
          />
        </label>
        <label className="block">
          <span className="block text-[10px] text-un1t-muted mb-0.5">Weight</span>
          <select value={v.fontWeight ?? 700} onChange={e => onChange({ fontWeight: Number(e.target.value) })} className={cls}>
            {PUSH_FONT_WEIGHTS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] text-un1t-muted mb-0.5">Align</span>
          <select value={v.align ?? 'center'} onChange={e => onChange({ align: e.target.value })} className={cls}>
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] text-un1t-muted mb-0.5">Vertical</span>
          <select value={v.vAlign ?? 'middle'} onChange={e => onChange({ vAlign: e.target.value })} className={cls}>
            <option value="top">Top</option>
            <option value="middle">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] text-un1t-muted mb-0.5">Base colour</span>
          <input
            type="color"
            value={v.color ?? '#FFFFFF'}
            onChange={e => onChange({ color: e.target.value })}
            className="w-full h-7 bg-un1t-bg border border-un1t-border rounded cursor-pointer"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-un1t-subtle pt-4">
          <input type="checkbox" checked={!!v.uppercase} onChange={e => onChange({ uppercase: e.target.checked })} />
          UPPERCASE
        </label>
      </div>

      <p className="text-[10px] text-un1t-muted mt-2">
        Drag the zone on the preview to move it; drag the green corner to resize.
      </p>
    </div>
  )
}
