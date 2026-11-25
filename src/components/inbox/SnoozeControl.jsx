'use client'

// INBOXFOLLOW.2 — "Snooze" in a thread header, shared by the WhatsApp and
// Instagram threads. A snoozed thread leaves Needs reply and waits until the
// chosen time (shared/inbox-queues.js). Closed: a Snooze button. Open: an
// optional note, four presets, and a date and time of your own. Snoozed: "Snoozed
// until … · Unsnooze".
//
// Every clock time is the STUDIO's (the `zone` prop, locations.timezone), never
// the browser's: presets come from shared/inbox-snooze, and the custom field's
// wall-clock value is turned into an instant with zonedWallClockToInstant.
// A refusal shows the route's reason under the control; nothing is assumed saved.

import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import { Button } from '@/components/ui'
import { isSnoozed } from '@/lib/inbox-queues'
import { formatInZone, resolveZone, zonedWallClockToInstant } from '@/lib/location-time'
import { snoozePresets, SNOOZE_NOTE_MAX } from '@shared/inbox-snooze'

const SAVE_FAILED = 'Could not change the snooze. Try again.'
const PICK_TIME = 'Pick a date and a time.'

const ENDPOINT = {
  wa: (id) => `/api/whatsapp/conversations/${id}/snooze`,
  ig: (id) => `/api/instagram/conversations/${id}/snooze`,
}

// "Fri 27 Nov, 09:00" in the studio's zone.
function untilLabel(iso, zone) {
  const ms = new Date(iso).getTime()
  return `${formatInZone(ms, zone, { weekday: 'short' })} ${formatInZone(ms, zone, { day: 'numeric', month: 'short' })}, ${formatInZone(ms, zone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
}

export default function SnoozeControl({ channel, conversation, zone, onChanged }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const studioZone = resolveZone(zone)
  const buildUrl = ENDPOINT[channel]
  const snoozed = isSnoozed(conversation)
  const rootRef = useRef(null)

  // Open: Escape closes it and puts focus back on the Snooze button; a press
  // outside the control closes it (focus stays where the person clicked).
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      rootRef.current?.querySelector('button[aria-expanded]')?.focus()
    }
    const onMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [open])

  async function send(until) {
    if (busy || !conversation?.id || !buildUrl) return
    setBusy(true)
    setError(null)
    try {
      // seen_last_message_at: the route refuses if a customer message landed
      // after the one on screen, so a snooze cannot bury it.
      const body = until === null
        ? { until: null }
        : { until, note, seen_last_message_at: conversation.last_message_at ?? null }
      const res = await fetch(buildUrl(conversation.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.success) {
        setOpen(false)
        setNote('')
        setCustom('')
        onChanged?.()
      } else {
        setError(data?.error || SAVE_FAILED)
      }
    } catch {
      setError(SAVE_FAILED)
    } finally {
      setBusy(false)
    }
  }

  function snoozeToCustom() {
    // <input type="datetime-local"> gives 'YYYY-MM-DDTHH:mm', no zone: read it
    // as the studio's wall clock.
    const [date, time] = custom.split('T')
    const ms = date && time ? zonedWallClockToInstant(date, time, studioZone) : null
    if (ms === null) { setError(PICK_TIME); return }
    send(new Date(ms).toISOString())
  }

  const presets = open ? snoozePresets(Date.now(), studioZone) : []

  return (
    <div ref={rootRef} className="relative flex flex-col items-end gap-1">
      {snoozed ? (
        <div className="flex items-center gap-1.5 text-xs text-un1t-subtle" data-testid="snoozed-state">
          <Clock size={12} aria-hidden="true" />
          <span>
            Snoozed until {untilLabel(conversation.snoozed_until, studioZone)}
            {conversation.snooze_note ? ` · ${conversation.snooze_note}` : ''}
          </span>
          <Button type="button" variant="ghost" size="sm" loading={busy} onClick={() => send(null)}>Unsnooze</Button>
        </div>
      ) : (
        <Button type="button" variant="secondary" size="sm" icon={Clock} aria-expanded={open} onClick={() => { setOpen(o => !o); setError(null) }}>
          Snooze
        </Button>
      )}

      {open && !snoozed && (
        <div role="group" aria-label="Snooze this conversation" className="absolute right-0 top-full z-20 mt-1 w-72 space-y-2 rounded-md border border-un1t-border bg-un1t-surface p-3 shadow-lg">
          <label className="block text-xs text-un1t-subtle">
            Note (optional)
            <input
              type="text"
              value={note}
              maxLength={SNOOZE_NOTE_MAX}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. waiting on the quote"
              className="mt-1 w-full rounded-md border border-un1t-border bg-un1t-bg px-2 py-1 text-sm text-un1t-text"
            />
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            {presets.map(p => (
              <Button key={p.key} type="button" variant="secondary" size="sm" disabled={busy} onClick={() => send(p.untilIso)}>
                {p.label}
              </Button>
            ))}
          </div>
          <label className="block text-xs text-un1t-subtle">
            Or pick a time (studio time)
            <input
              type="datetime-local"
              value={custom}
              onChange={e => setCustom(e.target.value)}
              className="mt-1 w-full rounded-md border border-un1t-border bg-un1t-bg px-2 py-1 text-sm text-un1t-text"
            />
          </label>
          <Button type="button" size="sm" loading={busy} onClick={snoozeToCustom}>Snooze until then</Button>
        </div>
      )}

      {error && <p role="alert" className="max-w-xs text-right text-xs text-red-600">{error}</p>}
    </div>
  )
}
