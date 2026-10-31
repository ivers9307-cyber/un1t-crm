'use client'

// MEDIALIB.1 — "Choose existing": a small picker over the media the
// organisation's pages have already uploaded (GET /api/landing-pages/media,
// scoped server-side to the pages the caller may view). The operator picks
// a clip or image and the caller applies its URL through the SAME setter the
// upload path uses, so the preview and the poster logic behave exactly as
// after an upload. The picker never uploads, moves or deletes anything.
//
// Used from the in-preview hero toolbar (HeroMediaTools, inside the
// same-origin editor iframe, so the session cookies travel) and from the
// form's media slots (LandingPageSettingsForm). The Modal is portalled to
// document.body: the hero toolbar sits under a backdrop-blur and the reveal
// animations transform their sections, either of which would pin a fixed
// dialog inside its parent; the form's read-only fieldset cannot reach a
// portalled panel, which is fine, since only a button inside it opens one.
// The list is fetched each time it opens so a clip uploaded a moment ago shows.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Modal } from '@/components/ui'

export const MEDIA_LIBRARY_URL = '/api/landing-pages/media'

export function formatMediaSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function formatMediaDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * @param {{ open: boolean, kind: 'video'|'image', onClose: () => void, onPick: (item: object) => void, title?: string }} props
 */
export default function MediaPicker({ open, kind, onClose, onPick, title }) {
  const [state, setState] = useState({ loading: false, error: null, items: [] })
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setState({ loading: true, error: null, items: [] })
    ;(async () => {
      let next
      try {
        const r = await fetch(`${MEDIA_LIBRARY_URL}?kind=${encodeURIComponent(kind)}`, { credentials: 'same-origin' })
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j?.success === false) {
          next = { loading: false, error: j?.error === 'unavailable' ? 'The media library could not be read. Try again.' : (j?.error || `Could not load the media library (${r.status}).`), items: [] }
        } else {
          next = { loading: false, error: null, items: Array.isArray(j?.data?.items) ? j.data.items : [] }
        }
      } catch (e) {
        next = { loading: false, error: `Network error: ${e?.message || e}`, items: [] }
      }
      if (!cancelled) setState(next)
    })()
    return () => { cancelled = true }
  }, [open, kind])

  const noun = kind === 'video' ? 'video' : 'image'
  if (!mounted || !open) return null
  return createPortal(
    <Modal open={open} onClose={onClose} title={title || `Choose an existing ${noun}`} size="lg">
      <div className="text-xs text-un1t-muted mb-3">
        {kind === 'video'
          ? 'Videos already uploaded for your pages. Picking one reuses the same file, so nothing is uploaded again.'
          : 'Images already uploaded for your pages. Picking one reuses the same file, so nothing is uploaded again.'}
      </div>
      {state.loading && <p className="text-sm text-un1t-subtle py-6 text-center">Loading…</p>}
      {!state.loading && state.error && <p className="text-sm text-red-700 py-6 text-center">{state.error}</p>}
      {!state.loading && !state.error && state.items.length === 0 && (
        <p className="text-sm text-un1t-subtle py-6 text-center">No {noun}s uploaded yet. Upload one with Add {noun} and it will show here next time.</p>
      )}
      {!state.loading && !state.error && state.items.length > 0 && (
        <ul className="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto pr-1" data-testid="media-picker-list">
          {state.items.map((item) => (
            <li key={item.url}>
              <button
                type="button"
                onClick={() => { onPick?.(item); onClose?.() }}
                className="w-full text-left border border-un1t-border rounded-md overflow-hidden bg-un1t-bg hover:border-un1t-text focus:outline-none focus:ring-2 focus:ring-un1t-text/40"
                title={item.name}
              >
                <MediaThumb item={item} />
                <div className="p-2">
                  <div className="text-[11px] font-medium text-un1t-text truncate">{item.page_title || 'Page'}</div>
                  <div className="text-[10px] text-un1t-muted truncate">
                    {[formatMediaDate(item.created_at), formatMediaSize(item.size)].filter(Boolean).join(' · ')}
                  </div>
                  <div className="text-[10px] text-un1t-subtle truncate">{item.name}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>,
    document.body,
  )
}

function MediaThumb({ item }) {
  if (item.kind === 'video') {
    return item.poster_url
      ? <img src={item.poster_url} alt="" className="w-full aspect-video object-cover bg-black" />
      : <video src={item.url} className="w-full aspect-video object-cover bg-black" muted playsInline preload="metadata" />
  }
  return <img src={item.url} alt="" className="w-full aspect-video object-cover bg-un1t-surface" />
}
