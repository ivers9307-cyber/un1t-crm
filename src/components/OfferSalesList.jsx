'use client'

// OfferSalesList — client half of /offer-sales (OFFERS.6). Renders the
// pending fulfilment queue + a short fulfilled tail; the Mark-fulfilled
// button POSTs the fulfil route and refreshes the server data.
import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

function euro(cents) {
  return '€' + ((cents || 0) / 100).toLocaleString('en-IE', { maximumFractionDigits: 0 })
}

function dublinTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin', weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short',
  })
}

export default function OfferSalesList({ pending, fulfilled }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const focus = searchParams.get('focus')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const markFulfilled = async (id) => {
    setBusy(id); setError(null); setNotice(null)
    try {
      const r = await fetch(`/api/offer-purchases/${id}/fulfil`, { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.success) throw new Error(j.error || 'Could not mark fulfilled')
      // The fulfil route emails the buyer; say so, and say when it didn't.
      setNotice(j.data?.emailed
        ? 'Marked fulfilled. Confirmation emailed to the buyer.'
        : 'Marked fulfilled. The confirmation email did NOT send — use Send confirmation below.')
      router.refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  // For purchases fulfilled before the confirmation email existed, and for
  // the "I never got it" case.
  const sendConfirmation = async (id) => {
    setBusy(id); setError(null); setNotice(null)
    try {
      const r = await fetch(`/api/offer-purchases/${id}/send-confirmation`, { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.success) throw new Error(j.error || 'Could not send confirmation')
      setNotice(`Confirmation sent to ${j.data?.to || 'the buyer'}.`)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-8">
      {error && <p className="text-sm text-red-700 bg-red-500/10 rounded px-3 py-2">{error}</p>}
      {notice && <p className="text-sm text-green-700 bg-green-500/10 rounded px-3 py-2">{notice}</p>}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-un1t-subtle mb-3">
          Awaiting Glofox setup ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-un1t-subtle">Nothing waiting. New sales land here the moment they pay.</p>
        ) : (
          <ul className="space-y-3">
            {pending.map((r) => (
              <li
                key={r.id}
                className={`rounded-lg border p-4 flex flex-wrap items-center gap-3 justify-between bg-un1t-bg ${focus === r.id ? 'border-un1t-text' : 'border-un1t-border'}`}
              >
                <div className="min-w-0">
                  <p className="font-medium text-un1t-text">{r.buyer_name || r.buyer_email}</p>
                  <p className="text-sm text-un1t-subtle">
                    {r.offer?.name} ({r.offer?.bonus_headline}) · {euro(r.amount_cents)} · paid {dublinTime(r.paid_at)}
                  </p>
                  <p className="text-sm text-un1t-subtle">{r.buyer_email}{r.buyer_phone ? ` · ${r.buyer_phone}` : ''}</p>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => sendConfirmation(r.id)}
                    disabled={busy === r.id}
                    className="px-3 py-2 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text text-sm disabled:opacity-50"
                  >
                    Send confirmation
                  </button>
                  <button
                    type="button"
                    onClick={() => markFulfilled(r.id)}
                    disabled={busy === r.id}
                    className="px-4 py-2 rounded-md bg-un1t-text text-un1t-bg text-sm font-medium disabled:opacity-50"
                  >
                    {busy === r.id ? 'Saving…' : 'Mark fulfilled'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {fulfilled.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-un1t-subtle mb-3">Recently fulfilled</h2>
          <ul className="space-y-2">
            {fulfilled.map((r) => (
              <li key={r.id} className="text-sm text-un1t-subtle flex flex-wrap items-center gap-2">
                <span className="inline-block px-2 py-0.5 rounded bg-green-500/10 text-green-700 text-xs">Done</span>
                <span className="text-un1t-text">{r.buyer_name || r.buyer_email}</span>
                <span>· {r.offer?.name} · {euro(r.amount_cents)}</span>
                {/* Available here too: anything fulfilled before the buyer
                    email existed never got one, and re-sends are a routine
                    "it went to spam" fix. */}
                <button
                  type="button"
                  onClick={() => sendConfirmation(r.id)}
                  disabled={busy === r.id}
                  className="ml-auto px-3 py-1 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text text-xs disabled:opacity-50"
                >
                  {busy === r.id ? 'Sending…' : 'Send confirmation'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
