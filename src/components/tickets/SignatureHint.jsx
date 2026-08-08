'use client'

// The auto-appended sign-off preview, shared by the reply box and the
// composer (EMAIL-TICKET.5 follow-up, 2026-08-08 audit). Both send paths run
// appendSignature() server-side; a composer that hides what the server will
// add has operators typing their name twice — or worse, trusting a preview
// that disagrees with what the member receives.
//
// The signature belongs to the VIEWER, not the ticket, so when the parent has
// nothing to pass it is fetched here rather than threaded through props that
// have nothing else to do with it. A failed lookup just hides the preview —
// the route appends the signature server-side either way, so this is cosmetic.

import { useEffect, useState } from 'react'
import { PenLine } from 'lucide-react'
import { SIGNATURE_SEPARATOR, normalizeSignature } from '@/lib/email-signature'

export default function SignatureHint({ signature }) {
  // Only fetched when the parent didn't supply one.
  const [fetchedSignature, setFetchedSignature] = useState('')

  useEffect(() => {
    if (signature !== undefined) return
    let cancelled = false
    fetch('/api/me/preferences')
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j?.success) setFetchedSignature(j.data?.email_signature || '')
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [signature])

  const resolvedSignature = normalizeSignature(signature !== undefined ? signature : fetchedSignature)
  if (!resolvedSignature) return null

  return (
    /* Deliberately NOT an input: it sits outside the textarea, carries its
       own label, and links to where it is actually changed. */
    <div className="mt-2 rounded-lg border border-dashed border-un1t-border bg-un1t-surface/60 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-un1t-muted">
          <PenLine size={11} aria-hidden="true" />
          Added automatically
        </span>
        {/* A new tab, not a <Link> soft-nav: navigating away would discard
            whatever draft is half-written in the composer around this hint. */}
        <a
          href="/account"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-un1t-subtle underline decoration-dotted underline-offset-2 hover:text-un1t-text"
        >
          Edit signature
        </a>
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs text-un1t-subtle">
        {`${SIGNATURE_SEPARATOR}\n${resolvedSignature}`}
      </pre>
    </div>
  )
}
