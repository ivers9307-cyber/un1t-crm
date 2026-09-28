'use client'

// CHANNELREAD.1 — the per-location settings screens' version of the hub's
// UnreadableNote (HUBREAD.1, src/components/settings/IntegrationsHub.jsx).
//
// A screen whose read FAILED renders this and nothing that could act on the
// state it could not read: no form, no Connect / Update / Add / Save /
// Disconnect. Acting on an unread state is how a working connection gets
// replaced (the Instagram card POSTed a new connection over a live one).
// The only action is Try again:
//   onRetry  a client re-read (the component's own load); if the note is
//            still on screen when it settles, the read failed again, so say so.
//   href     server-rendered data (an RSC page): navigate back to it.
// Copy is staff-facing (not operator-editable), no em-dashes, and every
// asserted phrase is one string literal so tests can match it whole.

import { useState } from 'react'
import { buttonClasses } from '@/components/ui'

const retryClass = buttonClasses({ variant: 'secondary', size: 'sm' })

export default function ReadFailedNote({ what, onRetry, href }) {
  const [pending, setPending] = useState(false)
  const [tried, setTried] = useState(false)

  async function retry() {
    setPending(true)
    try {
      await onRetry?.()
    } finally {
      setPending(false)
      setTried(true)
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-amber-700 bg-amber-500/10 rounded px-2 py-1.5">
        {`Could not load ${what} just now, so nothing is shown and nothing can be changed here until it loads.`}
      </p>
      <span className="inline-flex flex-wrap items-center gap-2">
        {href ? (
          <a href={href} className={retryClass}>Try again</a>
        ) : (
          <button type="button" onClick={retry} disabled={pending} aria-busy={pending} className={retryClass}>
            {pending ? 'Trying…' : 'Try again'}
          </button>
        )}
        {!pending && tried && (
          <span role="status" className="text-xs text-amber-700">Still could not load. Try again in a minute.</span>
        )}
      </span>
    </div>
  )
}
