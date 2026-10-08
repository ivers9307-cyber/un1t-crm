'use client'
// MoveEntryDialog — EVENT-MOVE.1. Move one entry (team or single) to another
// event. Shared by the staff teams page now and the host portal next (PR 2);
// only the two endpoints differ, so they are props with staff defaults.
//
// Never moves money: a price gap is shown, the move records it, staff collect
// or waive it afterwards. A full wave is a warning with two choices; any other
// refusal (a `conflict` 409 included) is the server's plain-English message in
// the form. A move that lands but could not be emailed is reported through
// onNotice (a warning, not a failure) before onMoved, so staff tell the customer.
//
// Spots left per time are shown: this is a staff surface (and the host's own
// portal in PR 2), never a customer one.

import { useEffect, useMemo, useState } from 'react'
import { Loader2, AlertTriangle, Coins, MapPin } from 'lucide-react'
import { Modal, Button } from '@/components/ui'
import { entryLabel } from '@/lib/registration-entry' // browser-safe half; never '@/lib/registration-move' in a client component

export const NOT_EMAILED_MESSAGE = 'Moved. The customer could not be emailed; tell them yourself.'

function money(cents, currency = 'EUR') {
  const major = (Math.abs(cents) / 100).toFixed(2)
  return currency === 'EUR' ? `€${major}` : currency === 'GBP' ? `£${major}` : `${major} ${currency}`
}
function fmtDate(d) {
  if (!d) return ''
  try { return new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' }) } catch { return d }
}
function waveLabel(w) {
  return `${w.label ? `${w.label} · ` : ''}${(w.start_time || '').slice(0, 5)}`
}

export default function MoveEntryDialog({
  open, registration, onClose, onMoved, onError, onNotice,
  targetsUrl = `/api/event-registrations/${registration?.id}/move-targets`,
  moveUrl = `/api/event-registrations/${registration?.id}/move`,
}) {
  const [data, setData] = useState(null)        // { entry, source, targets }
  const [loadError, setLoadError] = useState(null)
  const [targetEventId, setTargetEventId] = useState('')
  const [targetWaveId, setTargetWaveId] = useState('')
  const [notify, setNotify] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [fullWarning, setFullWarning] = useState(null) // { spots_left, message }
  const [formError, setFormError] = useState(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setData(null); setLoadError(null); setTargetEventId(''); setTargetWaveId(''); setFullWarning(null); setFormError(null)
    ;(async () => {
      try {
        const r = await fetch(targetsUrl, { cache: 'no-store' })
        const j = await r.json()
        if (cancelled) return
        if (!r.ok || j.success === false) { setLoadError(j.error || `Could not load events (${r.status})`); return }
        setData(j.data)
      } catch (e) {
        if (!cancelled) setLoadError(e.message || 'Network error')
      }
    })()
    return () => { cancelled = true }
  }, [open, targetsUrl])

  const label = data?.entry?.label || entryLabel(registration || {})
  const leadFirstName = (registration?.teams?.team_members || []).find((m) => m?.role === 'captain')?.name?.split(' ')[0]
    || registration?.contact?.first_name || 'the customer'
  const target = useMemo(() => (data?.targets || []).find((t) => t.id === targetEventId) || null, [data, targetEventId])
  const studios = useMemo(() => Array.from(new Set((data?.targets || []).map((t) => t.location_name))), [data])
  const gap = target?.price_gap_cents || 0
  const headcount = data?.entry?.headcount || 1
  // Name the team only when the entry is one (its label is the team's name).
  const teamName = registration?.teams?.name && label === registration.teams.name && headcount > 1 ? registration.teams.name : null
  const perPerson = headcount > 0 ? Math.round(gap / headcount) : gap

  async function submit(force) {
    if (!targetEventId) { setFormError('Pick a target event.'); return }
    if (target && target.waves.length > 0 && !targetWaveId) { setFormError('Pick a time on the target event.'); return }
    setBusy(true); setFormError(null)
    try {
      const r = await fetch(moveUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_event_id: targetEventId, target_wave_id: targetWaveId || null, notify, note: note.trim() || null, force }),
      })
      const j = await r.json()
      if (r.status === 409 && j.error === 'wave_full') { setFullWarning({ spots_left: j.spots_left, message: j.message }); return }
      if (!r.ok || j.success === false) { setFormError(j.message || j.error || 'The move could not be completed.'); return }
      // The move stands either way; say so when the email the operator asked for did not go.
      if (notify && j.data?.notified === false) onNotice?.(NOT_EMAILED_MESSAGE)
      onMoved?.(j.data)
    } catch (e) {
      onError?.(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  const waveField = target && target.waves.length > 0

  const footer = fullWarning ? (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div className="text-sm text-amber-700 inline-flex items-center gap-2">
        <AlertTriangle size={14} /> This time is full{Number.isFinite(fullWarning.spots_left) ? ` (${fullWarning.spots_left} left)` : ''}. Move anyway?
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={() => setFullWarning(null)} disabled={busy}>Don&apos;t move</Button>
        <Button type="button" variant="primary" onClick={() => submit(true)} loading={busy}>
          Move anyway
        </Button>
      </div>
    </div>
  ) : (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button type="button" variant="primary" onClick={() => submit(false)} loading={busy} disabled={!data || (data.targets || []).length === 0}>
        Move entry
      </Button>
    </div>
  )

  return (
    <Modal open={open} onClose={onClose} title={`Move ${label} to another event`} footer={footer} size="md">
      <p className="text-sm text-un1t-subtle mb-4">
        The entry, its people and its payment travel together. Nothing is charged or refunded by this move.
      </p>
      {loadError && <div className="text-sm text-red-700 mb-3">{loadError}</div>}
      {!data && !loadError && (
        <div className="text-sm text-un1t-subtle inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading events…</div>
      )}
      {data && data.targets.length === 0 && (
        <div className="text-sm text-un1t-subtle">No other upcoming events are paid to the same host.</div>
      )}
      {data && data.targets.length > 0 && (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(false) }}>
          <div>
            <label htmlFor="move-target-event" className="block text-sm text-un1t-subtle mb-1">Target event</label>
            <select
              id="move-target-event"
              value={targetEventId}
              onChange={(e) => { setTargetEventId(e.target.value); setTargetWaveId(''); setFullWarning(null) }}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            >
              <option value="">Choose an event…</option>
              {studios.length > 1
                ? studios.map((s) => (
                  <optgroup key={s} label={s}>
                    {data.targets.filter((t) => t.location_name === s).map((t) => (
                      <option key={t.id} value={t.id}>{fmtDate(t.race_date)} · {t.name}</option>
                    ))}
                  </optgroup>
                ))
                : data.targets.map((t) => (<option key={t.id} value={t.id}>{fmtDate(t.race_date)} · {t.name}</option>))}
            </select>
            <p className="text-[11px] text-un1t-muted mt-1">Only upcoming events paid to the same host are listed.</p>
          </div>

          {waveField && (
            <div>
              <label htmlFor="move-target-wave" className="block text-sm text-un1t-subtle mb-1">Time</label>
              <select
                id="move-target-wave"
                value={targetWaveId}
                onChange={(e) => { setTargetWaveId(e.target.value); setFullWarning(null) }}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              >
                <option value="">Choose a time…</option>
                {target.waves.map((w) => (
                  <option key={w.id} value={w.id}>
                    {waveLabel(w)}{w.spots_left === null ? '' : w.spots_left === 0 ? ' · full' : ` · ${w.spots_left} left`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {target?.crosses_studio && (
            <div className="text-sm text-un1t-text bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 inline-flex items-start gap-2">
              <MapPin size={14} className="mt-0.5 shrink-0" />
              <span>This moves the entry to {target.location_name}.{teamName ? ` ${teamName} is copied there.` : ''}</span>
            </div>
          )}

          {target && gap !== 0 && (
            <div className="text-sm text-amber-700 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2 flex items-start gap-2">
              <Coins size={14} className="mt-0.5 shrink-0" />
              <span>
                Target price is {money(perPerson, target.currency)} {gap > 0 ? 'more' : 'less'} per person ({money(gap, target.currency)} for this entry).
                {gap > 0 ? ' Collect it with a payment link afterwards, or leave it.' : ' Nothing is refunded by this move.'}
              </span>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-un1t-text">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            Email {leadFirstName} the new tickets and QR codes
          </label>

          <div>
            <label htmlFor="move-note" className="block text-sm text-un1t-subtle mb-1">Note (internal, optional)</label>
            <input
              id="move-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              placeholder="Customer asked to switch dates"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
          </div>

          {formError && <div className="text-sm text-red-700">{formError}</div>}
        </form>
      )}
    </Modal>
  )
}
