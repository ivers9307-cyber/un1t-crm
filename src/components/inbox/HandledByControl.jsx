'use client'

// INBOX-REDESIGN.2.4 — unified "Handled by Mia ⇄ You" control, shared by
// the WhatsApp and Instagram thread headers. The two channels pause/resume
// the agent through different columns: WA uses the sticky agent_paused_at
// timestamp (mig 435 — WA's agent_active already auto-flips on every staff
// reply and auto-rearms after handoff_cooldown_hours, so it can't express
// an explicit "stay off until I resume"); IG flips agent_active directly.
// Both PATCH endpoints share the same { active: boolean } body and
// { success: true, ... } response shape — see
// src/app/api/{whatsapp,instagram}/conversations/[id]/agent/route.js.
//
// Presentational + self-contained: no store, just a local `busy` guard
// against double-clicks and an onChanged() ping so the parent thread
// re-fetches the fresh row. WA/IG are the only channels — email has no
// customer agent, and since INBOX-SPLIT.1 it is not an inbox channel at
// all (its surface is /communications/mail).

import { useState } from 'react'
import { Sparkles, UserCheck } from 'lucide-react'

const AGENT_ENDPOINT = {
  wa: (id) => `/api/whatsapp/conversations/${id}/agent`,
  ig: (id) => `/api/instagram/conversations/${id}/agent`,
}

function isHandledByMia(channel, conversation) {
  if (channel === 'ig') return conversation?.agent_active !== false
  return !conversation?.agent_paused_at // wa (default)
}

export default function HandledByControl({ channel, conversation, onChanged }) {
  const [busy, setBusy] = useState(false)
  const handledByMia = isHandledByMia(channel, conversation)
  const buildUrl = AGENT_ENDPOINT[channel]

  async function flip(active) {
    if (busy || !conversation?.id || !buildUrl) return
    if (active === handledByMia) return // already on that side — no-op

    setBusy(true)
    try {
      const res = await fetch(buildUrl(conversation.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success) onChanged?.()
    } catch {
      /* transient — buttons re-enable so staff can retry */
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-un1t-muted">
        Handled by
      </span>
      <div className="inline-flex items-center gap-0.5 rounded-md border border-un1t-border p-0.5">
        <button
          type="button"
          onClick={() => flip(true)}
          disabled={busy}
          className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
            handledByMia ? 'bg-mia/10 text-mia' : 'text-un1t-subtle hover:text-un1t-text'
          }`}
        >
          <Sparkles size={12} />
          Mia
        </button>
        <button
          type="button"
          onClick={() => flip(false)}
          disabled={busy}
          className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
            !handledByMia ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'
          }`}
        >
          <UserCheck size={12} />
          You
        </button>
      </div>
    </div>
  )
}
