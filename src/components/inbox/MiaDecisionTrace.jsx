'use client'

// FEAT-AGENT-TRACE.2 — the staff-facing surface for agent_decisions (mig 436).
// A compact, on-demand "why did Mia reply or stay silent" trace that sits in
// the WA/IG thread header next to HandledByControl. Deliberately NOT a debug
// dump: each decision is rendered as a plain-language line a coach can read at
// a glance ("Mia stayed silent — a staff member had already replied"), with
// the raw reason token mapped through REASON_LABELS.
//
// Lazy + self-contained: nothing is fetched until the panel is opened, so
// switching threads costs zero extra requests. Backs onto
// GET /api/agent/decisions?conversation_id= (whatsapp-permission gated,
// location-scoped, newest-first, capped at 10).

import { useEffect, useRef, useState } from 'react'
import { ScrollText, Sparkles, MessageSquare, CircleSlash } from 'lucide-react'
import { formatRelative } from '@/lib/dates'

// Raw reason tokens (from src/lib/agent/auto-reply.js) → staff-readable text.
// Anything not listed falls back to humanise() so the model's own free-text
// handoff reasons still render sensibly.
const REASON_LABELS = {
  human_took_over: 'A staff member had already replied',
  verify_failed: "Couldn't verify the member's identity",
  rate_limited: 'Hourly reply cap reached',
  location_daily_cap: 'Daily reply cap reached',
  ai_cap: 'AI usage cap reached',
  wallet_empty: 'Messaging credit exhausted',
  in_flight: 'Already handling a newer message',
  no_history: 'No conversation history yet',
  no_api_key: 'AI replies are not configured',
  missing_context: 'Missing conversation context',
  model_error: 'The AI model failed to respond',
  model_exception: 'The AI model errored',
  send_failed: 'The reply failed to send',
  soft_handoff_debounced: 'Handoff note already sent',
  no_history_yet: 'No conversation history yet',
}

function humanise(token) {
  if (!token) return ''
  const label = REASON_LABELS[token]
  if (label) return label
  const spaced = String(token).replace(/[_:]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export default function MiaDecisionTrace({ conversationId }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [decisions, setDecisions] = useState(null)
  const wrapRef = useRef(null)

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function toggle() {
    const next = !open
    setOpen(next)
    if (!next || !conversationId) return
    // Always refetch on open so the trace is live (cheap — capped at 10 rows).
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/agent/decisions?conversation_id=${encodeURIComponent(conversationId)}`)
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success) setDecisions(data.decisions || [])
      else setError(data.error || 'Could not load Mia’s decisions')
    } catch {
      setError('Could not load Mia’s decisions')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={toggle}
        aria-label="Why Mia replied or stayed silent"
        aria-expanded={open}
        title="Mia’s recent decisions"
        className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
          open
            ? 'border-mia/40 bg-mia/10 text-mia'
            : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
        }`}
      >
        <ScrollText size={12} />
        Why?
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-80 rounded-lg border border-un1t-border bg-un1t-bg shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-un1t-border px-3 py-2">
            <Sparkles size={12} className="text-mia" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-un1t-muted">
              Mia’s recent decisions
            </span>
          </div>

          <div className="max-h-72 overflow-y-auto">
            {loading && (
              <p className="px-3 py-4 text-xs text-un1t-subtle">Loading…</p>
            )}
            {!loading && error && (
              <p className="px-3 py-4 text-xs text-red-700">{error}</p>
            )}
            {!loading && !error && decisions && decisions.length === 0 && (
              <p className="px-3 py-4 text-xs text-un1t-subtle">
                No agent activity recorded on this conversation yet.
              </p>
            )}
            {!loading && !error && decisions && decisions.length > 0 && (
              <ul className="divide-y divide-un1t-border/60">
                {decisions.map((d) => {
                  const replied = d.decision === 'reply'
                  return (
                    <li key={d.id} className="flex items-start gap-2.5 px-3 py-2.5">
                      <span className={`mt-0.5 shrink-0 ${replied ? 'text-green-700' : 'text-un1t-subtle'}`}>
                        {replied ? <MessageSquare size={14} /> : <CircleSlash size={14} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-un1t-text">
                          {replied ? 'Mia replied' : 'Mia stayed silent'}
                        </p>
                        {!replied && d.reason && (
                          <p className="mt-0.5 text-xs text-un1t-subtle">{humanise(d.reason)}</p>
                        )}
                      </div>
                      <span className="shrink-0 text-[10px] text-un1t-muted" title={new Date(d.created_at).toLocaleString('en-IE')}>
                        {formatRelative(d.created_at)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
