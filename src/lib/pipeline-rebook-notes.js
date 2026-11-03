// REBOOK.1 — the timeline note a card gets when it lands in Rebook on a
// un1t.online board (shared/pipelines/acquisition-un1t.js needsRebook).
//
// The mig 004 trigger already logs "Pipeline: moved to Rebook" on a move; that
// says where the card went, not why. Conall (Hatch, 3 Nov 2026) cancelled his
// trial class because he could not sign in to the app, and none of it reached
// his deal. This note names the class he booked, when, and what became of it,
// so whoever picks up the card can call with the facts in front of them.
//
// Best-effort and after the run's writes, like the stage triggers: a failed
// read or insert is logged and never fails or holds up the pass.

import { logWarn } from './log.js'
import { getLocationZone, formatInZone, timeLabelIn } from './location-time.js'

const IN_CHUNK = 150
const ERR_MAX = 200
const bounded = (v) => String(v?.message || v || '').slice(0, ERR_MAX)

const OUTCOME = Object.freeze({
  CANCELLED: 'cancelled',
  LATE_CANCELLED: 'cancelled late',
  NO_SHOW: 'a no-show',
})

/**
 * The newest booking per contact that ended without the class. Pure.
 * @param {Array<{ contact_id: string, class_name?: string|null, starts_at: string, status?: string|null, attended?: boolean|null }>} rows
 * @param {number} nowMs
 * @returns {Map<string, object>}
 */
export function latestMissedBookingByContact(rows, nowMs) {
  const out = new Map()
  for (const r of rows || []) {
    if (!r?.contact_id || !r.starts_at) continue
    const status = String(r.status ?? '').toUpperCase()
    if (r.attended === true || status === 'ATTENDED') continue
    const startMs = Date.parse(r.starts_at)
    if (!Number.isFinite(startMs)) continue
    if (!OUTCOME[status] && startMs > nowMs) continue // a live booking still to come
    const prev = out.get(r.contact_id)
    if (!prev || Date.parse(prev.starts_at) < startMs) out.set(r.contact_id, r)
  }
  return out
}

/**
 * The note for one booking. Pure.
 * @param {{ class_name?: string|null, starts_at: string, status?: string|null }} booking
 * @param {string} zone  the studio's zone
 */
export function rebookNote(booking, zone) {
  const status = String(booking?.status ?? '').toUpperCase()
  const outcome = OUTCOME[status] || 'not attended'
  const day = formatInZone(booking.starts_at, zone, { weekday: 'short', day: 'numeric', month: 'short' }).replace(/,/g, '')
  const when = `${day} at ${timeLabelIn(booking.starts_at, zone)}`
  const cls = String(booking?.class_name ?? '').trim() || 'a class'
  return {
    subject: `Pipeline: Rebook (booked ${cls}, ${outcome})`,
    note: `Booked ${cls} on ${when}: ${outcome}. Has not trained here yet. `
      + 'Call to book them into another class, and check whether anything stopped them '
      + '(signing in to the app, the time, the class).',
  }
}

/**
 * Write one Rebook note per landed card. Reads this studio's un1t.online class
 * bookings for those contacts only.
 *
 * @param {object} db  service-role client
 * @param {{ locationId: string, landed: Array<{ contact_id: string, deal_id?: string|null }>, nowMs?: number }} a
 * @returns {Promise<{ written: number }>}
 */
export async function writeRebookNotes(db, { locationId, landed, nowMs = Date.now() }) {
  const cards = (landed || []).filter((m) => m?.contact_id)
  if (!locationId || cards.length === 0) return { written: 0 }
  try {
    const zone = await getLocationZone(db, locationId)
    const ids = [...new Set(cards.map((m) => m.contact_id))]
    const rows = []
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const { data, error } = await db
        .from('class_bookings')
        .select('contact_id, class_name, starts_at, status, attended')
        .eq('location_id', locationId)
        .eq('source_platform', 'un1t_online')
        .in('contact_id', ids.slice(i, i + IN_CHUNK))
      if (error) throw error
      rows.push(...(data || []))
    }
    const latest = latestMissedBookingByContact(rows, nowMs)
    const activities = []
    for (const m of cards) {
      const booking = latest.get(m.contact_id)
      if (!booking) continue
      activities.push({
        ...rebookNote(booking, zone),
        kind: 'event',
        type: 'pipeline',
        contact_id: m.contact_id,
        ...(m.deal_id ? { deal_id: m.deal_id } : {}),
        done: true,
        location_id: locationId,
      })
    }
    if (activities.length === 0) return { written: 0 }
    const { error: insErr } = await db.from('activities').insert(activities)
    if (insErr) throw insErr
    return { written: activities.length }
  } catch (e) {
    logWarn('pipeline-reclassify', 'rebook note write failed', { locationId, err: bounded(e) })
    return { written: 0 }
  }
}
