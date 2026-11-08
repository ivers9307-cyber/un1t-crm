// event-sessions — HOSTSERIES.1: the host form's `sessions[]` as race_waves
// rows. One helper both host routes call, so create and edit write waves the
// same way.
//
// Two halves, so a route can JUDGE before it writes anything of its own
// (the host PUT used to stamp a published event back to review and then
// refuse the sessions):
//   - judgeSessions: the two refusals, both reads. A removed session (a
//     current wave absent from `sessions`) must have no LIVE entry
//     (confirmed or awaiting payment): race_registrations.wave_id is ON
//     DELETE SET NULL (mig 083), so deleting the wave would leave a booked
//     entry with no time (a cancelled or no-show entry on it loses its
//     wave_id, accepted: history). And race_waves is UNIQUE (race_event_id,
//     start_time), so a swap of two times (10:00↔14:00) cannot be applied
//     row by row: a kept or new session whose time is another KEPT session's
//     old time is duplicate_session_time.
//   - syncEventSessions: judge, then write: deletes, updates (display_order =
//     index), inserts. The writes are sequential, so a failure after the first
//     one can leave an earlier write applied; the message says to reload.
//
// Every write destructures `error` (a supabase builder resolves, never throws).

import { logError } from './log'

export const SESSION_ERRORS = Object.freeze({
  HAS_ENTRIES: 'session_has_entries',
  DUPLICATE_TIME: 'duplicate_session_time',
  WRITE_FAILED: 'write_failed',
})

const hhmm = (t) => String(t || '').slice(0, 5)

/**
 * race_waves rows → the form's sessions, ordered by display_order then time.
 * @param {Array|null} waves  rows with id, start_time (TIME: "HH:MM:SS"), label, capacity, display_order
 * @returns {Array<{ id: string, start_time: string, label: string|null, capacity: number|null }>}
 */
export function sessionsFromWaves(waves) {
  return (Array.isArray(waves) ? [...waves] : [])
    .sort((a, b) => ((a.display_order ?? 0) - (b.display_order ?? 0)) || hhmm(a.start_time).localeCompare(hhmm(b.start_time)))
    .map((w) => ({ id: w.id, start_time: hhmm(w.start_time), label: w.label ?? null, capacity: w.capacity ?? null }))
}

function hasEntriesRefusal(time) {
  return {
    ok: false,
    error: SESSION_ERRORS.HAS_ENTRIES,
    session_time: time,
    message: `The ${time} session has bookings, so it cannot be removed. Move or cancel its entries first.`,
  }
}
const DUPLICATE = Object.freeze({
  ok: false,
  error: SESSION_ERRORS.DUPLICATE_TIME,
  message: 'Two sessions would share a start time. Move one session to a different time first, save, then set the other.',
})
const WRITE_FAILED = Object.freeze({ ok: false, error: SESSION_ERRORS.WRITE_FAILED, message: 'The sessions could not be saved. Reload the event to see what was kept, then try again.' })

function partition(sessions, currentWaves) {
  const current = Array.isArray(currentWaves) ? currentWaves : []
  const wanted = Array.isArray(sessions) ? sessions : []
  const keptIds = new Set(wanted.filter((s) => s.id).map((s) => s.id))
  return {
    current, wanted,
    removed: current.filter((w) => !keptIds.has(w.id)),
    kept: wanted.filter((s) => s.id && current.some((w) => w.id === s.id)),
    added: wanted.filter((s) => !s.id || !current.some((w) => w.id === s.id)),
  }
}

/**
 * The refusals, before any write: a swap of kept times, a removed session
 * with live entries, or a failed count (write_failed, never a delete).
 * @returns {Promise<{ ok: true } | { ok: false, error: string, message: string, session_time?: string }>}
 */
export async function judgeSessions(db, { eventId, sessions, currentWaves }) {
  const { current, wanted, removed, kept } = partition(sessions, currentWaves)
  // A kept session's OLD time is still in the table while the others are
  // written; any session taking it (other than that session itself) would
  // collide mid-save.
  const oldTimeByKept = new Map(kept.map((s) => [s.id, hhmm(current.find((w) => w.id === s.id)?.start_time)]))
  for (const s of wanted) {
    for (const [id, oldTime] of oldTimeByKept) {
      if (id !== s.id && hhmm(s.start_time) === oldTime) return DUPLICATE
    }
  }
  for (const w of removed) {
    const { count, error } = await db
      .from('race_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('wave_id', w.id)
      .in('status', ['confirmed', 'pending_payment'])
    if (error) {
      logError('event-sessions', 'live-entry count failed; sessions not saved', { err: error, eventId, waveId: w.id })
      return WRITE_FAILED
    }
    if ((count || 0) > 0) return hasEntriesRefusal(hhmm(w.start_time))
  }
  return { ok: true }
}

/**
 * @param {object} db  service-role client
 * @param {{ eventId: string, sessions: Array<{ id?: string, start_time: string, label?: string|null, capacity: number }>, currentWaves: Array }} args
 * @returns {Promise<{ ok: true, waves: Array } | { ok: false, error: string, message: string, session_time?: string }>}
 */
export async function syncEventSessions(db, { eventId, sessions, currentWaves }) {
  const judged = await judgeSessions(db, { eventId, sessions, currentWaves })
  if (!judged.ok) return judged
  const { wanted, removed, kept, added } = partition(sessions, currentWaves)

  const judge = (error, step) => {
    if (!error) return null
    if (error.code === '23505') return DUPLICATE
    logError('event-sessions', `${step} failed`, { err: error, eventId })
    return WRITE_FAILED
  }

  if (removed.length > 0) {
    const { error } = await db.from('race_waves').delete().in('id', removed.map((w) => w.id))
    const refusal = judge(error, 'wave delete')
    if (refusal) return refusal
  }
  const out = []
  for (const [index, s] of wanted.entries()) {
    if (!kept.includes(s)) continue
    const patch = { start_time: s.start_time, label: s.label ?? null, capacity: s.capacity, display_order: index }
    const { error } = await db.from('race_waves').update(patch).eq('id', s.id)
    const refusal = judge(error, 'wave update')
    if (refusal) return refusal
    out.push({ id: s.id, ...patch })
  }
  if (added.length > 0) {
    const rows = wanted
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => added.includes(s))
      .map(({ s, index }) => ({ race_event_id: eventId, start_time: s.start_time, label: s.label ?? null, capacity: s.capacity, display_order: index }))
    const { data, error } = await db.from('race_waves').insert(rows).select('id, start_time, label, capacity, display_order')
    const refusal = judge(error, 'wave insert')
    if (refusal) return refusal
    for (const r of data || []) out.push(r)
  }
  return { ok: true, waves: out }
}
