'use client'

// ChooserEditorForm — edits the public FRONT PAGE (the un1tdublin.com
// split chooser at /welcome). Distinct from LandingPageSettingsForm,
// which edits an individual studio's marketing page.
//
// Editable (per the product spec):
//   - page-level headline + intro (optional, shown across the split)
//   - tile order (which studio is left/first)
//   - per-tile: display label, CTA button text, full-screen cover image
//
// Saves via PUT /api/chooser-settings (label/CTA/order + headline/intro)
// and POST /api/chooser-settings/tile-image (cover upload, per studio).

import { useState } from 'react'
import { Loader2, Save, AlertCircle, ImagePlus, ArrowUp, ArrowDown, ExternalLink } from 'lucide-react'

export default function ChooserEditorForm({ initialChooser, initialTiles }) {
  const [headline, setHeadline] = useState(initialChooser?.headline || '')
  const [intro, setIntro]       = useState(initialChooser?.intro || '')

  // Order the tiles by the saved tile_order, appending any not listed.
  const order = Array.isArray(initialChooser?.tile_order) ? initialChooser.tile_order : []
  const sorted = [...(initialTiles || [])].sort((a, b) => {
    const ia = order.indexOf(a.public_path); const ib = order.indexOf(b.public_path)
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })
  const [tiles, setTiles] = useState(sorted)

  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)
  const [savedAt, setSavedAt] = useState(null)
  const [uploading, setUploading] = useState({})  // { location_id: bool }

  function move(idx, dir) {
    setTiles((prev) => {
      const next = [...prev]
      const j = idx + dir
      if (j < 0 || j >= next.length) return prev
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }

  function patchTile(locId, patch) {
    setTiles((prev) => prev.map((t) => t.location_id === locId ? { ...t, ...patch } : t))
  }

  async function uploadCover(tile, file) {
    if (!file) return
    setUploading((u) => ({ ...u, [tile.location_id]: true }))
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('location_id', tile.location_id)
      const r = await fetch('/api/chooser-settings/tile-image', { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok || j.success === false) { setError(j.error || 'Upload failed'); return }
      patchTile(tile.location_id, { chooser_image_url: j.data.url })
    } catch (e) {
      setError(e.message || 'Upload failed')
    } finally {
      setUploading((u) => ({ ...u, [tile.location_id]: false }))
    }
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const r = await fetch('/api/chooser-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headline: headline.trim() || null,
          intro: intro.trim() || null,
          tile_order: tiles.map((t) => t.public_path),
          tiles: tiles.map((t) => ({
            location_id: t.location_id,
            public_path: t.public_path,
            chooser_label: (t.chooser_label || '').trim() || null,
            chooser_cta_text: (t.chooser_cta_text || '').trim() || null,
            publish_state: t.publish_state || 'hidden',
          })),
        }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) { setError(j.error || `Save failed (${r.status})`); return }
      setSavedAt(new Date())
    } catch (e) {
      setError(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-5 max-w-3xl">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex items-center gap-3 pb-1">
        <a href="/welcome" target="_blank" rel="noopener noreferrer"
           className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300">
          <ExternalLink size={13} /> Preview front page
        </a>
        {savedAt && !saving && <span className="text-xs text-emerald-700">Saved {savedAt.toLocaleTimeString('en-IE')}</span>}
      </div>

      {/* Page-level copy */}
      <section className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Front page copy</h3>
        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Headline (optional)</label>
          <input type="text" value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={200}
            placeholder="Choose your studio"
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text" />
        </div>
        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Intro line (optional)</label>
          <input type="text" value={intro} onChange={(e) => setIntro(e.target.value)} maxLength={600}
            placeholder="Two Dublin studios — pick the one nearest you."
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text" />
        </div>
        <p className="text-[11px] text-un1t-muted">Both are optional — leave blank to show just the two studio tiles.</p>
      </section>

      {/* Tiles */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
          Tiles <span className="text-un1t-muted normal-case">(top = left / first)</span>
        </h3>
        {tiles.map((t, idx) => (
          <div key={t.location_id} className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <div className="text-sm font-semibold text-un1t-text">{t.name}</div>
                <div className="text-[11px] text-un1t-muted font-mono">/{t.public_path}</div>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => move(idx, -1)} disabled={idx === 0}
                  className="p-1 text-un1t-subtle hover:text-un1t-text disabled:opacity-30" title="Move up / left">
                  <ArrowUp size={14} />
                </button>
                <button type="button" onClick={() => move(idx, 1)} disabled={idx === tiles.length - 1}
                  className="p-1 text-un1t-subtle hover:text-un1t-text disabled:opacity-30" title="Move down / right">
                  <ArrowDown size={14} />
                </button>
              </div>
            </div>

            {/* Visibility — Live / Coming soon / Hidden (publish_state). */}
            <div className="mb-3">
              <label className="block text-xs text-un1t-subtle mb-1">Visibility</label>
              <div className="inline-flex rounded-md border border-un1t-border overflow-hidden">
                {[
                  { v: 'live', label: 'Live' },
                  { v: 'coming_soon', label: 'Coming soon' },
                  { v: 'hidden', label: 'Hidden' },
                ].map((opt) => {
                  const active = (t.publish_state || 'hidden') === opt.v
                  return (
                    <button
                      key={opt.v}
                      type="button"
                      onClick={() => patchTile(t.location_id, { publish_state: opt.v })}
                      className={`px-3 py-1.5 text-xs font-medium border-r border-un1t-border last:border-r-0 ${active ? 'bg-un1t-text text-un1t-bg' : 'bg-un1t-bg text-un1t-subtle hover:text-un1t-text'}`}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] text-un1t-muted mt-1">
                Live = clickable tile + page reachable. Coming soon = dimmed teaser tile, page not reachable. Hidden = removed from the front page.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-un1t-subtle mb-1">Tile label</label>
                <input type="text" value={t.chooser_label || ''} maxLength={200}
                  onChange={(e) => patchTile(t.location_id, { chooser_label: e.target.value })}
                  placeholder={t.name}
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text" />
                <p className="text-[11px] text-un1t-muted mt-1">Blank = the studio name.</p>
              </div>
              <div>
                <label className="block text-xs text-un1t-subtle mb-1">Button text</label>
                <input type="text" value={t.chooser_cta_text || ''} maxLength={60}
                  onChange={(e) => patchTile(t.location_id, { chooser_cta_text: e.target.value })}
                  placeholder="Enter"
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text" />
                <p className="text-[11px] text-un1t-muted mt-1">Blank = &ldquo;Enter&rdquo;.</p>
              </div>
            </div>

            <div className="mt-3">
              <label className="block text-xs text-un1t-subtle mb-1">Cover image</label>
              <div className="flex items-center gap-3">
                {t.chooser_image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={t.chooser_image_url} alt="" className="w-28 h-16 object-cover rounded-md border border-un1t-border" />
                ) : (
                  <div className="w-28 h-16 rounded-md border border-dashed border-un1t-border bg-un1t-bg flex items-center justify-center text-[10px] text-un1t-muted">No cover</div>
                )}
                <label className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 cursor-pointer">
                  {uploading[t.location_id] ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
                  {uploading[t.location_id] ? 'Uploading…' : 'Upload cover'}
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                    onChange={(e) => uploadCover(t, e.target.files?.[0])} />
                </label>
              </div>
              <p className="text-[11px] text-un1t-muted mt-1">Full-screen background for this tile. PNG/JPEG/WebP, ≤ 8MB. Saves immediately.</p>
            </div>
          </div>
        ))}
        {tiles.length === 0 && (
          <p className="text-sm text-un1t-subtle italic">No studio pages yet — create a studio landing page first.</p>
        )}
      </section>

      <div className="sticky bottom-4 flex items-center justify-end gap-2 bg-un1t-surface/80 backdrop-blur border border-un1t-border rounded-md p-3">
        <a href="/welcome" target="_blank" rel="noopener noreferrer"
           className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1.5">
          <ExternalLink size={12} /> Preview
        </a>
        <button type="submit" disabled={saving}
          className="inline-flex items-center gap-2 bg-un1t-text text-un1t-bg font-semibold text-sm py-2 px-4 rounded-md hover:bg-un1t-accent disabled:opacity-50">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving…' : 'Save front page'}
        </button>
      </div>
    </form>
  )
}
