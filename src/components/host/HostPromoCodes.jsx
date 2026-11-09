'use client'

// HOST-PORTAL.9 — host self-serve promo codes for ONE event. Styled from the
// host-portal theme kit (host-ui.js; light and dark), like HostEventForm. Lists the event's codes with
// activate/deactivate + delete, and a create form below. Talks only to the
// host-scoped /api/host/events/[id]/promo-codes routes — event_id/location_id
// are server-set there, so this form never sends scoping fields. Fixed
// discounts are entered in EUROS and converted to integer cents on submit.

import { useCallback, useEffect, useState } from 'react'
import {
  HOST_BTN_PRIMARY,
  HOST_CHIP,
  HOST_CHIP_TONE,
  HOST_HINT,
  HOST_INPUT,
  HOST_LABEL,
  HOST_NOTICE,
  HOST_NOTICE_TONE,
  HOST_SECTION,
  HOST_SECTION_DESC,
} from '@/components/host/host-ui'

const input = HOST_INPUT
const labelCls = `${HOST_LABEL} mb-1.5`

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
      <h2 className={HOST_SECTION}>Promo codes</h2>
      <p className={`${HOST_SECTION_DESC} mb-4`}>
        Discount codes attendees can enter at checkout. They only work for this event.
      </p>

      {loading ? (
        <p className={HOST_HINT}>Loading codes…</p>
      ) : codes.length === 0 ? (
        <p className={HOST_HINT}>No promo codes yet.</p>
      ) : (
        <ul className="space-y-2">
          {codes.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-host-border bg-host-panel px-4 py-3"
            >
              <span className="font-mono text-sm font-semibold tracking-wide text-host-text">{row.code}</span>
              <span className="text-sm text-host-label">{discountLabel(row)}</span>
              <span className="text-xs text-host-hint">
                {row.redeemed_count ?? 0}/{row.max_redemptions ?? '∞'} used
              </span>
              {row.expires_at && expiryLabel(row.expires_at) && (
                <span className="text-xs text-host-hint">expires {expiryLabel(row.expires_at)}</span>
              )}
              <span
                className={`${HOST_CHIP} ${row.active ? HOST_CHIP_TONE.ok : HOST_CHIP_TONE.neutral}`}
              >
                {row.active ? 'Active' : 'Inactive'}
              </span>
              <span className="ml-auto flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => toggleActive(row)}
                  disabled={busyId === row.id}
                  className="text-xs text-host-hint hover:text-host-text transition disabled:opacity-50"
                >
                  {row.active ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  type="button"
                  onClick={() => remove(row)}
                  disabled={busyId === row.id}
                  className="text-xs text-host-bad hover:opacity-80 transition disabled:opacity-50"
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {listError && (
        <div className={`mt-3 ${HOST_NOTICE} ${HOST_NOTICE_TONE.bad}`}>
          {listError}
        </div>
      )}

      {/* Create */}
      <form onSubmit={handleCreate} className="mt-6 rounded-xl border border-host-border bg-host-panel p-4">
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
              <option value="percent" className="bg-host-panel text-host-text">% off</option>
              <option value="fixed" className="bg-host-panel text-host-text">€ off</option>
            </select>
          </div>
          <div>
            <label htmlFor="hpc-value" className={labelCls}>
              {discountType === 'percent' ? 'Percent' : 'Amount (EUR)'}
            </label>
            <div className="relative">
              {discountType === 'fixed' && (
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-host-hint">€</span>
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
            <p className="mt-1.5 text-xs text-host-hint">
              {discountType === 'percent' ? 'Up to 99%.' : 'Must be less than the ticket price.'}
            </p>
          </div>
          <div>
            <label htmlFor="hpc-max" className={labelCls}>
              Max uses <span className="font-normal text-host-hint">(optional)</span>
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
              Expires <span className="font-normal text-host-hint">(optional)</span>
            </label>
            <input
              id="hpc-expiry"
              type="date"
              value={expiresDate}
              onChange={(e) => setExpiresDate(e.target.value)}
              className={input}
            />
          </div>
        </div>

        {formError && (
          <div className={`mt-4 ${HOST_NOTICE} ${HOST_NOTICE_TONE.bad}`}>
            {formError}
          </div>
        )}

        <div className="mt-4">
          <button
            type="submit"
            disabled={creating}
            className={HOST_BTN_PRIMARY}
          >
            {creating ? 'Creating…' : 'Create code'}
          </button>
        </div>
      </form>
    </section>
  )
}
