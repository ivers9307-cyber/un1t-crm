'use client'

// PAYLINK.1 — staff send a un1t.online payment link on WhatsApp from the Hatch
// card. Does its own GET (offers, latest link, what can be sent) so the card's
// data is untouched. A non-2xx GET (a studio where it does not apply, or no
// permission) renders nothing. The CRM never charges: the customer pays on
// un1t.online's hosted checkout.

import { useEffect, useMemo, useState } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui'

const STATUS_WORDS = Object.freeze({
  sent: 'not opened yet',
  opened: 'opened',
  checkout_started: 'at checkout',
  expired: 'expired',
  revoked: 'replaced',
})

function fmtTime(iso, zone) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) })
}

function statusLine(latest, zone) {
  if (!latest) return ''
  const word = latest.status === 'paid'
    ? `paid ${fmtTime(latest.paid_at, zone)}`.trim()
    : STATUS_WORDS[latest.status] || latest.status
  return `Link sent ${fmtTime(latest.created_at, zone)} · ${word}`
}

export default function Un1tPaymentLink({ contactId, locationId, studioName, zone }) {
  const [info, setInfo] = useState(null)
  const [offerId, setOfferId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [latest, setLatest] = useState(null)

  const url = `/api/contacts/${contactId}/un1t-payment-link`

  useEffect(() => {
    let live = true
    setInfo(null)
    ;(async () => {
      try {
        const res = await fetch(`${url}?locationId=${encodeURIComponent(locationId)}`)
        if (!res.ok) return
        const body = await res.json().catch(() => null)
        if (live && body?.success && body.data) {
          setInfo(body.data)
          setLatest(body.data.latest || null)
        }
      } catch { /* not available here: render nothing */ }
    })()
    return () => { live = false }
  }, [url, locationId])

  const offer = useMemo(() => info?.offers?.find((o) => o.offer_id === offerId) || null, [info, offerId])

  if (!info) return null
  const can = info.can || {}
  const reasons = []
  if (!can.has_email) reasons.push('There is no email address on this contact, so they cannot make an account.')
  if (!can.has_phone) reasons.push('There is no phone number on this contact.')
  if (can.has_email && can.has_phone && !can.window_open && !can.template_ready) {
    reasons.push('The WhatsApp window is closed and this studio has no approved payment-link template yet.')
  }
  if (!can.send && !latest && reasons.length === 0) return null

  const preview = offer
    ? String(info.preview_text || '').split('{product}').join(`${offer.title}, ${offer.price_label}`)
    : ''
  const showWarning = !!offer?.recurring && !!info.live_membership
  const first = info.first_name || 'They'
  const disabled = busy || !offer || !can.send

  async function send() {
    if (disabled) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId, offerId }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.success) {
        setLatest({ status: 'sent', product_title: offer.title, created_at: new Date().toISOString(), paid_at: null, expires_at: body.data?.expiresAt || null })
        setOfferId('')
      } else {
        setError(body.error || 'The link did not send')
      }
    } catch {
      setError('The link did not send')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-3 border border-un1t-border rounded-lg p-3 space-y-2 bg-un1t-bg" role="group" aria-label={`Send a payment link at ${studioName}`}>
      <p className="text-[11px] font-semibold text-un1t-subtle">Send a payment link</p>
      {latest && <p className="text-xs text-un1t-text" data-testid="paylink-latest">{statusLine(latest, zone)}</p>}
      <label className="block text-xs text-un1t-subtle">
        Product
        <select
          aria-label="Product"
          value={offerId}
          onChange={(e) => setOfferId(e.target.value)}
          disabled={busy || !can.send}
          className="mt-1 w-full text-xs bg-un1t-surface border border-un1t-border rounded-md px-2 py-1 text-un1t-text"
        >
          <option value="">Choose a product…</option>
          {(info.offers || []).map((o) => (
            <option key={o.offer_id} value={o.offer_id}>{`${o.title} — ${o.price_label}`}</option>
          ))}
        </select>
      </label>
      {preview && <p className="text-xs text-un1t-muted whitespace-pre-line" data-testid="paylink-preview">{preview}</p>}
      {showWarning && (
        <p className="text-xs rounded-md px-2 py-1 bg-amber-500/10 text-amber-700">
          {`${first} already has ${info.live_membership.plan || 'a membership'}, live. Sending a new membership could mean two payments.`}
        </p>
      )}
      {reasons.map((r) => <p key={r} className="text-[11px] text-un1t-muted">{r}</p>)}
      <Button type="button" size="sm" icon={Send} onClick={send} disabled={disabled} loading={busy}>Send on WhatsApp</Button>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  )
}
