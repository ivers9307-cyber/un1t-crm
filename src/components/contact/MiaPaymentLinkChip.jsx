'use client'

// MIAHATCH.6 — the "Payment link sent" chip on the contact header.
//
// Shows while Mia's payment link for this contact is live: an intent with
// status 'link_sent' whose expires_at is still in the future. It reads
// GET /api/contacts/[id]/mia-purchase-intents once, after the page has
// rendered (the header band is a server component and gains no query of its
// own), and renders nothing on any failure: a chip that cannot be confirmed is
// no chip. The route returns neither the link nor any token.

import { useEffect, useState } from 'react'

/** The live link_sent intent (newest first), or null. Pure: `nowMs` is injected. */
export function livePaymentLink(intents, nowMs = Date.now()) {
  if (!Array.isArray(intents)) return null
  return intents.find((i) => {
    if (i?.status !== 'link_sent') return false
    const exp = Date.parse(i.expires_at)
    return Number.isFinite(exp) && exp > nowMs
  }) || null
}

export default function MiaPaymentLinkChip({ contactId }) {
  const [intent, setIntent] = useState(null)

  useEffect(() => {
    if (!contactId) return undefined
    const ctl = new AbortController()
    ;(async () => {
      try {
        const res = await fetch(`/api/contacts/${contactId}/mia-purchase-intents`, { signal: ctl.signal })
        if (!res.ok) return
        const body = await res.json()
        if (body?.success !== true) return
        setIntent(livePaymentLink(body.data))
      } catch {
        // Offline, aborted or malformed: render nothing.
      }
    })()
    return () => ctl.abort()
  }, [contactId])

  if (!intent) return null
  const expires = new Date(intent.expires_at).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const what = intent.product_title ? `${intent.product_title}. ` : ''
  return (
    <span
      title={`${what}Mia sent a payment link. Waiting for payment, link expires ${expires}.`}
      className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-700"
    >
      Payment link sent
    </span>
  )
}
