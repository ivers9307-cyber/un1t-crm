'use client'

// FLOW-GRAPH Phase 3 (PR2) — "Build with AI" panel. Sends a plain-English ask to
// POST /api/sequences/[id]/graph/agent, which saves the agent's flow as a DRAFT.
// On success we router.refresh() so the server page re-resolves the graph
// (draft takes precedence) and the builder re-renders with the draft for review.
// Nothing is published — the operator reviews + clicks Publish.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui'

export default function AgentPanel({ sequenceId }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const generate = async () => {
    if (!prompt.trim()) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/sequences/${sequenceId}/graph/agent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
      })
      const data = await res.json()
      if (data.success) { setOpen(false); router.refresh() }
      else setError(data.error || 'Could not build the flow — try rephrasing.')
    } catch { setError('Network error talking to the AI.') } finally { setBusy(false) }
  }

  return (
    <div className="max-w-md mx-auto mb-4 border border-un1t-border rounded-lg bg-un1t-surface">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-4 py-3 text-left">
        {open ? <ChevronDown size={15} className="text-un1t-subtle" /> : <ChevronRight size={15} className="text-un1t-subtle" />}
        <Sparkles size={15} className="text-un1t-text" />
        <span className="text-sm font-medium text-un1t-text">Build with AI</span>
        <span className="ml-auto text-xs text-un1t-subtle">describe it in plain English</span>
      </button>
      {open && (
        <div className="border-t border-un1t-border px-4 py-3 space-y-2">
          <textarea
            value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} disabled={busy}
            placeholder="e.g. A 3-day welcome flow: email straight away, wait a day then WhatsApp, and if they still haven’t booked, send an SMS nudge."
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-subtle/60 focus:outline-none focus:ring-1 focus:ring-un1t-text/30 resize-y disabled:opacity-60"
          />
          <p className="text-[11px] text-un1t-subtle">The AI drafts the flow for this sequence’s trigger. Nothing goes live until you review &amp; Publish. <strong>This replaces the current draft.</strong></p>
          {error && <p className="text-xs text-rose-700 flex items-center gap-1"><AlertTriangle size={13} />{error}</p>}
          <Button onClick={generate} variant="primary" size="sm" icon={Sparkles} loading={busy} disabled={busy || !prompt.trim()}>
            {busy ? 'Drafting…' : 'Generate draft'}
          </Button>
        </div>
      )}
    </div>
  )
}
