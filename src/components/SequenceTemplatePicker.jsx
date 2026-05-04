'use client'

// SequenceTemplatePicker — modal that lists every sequence
// recipe in src/lib/sequence-templates.js + clones the picked one
// into a fresh draft sequence (Tier 3B).
//
// Lives next to the "New Sequence" button on
// /communications/sequences. Opens a modal, fetches the template
// list lazily, and on click POSTs to /api/sequences/from-template
// then redirects the operator into the editor for the new draft.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { LayoutTemplate, Loader2, X } from 'lucide-react'

export default function SequenceTemplatePicker() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [templates, setTemplates] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [createError, setCreateError] = useState(null)

  async function openPicker() {
    setOpen(true)
    if (templates !== null) return
    try {
      const r = await fetch('/api/sequences/from-template', { cache: 'no-store' })
      const j = await r.json()
      if (!j?.success) {
        setLoadError(j?.error || 'Could not load templates')
      } else {
        setTemplates(j.data || [])
      }
    } catch (e) {
      setLoadError(e.message || 'Network error')
    }
  }

  async function pick(id) {
    setBusyId(id)
    setCreateError(null)
    try {
      const r = await fetch('/api/sequences/from-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: id }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setCreateError(j.error || `Create failed (${r.status})`)
        setBusyId(null)
        return
      }
      router.push(`/email/sequences/${j.data.sequence_id}`)
    } catch (e) {
      setCreateError(e.message || 'Network error')
      setBusyId(null)
    }
  }

  // Group by category for nicer scanning.
  const grouped = templates
    ? templates.reduce((acc, t) => {
        const k = t.category || 'Other'
        if (!acc[k]) acc[k] = []
        acc[k].push(t)
        return acc
      }, {})
    : null

  return (
    <>
      <button
        type="button"
        onClick={openPicker}
        className="inline-flex items-center gap-2 border border-un1t-gray text-un1t-light text-sm font-medium px-4 py-2 rounded-lg hover:text-un1t-white hover:border-un1t-mid transition-colors"
      >
        <LayoutTemplate size={16} />
        Use template
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div
            className="bg-un1t-dark border border-un1t-gray rounded-xl max-w-3xl w-full max-h-[80vh] overflow-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-un1t-white">Pick a template</h3>
                <p className="text-xs text-un1t-light mt-0.5">
                  Clones into a fresh draft you can rename, edit, and activate.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-un1t-light hover:text-un1t-white p-1"
              >
                <X size={16} />
              </button>
            </div>

            {createError && (
              <div className="mb-3 bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-2">
                {createError}
              </div>
            )}

            {loadError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3">
                {loadError}
              </div>
            )}

            {!templates && !loadError && (
              <div className="text-sm text-un1t-light inline-flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" /> Loading…
              </div>
            )}

            {grouped && Object.keys(grouped).map((category) => (
              <div key={category} className="mb-5">
                <div className="text-[11px] uppercase tracking-wider text-un1t-light mb-2">{category}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {grouped[category].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => pick(t.id)}
                      disabled={busyId !== null}
                      className="text-left bg-un1t-black border border-un1t-gray hover:border-un1t-mid rounded-lg p-3 disabled:opacity-40"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium text-un1t-white">{t.name}</div>
                        {busyId === t.id && <Loader2 size={12} className="animate-spin text-un1t-light" />}
                      </div>
                      <div className="text-xs text-un1t-light mt-1">{t.description}</div>
                      <div className="text-[10px] uppercase tracking-wider text-un1t-mid mt-2">
                        {t.trigger_type.replaceAll('_', ' ')} · {t.step_count} step{t.step_count === 1 ? '' : 's'}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
