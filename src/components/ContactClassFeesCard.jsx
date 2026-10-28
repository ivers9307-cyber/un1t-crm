'use client'

// FEES.1 — the member profile's class-fee card at one un1t.online studio.
// Shows what the member owes after two refused charges (outstanding) or with
// a retry scheduled, each fee with its class, day and time and un1t.online's
// last refusal reason, plus fees still waiting for tonight's charge.
// "Retry charge" runs one attempt per owed fee on the default card; "Waive"
// clears one. Renders nothing when the member owes nothing here.

import { useCallback, useEffect, useState } from 'react'
import { Button, Card } from '@/components/ui'
import { WaiveModal } from '@/components/ClassFeesReview'

const euro = (c) => `€${(Number(c || 0) / 100).toFixed(2)}`
const OWED = new Set(['retry_scheduled', 'outstanding'])

export default function ContactClassFeesCard({ contactId, locationId, studioName }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [waiving, setWaiving] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/class-fees/contact?location_id=${encodeURIComponent(locationId)}&contact_id=${encodeURIComponent(contactId)}`)
      const json = await res.json()
      if (res.ok && json.success) setData(json.data)
    } catch { /* the card stays hidden */ }
  }, [contactId, locationId])

  useEffect(() => { load() }, [load])

  async function retry() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/class-fees/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, contact_id: contactId }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      const outcomes = json.data.outcomes || []
      const charged = outcomes.filter((o) => o.status === 'charged').length
      const refused = outcomes.length - charged
      setMsg(outcomes.length === 0
        ? 'Nothing to retry right now.'
        : `${charged} charged${refused ? `, ${refused} still not paid` : ''}.`)
      await load()
    } catch (e) {
      setMsg(e.message || 'Could not retry')
    } finally {
      setBusy(false)
    }
  }

  async function toggleExempt(on) {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/class-fees/exemptions', {
        method: on ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, contact_id: contactId }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setMsg(e.message || 'Could not update')
    } finally {
      setBusy(false)
    }
  }

  if (!data) return null
  const fees = data.fees || []
  const owed = fees.filter((f) => OWED.has(f.status))

  // FEES.4 — with nothing owed, the card is just the never-charge switch.
  if (!fees.length) {
    return (
      <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-un1t-border bg-un1t-surface px-3 py-2 text-sm">
        <span className="text-un1t-subtle">{data.exempt ? 'Never charged class fees here' : 'Class fees apply here'}</span>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => toggleExempt(!data.exempt)}>
          {data.exempt ? 'Remove exemption' : 'Never charge'}
        </Button>
        {msg && <span className="text-xs text-red-700">{msg}</span>}
      </div>
    )
  }

  return (
    <Card
      title={<span>Class fees{studioName ? ` · ${studioName}` : ''}</span>}
      actions={owed.length > 0 && <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-red-500/10 text-red-700">Outstanding {euro(data.owed_cents)}</span>}
      className="mt-4"
    >
      <ul className="space-y-3 text-sm">
        {fees.map((f) => (
          <li key={f.id} className="flex items-start justify-between gap-3">
            <div>
              <div className="text-un1t-text">{f.charge_description}</div>
              <div className="text-xs text-un1t-subtle">
                {euro(f.amount_cents)} · {f.status === 'outstanding' ? 'Outstanding' : f.status === 'retry_scheduled' ? 'Retry scheduled' : f.status === 'charging' ? 'Charging' : f.status === 'appealed' ? 'Appealed, on hold' : 'Charged at the next charge time unless waived'}
              </div>
              {f.failure_message && <div className="text-xs text-red-700">{f.failure_message}</div>}
            </div>
            {f.status !== 'charging' && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setWaiving(f)}>Waive</Button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => toggleExempt(true)}>Never charge this member</Button>
      </div>
      {owed.length > 0 && (
        <div className="mt-4 flex items-center gap-3">
          <Button type="button" size="sm" disabled={busy} onClick={retry}>{busy ? 'Charging…' : 'Retry charge'}</Button>
          {msg && <span className="text-xs text-un1t-subtle">{msg}</span>}
        </div>
      )}
      {waiving && (
        <WaiveModal fee={waiving} locationId={locationId} onClose={() => setWaiving(null)} onDone={() => { setWaiving(null); load() }} />
      )}
    </Card>
  )
}
