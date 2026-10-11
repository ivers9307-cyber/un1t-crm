// src/lib/cron-daily-slot.js — TZ.6 (mig 720). The daily-slot gate: a cron that
// used to fire ONCE a day at a fixed UTC hour now runs HOURLY and acts for each
// location only when that location's daily slot is due, at most once per
// location per local day.
//
// D6 = B (Richard, 11 Oct 2026):
//   • A location whose zone is Europe/Dublin stays on the cron's LEGACY UTC hour
//     (LEGACY_UTC_ANCHORED), so UN1T's sends land at exactly the UTC instant they
//     always did, summer and winter.
//   • Every other zone acts when its LOCAL hour is the slot hour.
//   • Switching UN1T to local anchoring later is its own ⚠️ card: empty
//     LEGACY_UTC_ANCHORED.
//   A slot with `anchor: 'local'` was already local before TZ.6
//   (receipt-coverage-weekly: Friday 08:00 Dublin wall clock, fired at 07:00 AND
//   08:00 UTC): it is local for every zone, Dublin included, so it too is
//   unchanged for UN1T.
//
// THE CLAIM. Each due location is claimed in public.cron_daily_slot_claims
// (PK cron_name + scope + slot_day: the location's LOCAL day) before the cron
// acts for it. An hourly schedule therefore acts at most once per location per
// local day, including on a DST fall-back day when a local hour happens twice,
// and including a Vercel double-invocation or a manual re-run. The claim is the
// day's single shot, exactly as the old once-a-day schedule was: a location
// that was claimed and then failed part-way is NOT re-run that day (its own
// per-message ledgers decide any retry, unchanged).
//
// CATCH-UP. A slot stays due for SLOT_CATCHUP_HOURS ticks after its hour, but
// only while it is UNCLAIMED. In normal operation the slot-hour tick claims
// every due location, so nothing changes. The window exists for a tick that
// could not claim: the location's zone could not be read (never act on a
// guessed zone), or the claim write failed. Then nothing was taken and the next
// hourly tick retries.
//
// DEPLOY ORDER. Mig 720 creates the claim table and is applied right AFTER the
// deploy (its heartbeat half must not land before the hourly code runs). Until
// it lands, a claim insert finds no table: a Europe/Dublin location then acts
// at its EXACT pre-TZ.6 instant with no claim (precisely the old behaviour) and
// any other zone waits (catch-up picks it up once the table exists). Mig 720
// seeds a claim for every Dublin slot that had already passed today, so the
// catch-up window can never re-send what the old code (or this fallback) sent
// before the table existed.
//
// The location universe is EVERY `locations` row plus NO_LOCATION (rows whose
// location_id is NULL resolve to DEFAULT_TZ, the documented "no location" zone).
// Claiming every due location at the slot tick, whether or not it has work,
// is what keeps the catch-up window from acting on work that appears after the
// slot (a challenge created at 08:30 is not announced at 09:00).

import { selectAll } from '@/lib/select-all'
import { DEFAULT_TZ, PLATFORM_TZ, canonicalZone, dayStrIn, instantToZonedParts, resolveZone, zoneOfLocation } from '@/lib/location-time'
import { logError, logWarn } from '@/lib/log'

/**
 * Zones that keep the cron's legacy UTC hour (D6 = B): the zone those UTC hours
 * were chosen for, Europe/Dublin, the platform's (PLATFORM_TZ, D4). Compare
 * through canonicalZone().
 */
export const LEGACY_UTC_ANCHORED = new Set([PLATFORM_TZ])

/** Ticks after the slot hour that may still claim an UNCLAIMED slot (a retry). */
export const SLOT_CATCHUP_HOURS = 2

/** Claim scope for rows with no location_id. */
export const NO_LOCATION = 'none'
export const scopeOf = (locationId) => locationId || NO_LOCATION

export const CLAIMS_TABLE = 'cron_daily_slot_claims'
const CLAIM_BATCH = 500 // rows per upsert: the RETURNING set stays under the 1k row cap

/**
 * Every converted cron's slot. `hour` is the legacy UTC hour (= the local hour
 * for non-legacy zones); `weekday` is ISO (1 = Monday); `anchor: 'local'` means
 * the legacy schedule was already local wall clock. The minute is vercel.json's
 * (the gate works per hour). Mirrored in mig 720's seed: change both.
 */
export const DAILY_SLOTS = Object.freeze({
  'equipment-inspection-reminder': Object.freeze({ hour: 6 }),
  'morning-briefing': Object.freeze({ hour: 6, weekday: 1 }),
  'ad-report-email': Object.freeze({ hour: 7 }),
  'churn-radar-digest': Object.freeze({ hour: 7, weekday: 1 }),
  'run-scheduled-reports': Object.freeze({ hour: 7 }),
  'contract-reminders': Object.freeze({ hour: 8 }),
  'run-challenge-events': Object.freeze({ hour: 8 }),
  'receipt-coverage-weekly': Object.freeze({ hour: 8, weekday: 5, anchor: 'local' }),
  'event-reminders': Object.freeze({ hour: 9 }),
  'notify-winback': Object.freeze({ hour: 10 }),
  'notify-onboarding-pace': Object.freeze({ hour: 10 }),
  'notify-streak-at-risk': Object.freeze({ hour: 11 }),
  'equipment-inspection-sweep': Object.freeze({ hour: 19 }),
})

/** True when `zone` keeps the pre-TZ.6 schedule (a Europe/Dublin location). */
const keepsLegacySchedule = (zone) => LEGACY_UTC_ANCHORED.has(canonicalZone(zone) ?? resolveZone(zone))

/** True when `zone` keeps the legacy UTC hour for a slot of this anchor. */
export function isLegacyAnchored(zone, slot = {}) {
  if (slot.anchor === 'local') return false
  return keepsLegacySchedule(zone)
}

/**
 * Pure: is `slot` due for a location in `zone` at `nowMs`, and which local day
 * does it belong to?
 * @param {string} zone canonical IANA zone (a location's resolved zone)
 * @param {number} nowMs
 * @param {{hour:number, weekday?:number, anchor?:'local'}} slot
 * @returns {{ due:boolean, day:string, lateHours:number, legacy:boolean }}
 *   day: the location's LOCAL calendar day (the claim key). For a legacy
 *   anchored slot it is also the UTC day: every slot hour + catch-up is <= 21
 *   UTC, when Dublin's date is the UTC date (location-time.daily-slot test).
 */
export function dailySlotDue(zone, nowMs, slot) {
  const z = resolveZone(zone)
  const legacy = isLegacyAnchored(z, slot)
  const clock = instantToZonedParts(nowMs, legacy ? 'UTC' : z)
  const lateHours = clock.h - slot.hour
  const due = lateHours >= 0 && lateHours <= SLOT_CATCHUP_HOURS &&
    (slot.weekday == null || clock.weekday === slot.weekday)
  return { due, day: dayStrIn(nowMs, z), lateHours, legacy }
}

// The table does not exist yet (mig 720 not applied): Postgres 42P01, or
// PostgREST's schema-cache miss.
const isMissingTable = (error) => error?.code === '42P01' || error?.code === 'PGRST205'

/**
 * The gate. Reads every location's zone, works out which are due now, claims
 * them, and returns the claimed ones. Never throws.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {keyof typeof DAILY_SLOTS} cronName
 * @param {{ nowMs?: number, module?: string, slot?: object }} [opts]
 *   slot: override DAILY_SLOTS[cronName] (tests only).
 * @returns {Promise<{
 *   ok: boolean,
 *   slots: Map<string, { locationId: string|null, zone: string, day: string, lateHours: number, legacy: boolean }>,
 *   summary: { due: number, claimed: number, already: number, claim_failed: number, legacy_fallback: number, zone_unread: number },
 * }>} slots is keyed by scopeOf(location_id); read it with slotFor(). ok=false
 *   only when the zones could not be read: then NOTHING may act this tick.
 */
export async function gateDailySlot(db, cronName, { nowMs = Date.now(), module = cronName, slot: slotOverride } = {}) {
  const slot = slotOverride || DAILY_SLOTS[cronName]
  if (!slot) throw new Error(`cron-daily-slot: no slot for ${cronName}`)
  const summary = { due: 0, claimed: 0, already: 0, claim_failed: 0, legacy_fallback: 0, zone_unread: 0 }
  const slots = new Map()

  // Zones. A failed read is a DB outage: no location acts on a guessed zone,
  // nothing is claimed, and the next hourly tick (still inside the catch-up
  // window) retries.
  let rows
  try {
    rows = await selectAll((from, to) => db.from('locations').select('id, timezone').order('id').range(from, to))
  } catch (err) {
    summary.zone_unread = 1
    logError(module, 'locations.timezone unreadable; no location acts this tick, the next hourly tick retries', { cron: cronName, err })
    return { ok: false, slots, summary }
  }

  const due = []
  for (const loc of [...rows, { id: null, timezone: DEFAULT_TZ }]) {
    const zone = loc.id ? zoneOfLocation(loc) : DEFAULT_TZ
    const state = dailySlotDue(zone, nowMs, slot)
    if (!state.due) continue
    due.push({ scope: scopeOf(loc.id), locationId: loc.id || null, zone, ...state })
  }
  summary.due = due.length

  let tableMissing = false
  for (let i = 0; i < due.length; i += CLAIM_BATCH) {
    const batch = due.slice(i, i + CLAIM_BATCH)
    const { data, error } = await db.from(CLAIMS_TABLE)
      .upsert(batch.map((d) => ({
        cron_name: cronName, scope: d.scope, slot_day: d.day, location_id: d.locationId, zone: d.zone,
      })), { onConflict: 'cron_name,scope,slot_day', ignoreDuplicates: true })
      .select('scope')
    if (error) {
      if (isMissingTable(error)) {
        tableMissing = true
        // Pre-mig-720: a Europe/Dublin location acts at exactly the instant the
        // old schedule did (its slot hour, no claim, no catch-up); every other
        // location waits for the table.
        for (const d of batch) {
          if (keepsLegacySchedule(d.zone) && d.lateHours === 0) {
            slots.set(d.scope, slotOf(d))
            summary.legacy_fallback++
          } else {
            summary.claim_failed++
          }
        }
        continue
      }
      summary.claim_failed += batch.length
      logError(module, 'daily-slot claim failed; these locations act on a later tick', {
        cron: cronName, locations: batch.length, code: error.code, err: error.message,
      })
      continue
    }
    const won = new Set((data || []).map((r) => r.scope))
    for (const d of batch) {
      if (won.has(d.scope)) { slots.set(d.scope, slotOf(d)); summary.claimed++ }
      else summary.already++
    }
  }
  if (tableMissing) {
    logWarn(module, 'cron_daily_slot_claims missing (mig 720 not applied yet): legacy-hour fallback, no claim', {
      cron: cronName, legacy_fallback: summary.legacy_fallback, waiting: summary.claim_failed,
    })
  }
  return { ok: true, slots, summary }
}

function slotOf(d) {
  return { locationId: d.locationId, zone: d.zone, day: d.day, lateHours: d.lateHours, legacy: d.legacy }
}

/** The claimed slot for a row's location_id (NULL → NO_LOCATION), or undefined. */
export function slotFor(slots, locationId) {
  return slots.get(scopeOf(locationId))
}

/**
 * Home location of each contact, for the member crons that gate per member
 * (D7: a member's zone is their home location's). Chunks of 200 ids, so
 * neither the URL nor the 1k row cap binds. A failed chunk is NOT "no home":
 * its contacts are left out of `homes` (the caller skips them, never acting on
 * a guessed zone) and counted in `unread`. A contact with no row or a NULL
 * location_id maps to null (NO_LOCATION, DEFAULT_TZ).
 * @returns {Promise<{ homes: Map<string, string|null>, unread: number }>}
 */
export async function readContactHomes(db, contactIds, module) {
  const homes = new Map()
  let unread = 0
  const ids = [...new Set(contactIds)]
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data, error } = await db.from('contacts').select('id, location_id').in('id', chunk)
    if (error) {
      unread += chunk.length
      logError(module, 'contact home-location read failed; these members are skipped this tick', { contacts: chunk.length, err: error })
      continue
    }
    const byId = new Map((data || []).map((r) => [r.id, r.location_id || null]))
    for (const id of chunk) homes.set(id, byId.has(id) ? byId.get(id) : null)
  }
  return { homes, unread }
}
