// LIEU.1 — the time-in-lieu ledger (staff_lieu_credits, mig 761): the nightly
// sweep that credits Sunday and public-holiday work, and the reads the
// allowances route, the WRC pack and the Staff Cost report share.
//
// THE SWEEP. For every studio, every COMPLETED (its paid window has ended on
// the studio's clock), non-cancelled shift assignment of an FTE employee on a
// Sunday or a public holiday (bank-holidays.js, the studio's country, 'IE'
// when unset) in the last `lookbackDays` days gets one credit row
// (lieuCreditForShift, lieu-rules.js). Idempotent: the row points at its
// shift_assignment_id, which is UNIQUE, and the insert is ON CONFLICT DO
// NOTHING, so a night can run twice (or be re-run over a longer window to
// backfill) without a second credit. Tombstoned and deactivated staff are
// credited like anyone else: the hours were worked and the record is history
// (the same reasoning as the WRC pack).
//
// WHAT A FAILURE MEANS. A studio whose shift read failed is counted in
// `failed` with its message, and the other studios still run; the cron stamps
// its heartbeat unless the locations read failed or EVERY studio failed (a
// green heartbeat over a sweep that credited nothing is the failure the row
// exists to catch). An insert error on one chunk is counted in `failed` too
// and the next chunk still goes in: never a louder failure than the quiet one
// it replaces.
//
// Every read pages past the 1,000-row cap (fetchScheduledShiftRows pages;
// the ledger reads page here).

import { fetchScheduledShiftRows } from '@/lib/report-generator'
import { getStaticHolidays } from '@/lib/bank-holidays'
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'
import { zoneOfLocation, zonedWallClockToInstant, addDaysISO, todayStrIn, strictDayStartMsIn } from '@/lib/location-time'
import { lieuCreditForShift, sundayLieuMultiplier, lieuBalanceFrom } from '@/lib/lieu-rules'
import { logWarn } from '@/lib/log'

export const LIEU_SWEEP_LOOKBACK_DAYS = 14
export const LIEU_SWEEP_MAX_LOOKBACK_DAYS = 400
const PAGE = 1000
const INSERT_CHUNK = 200
const ID_CHUNK = 200

/**
 * The instant a shift's paid window ends on the studio's clock, or null when
 * its times are unreadable. An end at or before the start is the next day
 * (overnight), and 24:00 is the following midnight (timeToHours' reading).
 * Pure.
 */
export function shiftEndInstant(shift, zone) {
  const date = shift?.shift_date
  const start = String(effectiveShiftStart(shift) || '').slice(0, 5)
  const end = String(effectiveShiftEnd(shift) || '').slice(0, 5)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null
  if (end === '24:00') return strictDayStartMsIn(addDaysISO(date, 1), zone)
  const endDay = start && end <= start ? addDaysISO(date, 1) : date
  return zonedWallClockToInstant(endDay, end, zone)
}

/**
 * Pure: the credit rows a studio's shift rows yield, with the shifts that
 * were skipped and why. `existingAssignmentIds` are already credited.
 *
 * @returns {{ rows: Array<object>, skipped: { existing: number, not_ended: number, not_due: number } }}
 */
export function lieuCreditRowsFor({ shifts, locationId, zone, holidaysByDate, sundayMultiplier, existingAssignmentIds, nowMs }) {
  const existing = existingAssignmentIds instanceof Set ? existingAssignmentIds : new Set(existingAssignmentIds || [])
  const rows = []
  const skipped = { existing: 0, not_ended: 0, not_due: 0 }
  for (const s of shifts || []) {
    if (!s?.assignment_id || !s.profile_id) continue
    const credit = lieuCreditForShift({ shift: s, holidayName: holidaysByDate.get(s.shift_date) || null, sundayMultiplier })
    if (!credit) { skipped.not_due += 1; continue }
    if (existing.has(s.assignment_id)) { skipped.existing += 1; continue }
    const endMs = shiftEndInstant(s, zone)
    if (endMs === null || endMs > nowMs) { skipped.not_ended += 1; continue }
    rows.push({
      profile_id: s.profile_id,
      location_id: locationId,
      source: credit.source,
      shift_assignment_id: s.assignment_id,
      credit_date: s.shift_date,
      hours: credit.hours,
      worked_hours: credit.worked_hours,
      multiplier: credit.multiplier,
      holiday_name: credit.holiday_name,
      note: null,
      created_by: null,
    })
  }
  return { rows, skipped }
}

function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

async function pageAll(make) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1)
    if (error) return { rows: [], error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { rows, error: null }
}

/** The assignment ids among `assignmentIds` that already hold a credit. */
export async function readCreditedAssignmentIds(db, assignmentIds) {
  const ids = [...new Set((assignmentIds || []).filter(Boolean))]
  const out = new Set()
  for (const part of chunk(ids, ID_CHUNK)) {
    const { rows, error } = await pageAll((a, b) => db.from('staff_lieu_credits')
      .select('shift_assignment_id')
      .in('shift_assignment_id', part)
      .order('id')
      .range(a, b))
    if (error) return { ids: null, error }
    for (const r of rows) if (r.shift_assignment_id) out.add(r.shift_assignment_id)
  }
  return { ids: out, error: null }
}

/**
 * Runs the sweep for every studio.
 * @param {object} db  service-role client
 * @param {{ nowMs?: number, lookbackDays?: number }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, locations: number, candidates: number, inserted: number, skipped_existing: number, skipped_not_ended: number, failed: number, failures: Array<{ location_id: string, step: string, error: string }> }>}
 */
export async function runLieuCreditSweep(db, { nowMs = Date.now(), lookbackDays = LIEU_SWEEP_LOOKBACK_DAYS } = {}) {
  const stats = { ok: true, locations: 0, candidates: 0, inserted: 0, skipped_existing: 0, skipped_not_ended: 0, failed: 0, failures: [] }
  const days = Math.min(Math.max(1, Math.floor(Number(lookbackDays) || LIEU_SWEEP_LOOKBACK_DAYS)), LIEU_SWEEP_MAX_LOOKBACK_DAYS)

  const { rows: locations, error: locErr } = await pageAll((a, b) => db.from('locations')
    .select('id, country, timezone, settings')
    .order('id')
    .range(a, b))
  if (locErr) {
    logWarn('lieu-credits', 'locations read failed; sweep not run', { err: locErr.message })
    return { ...stats, ok: false, error: `Failed to read studios: ${locErr.message}` }
  }
  stats.locations = locations.length

  for (const loc of locations) {
    const zone = zoneOfLocation(loc)
    const today = todayStrIn(zone, nowMs)
    const periodEnd = today
    const periodStart = addDaysISO(today, -days)
    const country = loc.country || 'IE'
    const holidaysByDate = new Map(getStaticHolidays(periodStart, periodEnd, country).map((h) => [h.date, h.name]))
    const sundayMultiplier = sundayLieuMultiplier(loc.settings)

    const { rows: shifts, error: shiftErr } = await fetchScheduledShiftRows(db, { locationId: loc.id, periodStart, periodEnd })
    if (shiftErr) {
      stats.failed += 1
      stats.failures.push({ location_id: loc.id, step: 'shifts', error: shiftErr })
      continue
    }

    // Only the shifts that could earn anything are asked about.
    const due = shifts.filter((s) => s.assignment_id && lieuCreditForShift({ shift: s, holidayName: holidaysByDate.get(s.shift_date) || null, sundayMultiplier }))
    stats.candidates += due.length
    if (due.length === 0) continue

    const { ids: existing, error: existErr } = await readCreditedAssignmentIds(db, due.map((s) => s.assignment_id))
    if (existErr) {
      stats.failed += 1
      stats.failures.push({ location_id: loc.id, step: 'ledger', error: existErr.message })
      continue
    }

    const { rows, skipped } = lieuCreditRowsFor({
      shifts: due, locationId: loc.id, zone, holidaysByDate, sundayMultiplier, existingAssignmentIds: existing, nowMs,
    })
    stats.skipped_existing += skipped.existing
    stats.skipped_not_ended += skipped.not_ended

    for (const part of chunk(rows, INSERT_CHUNK)) {
      // A race with a second tick lands on the unique index and is ignored:
      // the first writer's row stands.
      const { data, error } = await db.from('staff_lieu_credits')
        .upsert(part, { onConflict: 'shift_assignment_id', ignoreDuplicates: true })
        .select('id')
      if (error) {
        stats.failed += 1
        stats.failures.push({ location_id: loc.id, step: 'insert', error: error.message })
        logWarn('lieu-credits', 'credit insert failed', { locationId: loc.id, rows: part.length, err: error.message })
        continue
      }
      stats.inserted += Array.isArray(data) ? data.length : 0
    }
  }

  if (stats.locations > 0 && stats.failed >= stats.locations) {
    stats.ok = false
    stats.error = 'Every studio failed'
  }
  return stats
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * One person's ledger rows for a calendar year (credit_date), oldest first.
 * @returns {Promise<{ rows: Array<object>, error: object|null }>}
 */
export async function readLieuLedger(db, profileId, year) {
  const y = Number(year)
  return pageAll((a, b) => db.from('staff_lieu_credits')
    .select('id, profile_id, location_id, source, shift_assignment_id, credit_date, hours, worked_hours, multiplier, holiday_name, note, created_by, created_at')
    .eq('profile_id', profileId)
    .gte('credit_date', `${y}-01-01`)
    .lte('credit_date', `${y}-12-31`)
    .order('credit_date', { ascending: true })
    .order('created_at', { ascending: true })
    .range(a, b))
}

/**
 * One person's lieu balance for a year: credited, taken and the signed sum,
 * in hours. Fails closed: an unreadable ledger is an error, never 0.
 * @returns {Promise<{ lieu: { year: number, credited_hours: number, taken_hours: number, balance_hours: number }|null, error: object|null }>}
 */
export async function getLieuBalance(db, profileId, year) {
  const { rows, error } = await readLieuLedger(db, profileId, year)
  if (error) return { lieu: null, error }
  return { lieu: { year: Number(year), ...lieuBalanceFrom(rows) }, error: null }
}

/**
 * Every ledger row of these people dated on or before `to`, for the WRC pack
 * and the Staff Cost report (both judge a period and a running balance).
 * @returns {Promise<{ rows: Array<object>, error: object|null }>}
 */
export async function readLieuLedgerForProfiles(db, profileIds, { to, from = null } = {}) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  const rows = []
  for (const part of chunk(ids, ID_CHUNK)) {
    const res = await pageAll((a, b) => {
      let q = db.from('staff_lieu_credits')
        .select('id, profile_id, location_id, source, shift_assignment_id, credit_date, hours, worked_hours, multiplier, holiday_name, note')
        .in('profile_id', part)
        .lte('credit_date', to)
      if (from) q = q.gte('credit_date', from)
      return q.order('id').range(a, b)
    })
    if (res.error) return { rows: [], error: res.error }
    rows.push(...res.rows)
  }
  return { rows, error: null }
}
