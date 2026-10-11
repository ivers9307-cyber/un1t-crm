'use client'

// TZ.3 — change an existing location's timezone (D2 = A, Richard 11 Oct 2026).
//
// An owner or master may change it at any time. The dialog loads the preflight
// (GET /api/locations/[id]/timezone: counts of what has future wall-clock
// meaning here, judged in the CURRENT zone), shows them, and needs the
// location's name typed before PUT. Nothing is refused for having future data.
// A count the server could not read arrives as null and shows "unknown", never 0.
//
// Mount it only while open (the parent renders it conditionally) so every
// opening starts from a fresh preflight. It must render OUTSIDE LocationForm's
// <form>: it has its own form, and nested forms are invalid HTML.

import { useEffect, useId, useState } from 'react'
import { Modal, Button } from '@/components/ui'
import TimezoneSelect from '@/components/settings/TimezoneSelect'
import { canonicalZone } from '@shared/zoned-time'

// Display order and wording of the preflight counts (keys from src/lib/timezone-change.js).
const COUNT_LABELS = [
  ['bookings', 'Future bookings'],
  ['shift_blocks', 'Future shift blocks'],
  ['race_events', 'Upcoming events and races'],
  ['hyrox_blocks', 'Running Hyrox blocks'],
  ['pending_enrolments', 'Pending sequence steps'],
  ['sonos_schedules', 'Sonos schedules'],
  ['shelly_devices', 'Scheduled Shelly devices'],
  ['drip_broadcasts', 'Scheduled WhatsApp drip broadcasts'],
]

const display = (z) => String(z || '').replace(/_/g, ' ')

/**
 * @param {{ location: { id: string, name: string, timezone: string }, country?: string,
 *           onClose: () => void, onChanged: (data: object) => void }} props
 */
export default function TimezoneChangeDialog({ location, country, onClose, onChanged }) {
  const confirmId = useId()
  const [attempt, setAttempt] = useState(0)
  const [pre, setPre] = useState({ state: 'loading', data: null, error: null })
  const [zone, setZone] = useState(location.timezone)
  const [typed, setTyped] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  useEffect(() => {
    let live = true
    fetch(`/api/locations/${location.id}/timezone`, { cache: 'no-store' })
      .then((res) => res.json().catch(() => ({ success: false })))
      .then((json) => {
        if (!live) return
        if (json?.success) setPre({ state: 'ready', data: json.data, error: null })
        else setPre({ state: 'error', data: null, error: json?.error || 'Could not load what this change affects.' })
      })
      .catch(() => { if (live) setPre({ state: 'error', data: null, error: 'Network error loading what this change affects.' }) })
    return () => { live = false }
  }, [location.id, attempt])

  const current = canonicalZone(location.timezone)
  const chosen = canonicalZone(zone)
  const nameMatches = typed.trim() !== '' && typed.trim() === String(location.name ?? '').trim()
  const canConfirm = pre.state === 'ready' && !!chosen && chosen !== current && nameMatches && !saving

  async function submit(e) {
    e.preventDefault()
    if (!canConfirm) return
    setSaving(true)
    setSaveError(null)
    let json
    try {
      const res = await fetch(`/api/locations/${location.id}/timezone`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: chosen, confirm_name: typed }),
      })
      json = await res.json().catch(() => ({ success: false }))
    } catch {
      json = { success: false, error: 'Network error saving the timezone. Try again.' }
    }
    setSaving(false)
    if (!json?.success) {
      setSaveError(json?.error || 'Could not change the timezone.')
      return
    }
    onChanged({ ...json.data, warning: json.warning || null })
  }

  const newLabel = chosen && chosen !== current ? display(chosen) : 'the new timezone'

  return (
    <Modal open onClose={onClose} title="Change timezone" size="lg" dismissOnBackdrop={false}>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <p className="text-un1t-subtle">
          {location.name} runs on <strong>{display(location.timezone)}</strong>.
        </p>

        {pre.state === 'loading' && <p className="text-un1t-muted">Counting what this change affects…</p>}

        {pre.state === 'error' && (
          <div className="space-y-2">
            <p role="alert" className="text-red-700">{pre.error}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => { setPre({ state: 'loading', data: null, error: null }); setAttempt((n) => n + 1) }}
            >
              Try again
            </Button>
          </div>
        )}

        {pre.state === 'ready' && (
          <>
            <TimezoneSelect label="New timezone" value={zone} country={country} onChange={setZone} />

            <div>
              <p className="font-medium text-un1t-text mb-1">At this studio right now</p>
              <ul className="divide-y divide-un1t-border border border-un1t-border rounded-md">
                {COUNT_LABELS.map(([key, label]) => {
                  const n = pre.data.future?.[key]
                  return (
                    <li key={key} className="flex items-center justify-between px-3 py-1.5">
                      <span>{label}</span>
                      <span className={n == null ? 'text-amber-700' : 'text-un1t-text tabular-nums'}>
                        {n == null ? 'unknown' : n}
                      </span>
                    </li>
                  )
                })}
              </ul>
              {pre.data.unknown?.length > 0 && (
                <p className="text-xs text-un1t-muted mt-1">
                  &ldquo;unknown&rdquo; means that count could not be read just now. It is not zero.
                </p>
              )}
            </div>

            <div className="rounded-md bg-amber-500/10 text-amber-700 px-3 py-2 space-y-1">
              <p>
                Times stay the same local clock time in the new timezone. A class at 09:00 stays at 09:00,
                now 09:00 in {newLabel}. Bookings, shifts, events and schedules are not moved.
              </p>
              <p>
                Reminders and messages already scheduled may shift to follow the new timezone.
                Past records and reports are not changed.
              </p>
            </div>

            <div>
              <label htmlFor={confirmId} className="block mb-1.5">
                Type the location name (<strong>{location.name}</strong>) to confirm
              </label>
              <input
                id={confirmId}
                type="text"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
              />
            </div>

            {saveError && <p role="alert" className="text-red-700">{saveError}</p>}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="danger" disabled={!canConfirm} loading={saving}>Change timezone</Button>
            </div>
          </>
        )}
      </form>
    </Modal>
  )
}
