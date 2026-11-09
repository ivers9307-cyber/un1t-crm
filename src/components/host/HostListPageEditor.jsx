'use client'

// Public-page editor (HOST-GROWTH.B; branding + events copy since
// HOST-EVENTS-PAGE.1). Collapsible panel under the "Your public page" card:
// capped text fields, per-field default
// placeholders, save via PATCH /api/host/list-page. Empty field = use the
// default (stored as NULL).

import { useState } from 'react'
import { compressImageForUpload, parseUploadResponse } from '@/lib/landing-media-upload'
import { HOST_LABEL, HOST_SECTION, HOST_EYEBROW } from '@/components/host/host-ui'
import { HOST_ABOUT_MAX, HOST_PHOTOS_MAX, HOST_TESTIMONIALS_MAX } from '@/lib/host-page-extras'

const FIELDS = [
  { key: 'list_headline', label: 'Headline', max: 120, multiline: false, placeholder: 'Default: your host name' },
  { key: 'list_blurb', label: 'Intro text', max: 500, multiline: true, placeholder: 'Default: "Get emails about your events. Unsubscribe anytime."' },
  { key: 'list_button_label', label: 'Button label', max: 40, multiline: false, placeholder: 'Default: "Join the list"' },
  { key: 'list_success_message', label: 'Success message', max: 500, multiline: true, placeholder: "Default: \"We'll email you about upcoming events…\"" },
  // HOST-EVENTS-PAGE.1 — the events section + branding (mig 707).
  { key: 'events_headline', label: 'Events headline', max: 120, multiline: false, placeholder: 'Default: "Upcoming events"' },
  { key: 'events_blurb', label: 'Events intro', max: 500, multiline: true, placeholder: 'Default: none' },
  { key: 'hero_image_url', label: 'Hero image URL', max: 2000, multiline: false, placeholder: 'Default: the hero of your nearest upcoming event' },
  { key: 'accent_hex', label: 'Accent colour (#rrggbb)', max: 7, multiline: false, placeholder: 'Default: white' },
]

const INPUT_BASE = 'w-full rounded-lg border border-host-edge bg-host-input px-3 py-2 text-host-text placeholder:text-host-faint focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-host-accent'
const INPUT = `${INPUT_BASE} text-sm`
const INPUT_XS = `${INPUT_BASE} text-xs`
// Small secondary buttons and quiet text actions in this editor.
const BTN_SM = 'rounded-lg border border-host-edge bg-host-panel px-3 py-1.5 text-xs text-host-text hover:bg-host-hover'
const TEXT_ACTION = 'text-xs text-host-hint hover:text-host-text'
const REMOVE_ACTION = 'text-xs text-host-hint hover:text-host-bad'

// HOSTPAGE.2 — the page extras (mig 823) ride the same editor and PATCH.
const EXTRA_KEYS = ['about_text', 'photos', 'testimonials', 'show_past_events', 'show_ratings']

export default function HostListPageEditor({ initial, previewUrl, onClose, onSaved, layout = 'drawer' }) {
  const [values, setValues] = useState(() => {
    const v = {}
    for (const f of FIELDS) v[f.key] = initial?.[f.key] || ''
    v.about_text = initial?.about_text || ''
    v.photos = Array.isArray(initial?.photos) ? initial.photos.map((p) => ({ url: p.url, caption: p.caption || '' })) : []
    v.testimonials = Array.isArray(initial?.testimonials) ? initial.testimonials.map((t) => ({ quote: t.quote, author: t.author || '' })) : []
    v.show_past_events = initial?.show_past_events !== false
    v.show_ratings = initial?.show_ratings !== false
    return v
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // 'sections' layout only: the confirmation that stands in for the drawer closing.
  const [saved, setSaved] = useState(false)
  const [uploading, setUploading] = useState(false)

  // Every edit clears the "Saved." confirmation.
  const edit = (updater) => { setSaved(false); setValues(updater) }
  const setExtra = (key, val) => edit((v) => ({ ...v, [key]: val }))
  const updateTestimonial = (i, patch) => setExtra('testimonials', values.testimonials.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  const updateCaption = (i, caption) => setExtra('photos', values.photos.map((p, j) => (j === i ? { ...p, caption } : p)))

  async function uploadPhoto(file) {
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', await compressImageForUpload(file))
      const res = await fetch('/api/host/list-page/photos', { method: 'POST', body: form })
      const r = await parseUploadResponse(res)
      if (!r.success) throw new Error(r.error)
      setExtra('photos', [...values.photos, { url: r.url, caption: '' }])
    } catch (e) {
      setError(e.message)
    } finally {
      setUploading(false)
    }
  }

  async function removePhoto(url) {
    setError(null)
    try {
      const res = await fetch(`/api/host/list-page/photos?url=${encodeURIComponent(url)}`, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || 'Could not remove the photo.')
      setExtra('photos', values.photos.filter((p) => p.url !== url))
    } catch (e) {
      setError(e.message)
    }
  }

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch('/api/host/list-page', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadOf(values)),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || 'Could not save — try again.')
      // The PATCH returns the patch actually written (trimmed, nulls for
      // cleared fields) — merge it over the submitted values so state
      // reflects the server's canonical copy, not the raw client input.
      const canonical = { ...values }
      if (j.data) for (const k of Object.keys(j.data)) canonical[k] = EXTRA_KEYS.includes(k) ? (j.data[k] ?? canonical[k]) : (j.data[k] ?? '')
      // The sections layout has no drawer to close: show the server's copy and say so.
      if (layout === 'sections') { setValues(canonical); setSaved(true) }
      onSaved(canonical)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const field = (key) => {
    const f = FIELDS.find((x) => x.key === key)
    return (
      <div key={f.key}>
        <label htmlFor={`lp-${f.key}`} className={`${HOST_LABEL} mb-1`}>
          {f.label} <span className="text-host-hint">({(values[f.key] || '').length}/{f.max})</span>
        </label>
        {f.multiline ? (
          <textarea id={`lp-${f.key}`} rows={3} maxLength={f.max} value={values[f.key]} placeholder={f.placeholder}
            onChange={(e) => edit((v) => ({ ...v, [f.key]: e.target.value }))} className={INPUT} />
        ) : (
          <input id={`lp-${f.key}`} maxLength={f.max} value={values[f.key]} placeholder={f.placeholder}
            onChange={(e) => edit((v) => ({ ...v, [f.key]: e.target.value }))} className={INPUT} />
        )}
      </div>
    )
  }

  const aboutField = (
    <div>
      <label htmlFor="lp-about" className={`${HOST_LABEL} mb-1`}>
        About <span className="text-host-hint">({values.about_text.length}/{HOST_ABOUT_MAX})</span>
      </label>
      <textarea id="lp-about" rows={4} maxLength={HOST_ABOUT_MAX} value={values.about_text} placeholder="Who you are and what your events are like. Blank lines make paragraphs."
        onChange={(e) => setExtra('about_text', e.target.value)} className={INPUT} />
    </div>
  )

  const photosBlock = (
    <div>
      <div className="flex items-center justify-between">
        <p className={HOST_LABEL}>Photos <span className="text-host-hint">({values.photos.length}/{HOST_PHOTOS_MAX})</span></p>
        {values.photos.length < HOST_PHOTOS_MAX && (
          <label className={`cursor-pointer ${BTN_SM}`}>
            {uploading ? 'Uploading…' : 'Add photo'}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Add photo" disabled={uploading}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadPhoto(f) }} />
          </label>
        )}
      </div>
      {values.photos.length > 0 && (
        <ul className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {values.photos.map((p, i) => (
            <li key={p.url} className="rounded-lg border border-host-border p-2">
              <img src={p.url} alt={p.caption || `Photo ${i + 1}`} className="h-24 w-full rounded object-cover" />
              <input value={p.caption} maxLength={120} placeholder="Caption (optional)" aria-label={`Caption for photo ${i + 1}`}
                onChange={(e) => updateCaption(i, e.target.value)} className={`${INPUT_XS} mt-2`} />
              <button type="button" onClick={() => removePhoto(p.url)} className={`mt-1 ${REMOVE_ACTION}`} aria-label={`Remove photo ${i + 1}`}>Remove photo</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  const testimonialsBlock = (
    <div>
      <div className="flex items-center justify-between">
        <p className={HOST_LABEL}>Testimonials <span className="text-host-hint">({values.testimonials.length}/{HOST_TESTIMONIALS_MAX})</span></p>
        {values.testimonials.length < HOST_TESTIMONIALS_MAX && (
          <button type="button" onClick={() => setExtra('testimonials', [...values.testimonials, { quote: '', author: '' }])}
            className={BTN_SM}>Add testimonial</button>
        )}
      </div>
      {values.testimonials.map((t, i) => (
        <div key={i} className="mt-2 rounded-lg border border-host-border p-2 space-y-2">
          <label className={HOST_LABEL}>Quote {i + 1}
            <textarea rows={2} maxLength={400} value={t.quote} onChange={(e) => updateTestimonial(i, { quote: e.target.value })} className={`${INPUT} mt-1`} />
          </label>
          <div className="flex items-center gap-2">
            <label className={`flex-1 ${HOST_LABEL}`}>Author {i + 1}
              <input maxLength={80} value={t.author} onChange={(e) => updateTestimonial(i, { author: e.target.value })} className={`${INPUT} mt-1`} />
            </label>
            <button type="button" onClick={() => setExtra('testimonials', values.testimonials.filter((_, j) => j !== i))} className={REMOVE_ACTION}>Remove</button>
          </div>
        </div>
      ))}
    </div>
  )

  const showPastEvents = (
    <label className="flex items-center gap-2"><input type="checkbox" checked={values.show_past_events} onChange={(e) => setExtra('show_past_events', e.target.checked)} /> Show past events</label>
  )
  const showRatings = (
    <label className="flex items-center gap-2"><input type="checkbox" checked={values.show_ratings} onChange={(e) => setExtra('show_ratings', e.target.checked)} /> Show ratings</label>
  )

  const previewLink = (
    <a href={previewUrl} target="_blank" rel="noopener noreferrer" className={`ml-auto ${TEXT_ACTION}`}>
      Preview →
    </a>
  )
  const saveButton = (
    <button type="button" onClick={save} disabled={saving}
      className="rounded-lg bg-host-accent text-host-on-accent text-xs font-semibold px-4 py-2 hover:opacity-90 disabled:opacity-50">
      {saving ? 'Saving…' : 'Save'}
    </button>
  )

  // /host/page: the same fields grouped in the order a visitor meets them.
  if (layout === 'sections') {
    // A plain function, not a component: a component declared in render would
    // remount (and drop focus from) every input on each keystroke.
    const section = (title, children) => (
      <section key={title} className="space-y-3">
        <h2 className={HOST_SECTION}>{title}</h2>
        {children}
      </section>
    )
    return (
      <div className="mt-4 space-y-6">
        {section('Top of page', ['list_headline', 'list_blurb', 'hero_image_url', 'accent_hex'].map(field))}
        {section('About you', aboutField)}
        {section('Upcoming events', ['events_headline', 'events_blurb'].map(field))}
        {section('Photos', photosBlock)}
        {section('What people say', <>{testimonialsBlock}<div className="text-xs text-host-label">{showRatings}</div></>)}
        {section('Past events', <div className="text-xs text-host-label">{showPastEvents}</div>)}
        {section('Join the list', ['list_button_label', 'list_success_message'].map(field))}
        {error && <p className="text-sm text-host-bad">{error}</p>}
        <div className="flex items-center gap-2">
          {saveButton}
          {saved && <span role="status" className="text-xs text-host-ok">Saved.</span>}
          {previewLink}
        </div>
      </div>
    )
  }

  return (
    <div className="mt-3 rounded-xl border border-host-border bg-host-panel p-4 space-y-3">
      {FIELDS.map((f) => field(f.key))}

      {/* HOSTPAGE.2 — page extras */}
      <div className="border-t border-host-border pt-3 space-y-3">
        <h3 className={HOST_EYEBROW}>Page extras</h3>
        {aboutField}
        {photosBlock}
        {testimonialsBlock}
        <div className="flex flex-wrap gap-4 text-xs text-host-label">
          {showPastEvents}
          {showRatings}
        </div>
      </div>

      {error && <p className="text-sm text-host-bad">{error}</p>}
      <div className="flex items-center gap-2">
        {saveButton}
        <button type="button" onClick={onClose} className={`${TEXT_ACTION} px-2 py-2`}>Cancel</button>
        {previewLink}
      </div>
    </div>
  )
}

// What the PATCH accepts: the copy fields as typed, the extras in their schema
// shape (empty captions/authors become null; an empty quote is dropped).
function payloadOf(values) {
  const out = {}
  for (const f of FIELDS) out[f.key] = values[f.key]
  out.about_text = values.about_text
  out.photos = values.photos.map((p) => ({ url: p.url, caption: p.caption?.trim() ? p.caption.trim() : null }))
  out.testimonials = values.testimonials.filter((t) => t.quote?.trim()).map((t) => ({ quote: t.quote.trim(), author: t.author?.trim() ? t.author.trim() : null }))
  out.show_past_events = values.show_past_events
  out.show_ratings = values.show_ratings
  return out
}
