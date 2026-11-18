'use client'

// OfferStockPanel — the stock limit per live offer, on /offer-sales
// (OFFERSTOCK.1). Owners, managers and masters only: the server page decides
// whether to render it and the route checks again. An empty box means no limit.
import { useState } from 'react'
import { useRouter } from 'next/navigation'

function usageLine(o) {
  if (o.sold == null) return 'Sales could not be counted just now.'
  const parts = [`${o.sold} sold`]
  if (o.held > 0) parts.push(`${o.held} in checkout`)
  if (o.limit != null) parts.push(`${Math.max(0, o.limit - o.sold - o.held)} left`)
  return parts.join(' · ')
}

function OfferStockRow({ offer }) {
  const router = useRouter()
  const [value, setValue] = useState(offer.limit == null ? '' : String(offer.limit))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const inputId = `offer-stock-${offer.id}`
  const current = offer.limit == null ? '' : String(offer.limit)

  const save = async () => {
    const text = value.trim()
    const limit = text === '' ? null : Number(text)
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
      setError('Enter a whole number of 1 or more, or leave it empty for no limit.')
      return
    }
    setBusy(true); setError(null); setSaved(false)
    try {
      const r = await fetch(`/api/offer-stock/${offer.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stock_limit: limit }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.success) throw new Error(j.error || 'Could not save the limit')
      setSaved(true)
      router.refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded-lg border border-un1t-border bg-un1t-bg p-4 flex flex-wrap items-end gap-3 justify-between">
      <div className="min-w-0">
        <p className="font-medium text-un1t-text">{offer.name}</p>
        <p className="text-sm text-un1t-subtle">{usageLine(offer)}</p>
        {error && <p className="text-sm text-red-700 mt-1" role="alert">{error}</p>}
        {saved && !error && <p className="text-sm text-green-700 mt-1" role="status">Saved.</p>}
      </div>
      <div className="shrink-0 flex items-end gap-2">
        <div>
          <label htmlFor={inputId} className="block text-xs text-un1t-subtle mb-1">Limit</label>
          <input
            id={inputId}
            type="number"
            inputMode="numeric"
            min="1"
            step="1"
            placeholder="No limit"
            value={value}
            onChange={(e) => { setValue(e.target.value); setSaved(false) }}
            className="w-28 rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
          />
        </div>
        <button
          type="button"
          onClick={save}
          disabled={busy || value.trim() === current}
          className="px-4 py-2 rounded-md bg-un1t-text text-un1t-bg text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </li>
  )
}

export default function OfferStockPanel({ offers }) {
  if (!offers?.length) return null
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-un1t-subtle mb-1">Stock limits</h2>
      <p className="text-sm text-un1t-subtle mb-3">
        How many of each offer can be sold. Every paid sale counts, including ones made in the app or at the desk. The page shows the number once 5 or fewer are left.
      </p>
      <ul className="space-y-3">
        {offers.map((o) => <OfferStockRow key={o.id} offer={o} />)}
      </ul>
    </section>
  )
}
