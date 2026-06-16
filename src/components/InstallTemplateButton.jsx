'use client'

// InstallTemplateButton — small client-side button used on the
// Flow templates gallery (/automations/templates).
// Posts to the existing /api/sequences/from-template endpoint and
// redirects into the editor for the freshly-cloned draft. Same
// endpoint the older SequenceTemplatePicker modal uses; this is
// just the per-card affordance on the gallery page.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Loader2 } from 'lucide-react'

export default function InstallTemplateButton({ templateId, templateName }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function install() {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/sequences/from-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: templateId }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Install failed (${r.status})`)
      router.push(`/automations/${j.data.sequence_id}`)
    } catch (e) {
      setError(e.message || 'Install failed')
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={install}
        disabled={busy}
        aria-label={`Install ${templateName}`}
        className="inline-flex items-center gap-1.5 bg-un1t-text text-un1t-bg text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
        {busy ? 'Installing…' : 'Install'}
      </button>
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  )
}
