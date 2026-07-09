'use client'

// HOST-PORTAL.9 — host self-serve promo codes for ONE event. Dark UN1T host-
// portal styling (matches HostEventForm). Lists the event's codes with
// activate/deactivate + delete, and a create form below. Talks only to the
// host-scoped /api/host/events/[id]/promo-codes routes — event_id/location_id
// are server-set there, so this form never sends scoping fields. Fixed
// discounts are entered in EUROS and converted to integer cents on submit.

import { useCallback, useEffect, useState } from 'react'

const input =
  'w-full bg-white/[0.04] border border-white/12 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-white/30'
const labelCls = 'block text-xs uppercase tracking-wide text-white/45 mb-1.5'

function discountLabel(code) {
  if (code.discount_type === 'percent') return `${code.discount_value}% off`
  return `€${(Number(code.discount_value) / 100).toFixed(2)} off`
}

function expiryLabel(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function HostPromoCodes({ eventId }) {
  const [codes, setCodes] = useState([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  // Create form state.
  const [code, setCode] = useState('')
  const [discountType, setDiscountType] = useState('percent')
  const [value, setValue] = useState('')
  const [maxRedemptions, setMaxRedemptions] = useState('')
  const [expiresDate, setExpiresDate] = useState('')
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState(null)

  const base = `/api/host/events/${eventId}/promo-codes`

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setListError(json.error || 'Could not load promo codes.')
        return
      }
      setListError(null)
      setCodes(Array.isArray(json.data) ? json.data : [])
    } catch {
      setListError('Network error — could not load promo codes.')
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => { refetch() }, [refetch])

  async function toggleActive(row) {
    if (busyId) return
    setBusyId(row.id)
    setListError(null)
    try {
      const res = await fetch(`${base}/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !row.active }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) setListError(json.error || 'Could not update the code.')
    } catch {
      setListError('Network error. Please try again.')
    } finally {
      setBusyId(null)
      refetch()
    }
  }

  async function remove(row) {
    if (busyId) return
    if (!window.confirm(`Delete code ${row.code}? Anyone who already used it keeps their discount.`)) return
    setBusyId(row.id)
    setListError(null)
    try {
      const res = await fetch(`${base}/${row.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) setListError(json.error || 'Could not delete the code.')
    } catch {
      setListError('Network error. Please try again.')
    } finally {
      setBusyId(null)
      refetch()
    }
  }

  async function handleCreate(e) {
    e.preventDefault()
    if (creating) return
    setFormError(null)

    const trimmed = code.trim()
    if (!trimmed) { setFormError('Enter a code, e.g. EARLYBIRD.'); return }

    let discountValue
    if (discountType === 'percent') {
      // Host codes cap at 99% — the ticket can never be fully free (the €2
      // booking fee is only collected when checkout goes through Stripe).
      discountValue = parseInt(value, 10)
      if (!Number.isFinite(discountValue) || discountValue < 0 || discountValue > 99) {
        setFormError("Percent must be a whole number between 0 and 99 — the ticket can't be fully free.")
        return
      }
    } else {
      const euros = parseFloat(value)
      if (!Number.isFinite(euros) || euros < 0) {
        setFormError('Amount must be 0 or more (in euros).')
        return
      }
      discountValue = Math.round(euros * 100)
    }

    const body = { code: trimmed, discount_type: discountType, discount_value: discountValue }
    if (maxRedemptions.trim() !== '') {
      const max = parseInt(maxRedemptions, 10)
      if (!Number.isFinite(max) || max < 1) {
        setFormError('Max uses must be a whole number of at least 1.')
        return
      }
      body.max_redemptions = max
    }
    if (expiresDate) body.expires_at = `${expiresDate}T23:59:59.000Z`

    setCreating(true)
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setFormError(json.error || 'Could not create the code. Please try again.')
        return
      }
      setCode('')
      setValue('')
      setMaxRedemptions('')
      setExpiresDate('')
      refetch()
    } catch {
      setFormError('Network error. Please try again.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="mt-10">
      <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-1">Promo codes</h2>
      <p className="text-xs text-white/35 mb-4">
        Discount codes attendees can enter at checkout. They only work for this event.
      </p>

      {loading ? (
        <p className="text-white/50 text-sm">Loading codes…</p>
      ) : codes.length === 0 ? (
        <p className="text-white/50 text-sm">No promo codes yet.</p>
      ) : (
        <ul className="space-y-2">
          {codes.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3"
            >
              <span className="font-mono text-sm font-semibold tracking-wide">{row.code}</span>
              <span className="text-sm text-white/70">{discountLabel(row)}</span>
              <span className="text-xs text-white/45">
                {row.redeemed_count ?? 0}/{row.max_redemptions ?? '∞'} used
              </span>
              {row.expires_at && expiryLabel(row.expires_at) && (
                <span className="text-xs text-white/45">expires {expiryLabel(row.expires_at)}</span>
              )}
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  row.active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/10 text-white/50'
                }`}
              >
                {row.active ? 'Active' : 'Inactive'}
              </span>
              <span className="ml-auto flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => toggleActive(row)}
                  disabled={busyId === row.id}
                  className="text-xs text-white/60 hover:text-white transition disabled:opacity-50"
                >
                  {row.active ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  type="button"
                  onClick={() => remove(row)}
                  disabled={busyId === row.id}
                  className="text-xs text-red-400/80 hover:text-red-300 transition disabled:opacity-50"
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {listError && (
        <div className="mt-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {listError}
        </div>
      )}

      {/* Create */}
      <form onSubmit={handleCreate} className="mt-6 rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div>
            <label htmlFor="hpc-code" className={labelCls}>Code</label>
            <input
              id="hpc-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="EARLYBIRD"
              maxLength={64}
              className={`${input} font-mono uppercase`}
              required
            />
          </div>
          <div>
            <label htmlFor="hpc-type" className={labelCls}>Type</label>
            <select
              id="hpc-type"
              value={discountType}
              onChange={(e) => setDiscountType(e.target.value)}
              className={`${input} appearance-none`}
            >
              <option value="percent" className="bg-black text-white">% off</option>
              <option value="fixed" className="bg-black text-white">€ off</option>
            </select>
          </div>
          <div>
            <label htmlFor="hpc-value" className={labelCls}>
              {discountType === 'percent' ? 'Percent' : 'Amount (EUR)'}
            </label>
            <div className="relative">
              {discountType === 'fixed' && (
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-white/40">€</span>
              )}
              <input
                id="hpc-value"
                type="number"
                min={0}
                max={discountType === 'percent' ? 99 : undefined}
                step={discountType === 'percent' ? 1 : '0.01'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={discountType === 'percent' ? 'e.g. 20' : '5.00'}
                className={discountType === 'fixed' ? `${input} pl-7` : input}
                required
              />
            </div>
            <p className="mt-1.5 text-xs text-white/35">
              {discountType === 'percent' ? 'Up to 99%.' : 'Must be less than the ticket price.'}
            </p>
          </div>
          <div>
            <label htmlFor="hpc-max" className={labelCls}>
              Max uses <span className="text-white/30 normal-case">(optional)</span>
            </label>
            <input
              id="hpc-max"
              type="number"
              min={1}
              step={1}
              value={maxRedemptions}
              onChange={(e) => setMaxRedemptions(e.target.value)}
              placeholder="Unlimited"
              className={input}
            />
          </div>
          <div>
            <label htmlFor="hpc-expiry" className={labelCls}>
              Expires <span className="text-white/30 normal-case">(optional)</span>
            </label>
            <input
              id="hpc-expiry"
              type="date"
              value={expiresDate}
              onChange={(e) => setExpiresDate(e.target.value)}
              className={`${input} [color-scheme:dark]`}
            />
          </div>
        </div>

        {formError && (
          <div className="mt-4 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {formError}
          </div>
        )}

        <div className="mt-4">
          <button
            type="submit"
            disabled={creating}
            className="rounded-lg bg-white text-black text-sm font-semibold px-5 py-2.5 hover:bg-white/90 disabled:opacity-60"
          >
            {creating ? 'Creating…' : 'Create code'}
          </button>
        </div>
      </form>
    </section>
  )
}
