'use client'

// Public-page editor (HOST-GROWTH.B; branding + events copy since
// HOST-EVENTS-PAGE.1). Collapsible panel under the "Your public page" card:
// capped text fields, per-field default
// placeholders, save via PATCH /api/host/list-page. Empty field = use the
// default (stored as NULL).

import { useState } from 'react'
import { compressImageForUpload, parseUploadResponse } from '@/lib/landing-media-upload'
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

const INPUT = 'w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/40'

// HOSTPAGE.2 — the page extras (mig 823) ride the same editor and PATCH.
const EXTRA_KEYS = ['about_text', 'photos', 'testimonials', 'show_past_events', 'show_ratings']

export default function HostListPageEditor({ initial, previewUrl, onClose, onSaved }) {
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
  const [uploading, setUploading] = useState(false)

  const setExtra = (key, val) => setValues((v) => ({ ...v, [key]: val }))
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
      onSaved(canonical)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
      {FIELDS.map((f) => (
        <div key={f.key}>
          <label htmlFor={`lp-${f.key}`} className="block text-xs text-white/50 mb-1">
            {f.label} <span className="text-white/30">({(values[f.key] || '').length}/{f.max})</span>
          </label>
          {f.multiline ? (
            <textarea id={`lp-${f.key}`} rows={3} maxLength={f.max} value={values[f.key]} placeholder={f.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className={INPUT} />
          ) : (
            <input id={`lp-${f.key}`} maxLength={f.max} value={values[f.key]} placeholder={f.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className={INPUT} />
          )}
        </div>
      ))}

      {/* HOSTPAGE.2 — page extras */}
      <div className="border-t border-white/10 pt-3 space-y-3">
        <h3 className="text-xs uppercase tracking-[0.15em] text-white/45">Page extras</h3>
        <div>
          <label htmlFor="lp-about" className="block text-xs text-white/50 mb-1">
            About <span className="text-white/30">({values.about_text.length}/{HOST_ABOUT_MAX})</span>
          </label>
          <textarea id="lp-about" rows={4} maxLength={HOST_ABOUT_MAX} value={values.about_text} placeholder="Who you are and what your events are like. Blank lines make paragraphs."
            onChange={(e) => setExtra('about_text', e.target.value)} className={INPUT} />
        </div>

        <div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-white/50">Photos <span className="text-white/30">({values.photos.length}/{HOST_PHOTOS_MAX})</span></p>
            {values.photos.length < HOST_PHOTOS_MAX && (
              <label className="cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/5">
                {uploading ? 'Uploading…' : 'Add photo'}
                <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Add photo" disabled={uploading}
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadPhoto(f) }} />
              </label>
            )}
          </div>
          {values.photos.length > 0 && (
            <ul className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {values.photos.map((p, i) => (
                <li key={p.url} className="rounded-lg border border-white/10 p-2">
                  <img src={p.url} alt={p.caption || `Photo ${i + 1}`} className="h-24 w-full rounded object-cover" />
                  <input value={p.caption} maxLength={120} placeholder="Caption (optional)" aria-label={`Caption for photo ${i + 1}`}
                    onChange={(e) => updateCaption(i, e.target.value)} className={`${INPUT} mt-2 text-xs`} />
                  <button type="button" onClick={() => removePhoto(p.url)} className="mt-1 text-xs text-white/40 hover:text-red-300" aria-label={`Remove photo ${i + 1}`}>Remove photo</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-white/50">Testimonials <span className="text-white/30">({values.testimonials.length}/{HOST_TESTIMONIALS_MAX})</span></p>
            {values.testimonials.length < HOST_TESTIMONIALS_MAX && (
              <button type="button" onClick={() => setExtra('testimonials', [...values.testimonials, { quote: '', author: '' }])}
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/5">Add testimonial</button>
            )}
          </div>
          {values.testimonials.map((t, i) => (
            <div key={i} className="mt-2 rounded-lg border border-white/10 p-2 space-y-2">
              <label className="block text-xs text-white/50">Quote {i + 1}
                <textarea rows={2} maxLength={400} value={t.quote} onChange={(e) => updateTestimonial(i, { quote: e.target.value })} className={`${INPUT} mt-1`} />
              </label>
              <div className="flex items-center gap-2">
                <label className="block flex-1 text-xs text-white/50">Author {i + 1}
                  <input maxLength={80} value={t.author} onChange={(e) => updateTestimonial(i, { author: e.target.value })} className={`${INPUT} mt-1`} />
                </label>
                <button type="button" onClick={() => setExtra('testimonials', values.testimonials.filter((_, j) => j !== i))} className="text-xs text-white/40 hover:text-red-300">Remove</button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-4 text-xs text-white/70">
          <label className="flex items-center gap-2"><input type="checkbox" checked={values.show_past_events} onChange={(e) => setExtra('show_past_events', e.target.checked)} /> Show past events</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={values.show_ratings} onChange={(e) => setExtra('show_ratings', e.target.checked)} /> Show ratings</label>
        </div>
      </div>

      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={save} disabled={saving}
          className="rounded-lg bg-white text-black text-xs font-semibold px-4 py-2 hover:bg-white/90 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onClose} className="text-xs text-white/50 hover:text-white px-2 py-2">Cancel</button>
        <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="ml-auto text-xs text-white/40 hover:text-white">
          Preview →
        </a>
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
