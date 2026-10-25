'use client'

// WAORGNUMBER.1 (Task 6, R8) — one studio's view of the ORGANISATION's WhatsApp
// numbers: each has a switch ("on at this studio") and, once on, a default
// radio. Numbers are added, edited and removed in the hub's WhatsApp numbers
// drawer (the organisation level); this only decides which of them THIS studio
// uses. Shared by the studio's WhatsApp tab and the Integrations Hub drawer.
//
//   GET/PUT /api/locations/[id]/whatsapp/numbers  (owner / manager / master at the studio)
//
// `numbers` is null until a read SUCCEEDS and goes back to null on a failed
// read (CHANNELREAD.1): no switches over a list we could not read.

import { useEffect, useState } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { NO_ACTIVE_NUMBER_NOTE } from '@/lib/whatsapp-number-copy'
import ReadFailedNote from '@/components/settings/ReadFailedNote'

export default function StudioWhatsAppNumbers({ locationId, canSwitch = false, canManageNumbers = false, onChanged }) {
  const [numbers, setNumbers] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  async function load({ silent = false } = {}) {
    if (!silent) setLoading(true)
    try {
      const res = await fetch(`/api/locations/${locationId}/whatsapp/numbers`)
      const j = await res.json()
      if (!res.ok || !j.success || !Array.isArray(j.data?.numbers)) throw new Error(j.error || 'Failed to load numbers')
      setNumbers(j.data.numbers)
    } catch {
      setNumbers(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [locationId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function change(number, body, confirmText) {
    if (confirmText && typeof window !== 'undefined' && !window.confirm(confirmText)) return
    setBusyId(number.id); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/whatsapp/numbers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numberId: number.id, ...body }),
      })
      const j = await res.json()
      if (!res.ok || !j.success || !Array.isArray(j.data?.numbers)) throw new Error(j.error || 'Could not save that change')
      setNumbers(j.data.numbers)
      onChanged?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusyId(null)
    }
  }

  function toggle(number, on) {
    const lastOn = !on && numbers.filter((n) => n.on).length === 1
    change(
      number,
      { on },
      lastOn ? `Switch off "${number.label}"? It is the only number on at this studio, so this studio will stop sending and receiving WhatsApp until a number is switched on again.` : null,
    )
  }

  if (loading) {
    return (
      <div className="text-xs text-un1t-subtle inline-flex items-center gap-2">
        <Loader2 size={12} className="animate-spin" /> Loading…
      </div>
    )
  }
  if (numbers === null) {
    return <ReadFailedNote what="this location's WhatsApp numbers" onRetry={() => load({ silent: true })} />
  }

  const anyOn = numbers.some((n) => n.on && n.is_active)

  return (
    <div className="space-y-2">
      {numbers.length === 0 && (
        <div className="text-xs text-un1t-subtle bg-un1t-bg border border-un1t-border rounded p-3">
          No numbers configured. {NO_ACTIVE_NUMBER_NOTE}{' '}
          {canManageNumbers
            ? 'Add a number on the WhatsApp numbers page to connect one. '
            : 'Ask an organisation admin to add one. '}
          Chat openers can only be saved once this location has its own number.
        </div>
      )}
      {numbers.length > 0 && !anyOn && (
        <div className="text-xs text-un1t-subtle bg-un1t-bg border border-un1t-border rounded p-3">
          No number is switched on here. {NO_ACTIVE_NUMBER_NOTE}{' '}
          {canSwitch ? 'Switch one on below. ' : 'An owner or manager can switch one on. '}
          Chat openers can only be saved once this location has its own number.
        </div>
      )}
      {numbers.map((n) => {
        const busy = busyId === n.id
        return (
          <div key={n.id} className="bg-un1t-bg border border-un1t-border rounded-md p-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-un1t-text truncate">{n.label}</span>
                {!n.is_active && <span className="text-[10px] uppercase text-un1t-muted">Inactive</span>}
              </div>
              <div className="text-[11px] text-un1t-subtle truncate">{n.display_phone || n.id}</div>
            </div>
            <label className="inline-flex items-center gap-1.5 text-[11px] text-un1t-subtle whitespace-nowrap">
              <input
                type="checkbox"
                aria-label={`Switch on ${n.label} at this studio`}
                checked={n.on}
                disabled={!canSwitch || busy}
                onChange={(e) => toggle(n, e.target.checked)}
              />
              On here
            </label>
            <label className="inline-flex items-center gap-1.5 text-[11px] text-un1t-subtle whitespace-nowrap">
              <input
                type="radio"
                name={`wa-default-${locationId}`}
                aria-label={`Make ${n.label} the default at this studio`}
                checked={n.is_default}
                disabled={!canSwitch || busy || !n.on}
                onChange={() => change(n, { on: true, isDefault: true })}
              />
              Default
            </label>
            {busy && <Loader2 size={12} className="animate-spin text-un1t-subtle" />}
          </div>
        )
      })}
      {error && (
        <div className="text-xs text-red-700 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      {numbers.length > 0 && (
        <p className="text-[11px] text-un1t-subtle">
          The default is the number outbound sends from broadcasts, sequences and the inbox use at this studio.
        </p>
      )}
    </div>
  )
}
