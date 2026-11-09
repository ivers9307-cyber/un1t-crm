// HOSTPORTAL.1 — how many places are booked in each session of an event.
//
// "Booked" is the public register gate's own count, so the host portal and the
// gate can never disagree: an unpaid entry still inside its hold counts, a
// lapsed one does not, in the event's unit (people or teams).
import { holdingPlaces } from '@/lib/entry-policy'
import { loadForMode } from '@/lib/event-signups'
import { loadWaveRegistrations, groupByWave } from '@/lib/registration-move'

function byOrderThenTime(a, b) {
  const order = (a.display_order ?? 0) - (b.display_order ?? 0)
  if (order !== 0) return order
  return String(a.start_time || '').localeCompare(String(b.start_time || ''))
}

/**
 * Pure. `rowsByWave` is a Map of wave id -> registrations (status,
 * registered_at, team.size). `event` supplies capacity_mode and entry_policy.
 */
export function sessionFill(waves, rowsByWave, nowMs, event) {
  const mode = event?.capacity_mode === 'people' ? 'people' : 'teams'
  const sessions = [...(waves || [])].sort(byOrderThenTime).map((w) => {
    const rows = rowsByWave?.get(w.id) || []
    const booked = loadForMode(holdingPlaces(rows, nowMs, event), mode, { held: true })
    const capacity = Number.isFinite(w.capacity) ? w.capacity : null
    return {
      id: w.id,
      label: w.label ?? null,
      time: String(w.start_time || '').slice(0, 5),
      capacity,
      booked,
      full: capacity !== null && booked >= capacity,
    }
  })
  const booked = sessions.reduce((sum, s) => sum + s.booked, 0)
  const capacity = sessions.length > 0 && sessions.every((s) => s.capacity !== null)
    ? sessions.reduce((sum, s) => sum + s.capacity, 0)
    : null
  return { sessions, booked, capacity }
}

/**
 * `event` carries id, capacity_mode, entry_policy and
 * race_waves ( id, start_time, capacity, label, display_order ).
 * A failed read is { ok: false }, never a zero that looks like an answer.
 */
export async function loadSessionFill(db, event) {
  const waves = event?.race_waves || []
  if (waves.length === 0) return { ok: true, ...sessionFill([], new Map(), Date.now(), event) }
  const { rows, error } = await loadWaveRegistrations(db, waves.map((w) => w.id))
  if (error) return { ok: false }
  return { ok: true, ...sessionFill(waves, groupByWave(rows), Date.now(), event) }
}
