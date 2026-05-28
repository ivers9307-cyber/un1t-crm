'use client'

// RADAR-OUTREACH.1 — one-click WhatsApp utility-template outreach.
//
// A small button that drops down the active location's approved
// WhatsApp UTILITY templates; picking one calls onSelect(templateName).
// The parent radar's runAction owns the POST + flash + reload, so this
// component is purely the picker UI.
//
// The template list is fetched once and memoised module-side, so
// dropping this button onto every radar row costs a single request.

import { useState, useRef, useEffect, useCallback } from 'react'
import { MessageCircle, X } from 'lucide-react'

let templatesCache = null
let templatesInflight = null

async function fetchTemplatesOnce() {
  if (templatesCache) return templatesCache
  if (!templatesInflight) {
    templatesInflight = fetch('/api/radar-outreach/templates', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (!j?.success) throw new Error(j?.error || 'Failed to load templates')
        templatesCache = Array.isArray(j.data?.templates) ? j.data.templates : []
        return templatesCache
      })
      .finally(() => { templatesInflight = null })
  }
  return templatesInflight
}

export default function RadarOutreachButton({ contactName, disabled, busy, onSelect }) {
  const [open, setOpen] = useState(false)
  const [templates, setTemplates] = useState(templatesCache)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const ref = useRef(null)

  // Lazy-load the template list the first time the picker is opened.
  useEffect(() => {
    if (!open || templates !== null) return
    setLoading(true)
    setError(null)
    fetchTemplatesOnce()
      .then((list) => setTemplates(list))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open, templates])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = useCallback((name) => {
    setOpen(false)
    onSelect(name)
  }, [onSelect])

  const sendable = (templates || []).filter((t) => t.sendable)

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex items-center gap-1 rounded-md border border-un1t-border bg-un1t-bg px-2.5 py-1 text-xs font-medium text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
      >
        <MessageCircle size={13} />
        WhatsApp
      </button>

      {open && (
        <div className="absolute left-0 z-20 mt-1 w-72 rounded-lg border border-un1t-border bg-un1t-bg p-2 shadow-xl">
          <div className="flex items-start justify-between gap-2 px-1 pb-1.5">
            <p className="text-[11px] font-semibold text-un1t-subtle">
              Send a WhatsApp to {contactName || 'this contact'}
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="shrink-0 text-un1t-muted hover:text-un1t-text"
              aria-label="Close"
            >
              <X size={13} />
            </button>
          </div>

          {loading && <p className="px-1 py-3 text-xs text-un1t-subtle">Loading templates…</p>}
          {error && <p className="px-1 py-3 text-xs text-red-400">{error}</p>}

          {!loading && !error && sendable.length === 0 && (
            <p className="px-1 py-3 text-xs text-un1t-subtle">
              No approved utility templates yet. Create one under WhatsApp &rarr; Templates
              (category: Utility) and sync.
            </p>
          )}

          {!loading && !error && sendable.length > 0 && (
            <ul className="max-h-64 overflow-y-auto">
              {sendable.map((t) => (
                <li key={t.name}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => pick(t.name)}
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-un1t-border/40 disabled:opacity-50"
                  >
                    <span className="block text-xs font-medium text-un1t-text">{t.name}</span>
                    {t.bodyText && (
                      <span className="mt-0.5 block text-[11px] leading-snug text-un1t-subtle">
                        {t.bodyText}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-1 border-t border-un1t-border px-1 pt-1.5 text-[10px] text-un1t-muted">
            Utility message &mdash; a one-off, not marketing.
          </p>
        </div>
      )}
    </div>
  )
}
