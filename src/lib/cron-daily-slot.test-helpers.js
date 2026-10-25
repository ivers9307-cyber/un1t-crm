// Test helpers for the TZ.6 daily-slot gate (src/lib/cron-daily-slot.js).
//
//   slotTables(opts)       an in-memory `locations` + `cron_daily_slot_claims`
//                          pair speaking just the PostgREST chains the gate uses.
//   withSlotTables(db, o)  wraps a route test's fake db so those two tables are
//                          served by slotTables and every other table by `db`.
//   openGate               a drop-in for gateDailySlot that reports EVERY
//                          location due in Europe/Dublin today, for the route
//                          tests that pre-date TZ.6 (their subject is the body,
//                          not the gate):
//     vi.mock('@/lib/cron-daily-slot', async (importOriginal) => ({
//       ...(await importOriginal()),
//       gateDailySlot: (await import('@/lib/cron-daily-slot.test-helpers')).openGate,
//     }))
import { DEFAULT_TZ, dayStrIn, zoneOfLocation } from '@/lib/location-time'

const thenable = (result) => ({ then: (res, rej) => Promise.resolve(result).then(res, rej) })

/**
 * @param {object} [opts]
 * @param {Array<{id:string, timezone:string|null}>} [opts.locations]
 * @param {Map<string, object>} [opts.claims] key `${cron}|${scope}|${day}` → row (shared across calls)
 * @param {() => object|null} [opts.locationsError] error for the next locations read, or null
 * @param {() => object|null} [opts.claimError] error for the next claim upsert, or null
 */
export function slotTables({ locations = [], claims = new Map(), locationsError = () => null, claimError = () => null } = {}) {
  const calls = { locationReads: 0, claimUpserts: 0, claimRows: [] }
  function from(table) {
    if (table === 'locations') {
      let range = [0, 999]
      let ids = null
      const b = {
        select: () => b,
        order: () => b,
        in: (_col, list) => { ids = list; return b }, // getLocationZones' read
        range: (f, t) => { range = [f, t]; return b },
        then: (res, rej) => {
          calls.locationReads++
          const err = locationsError()
          const sorted = [...locations].filter((l) => !ids || ids.includes(l.id)).sort((a, c) => (a.id < c.id ? -1 : 1))
          const out = err ? { data: null, error: err } : { data: sorted.slice(range[0], range[1] + 1), error: null }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return b
    }
    if (table === 'cron_daily_slot_claims') {
      return {
        upsert(rows, options) {
          calls.claimUpserts++
          return {
            select: () => {
              const err = claimError()
              if (err) return thenable({ data: null, error: err })
              if (options?.onConflict !== 'cron_name,scope,slot_day' || options?.ignoreDuplicates !== true) {
                return thenable({ data: null, error: { code: 'TEST', message: 'unexpected upsert options' } })
              }
              const won = []
              for (const r of rows) {
                calls.claimRows.push(r)
                const k = `${r.cron_name}|${r.scope}|${r.slot_day}`
                if (claims.has(k)) continue
                claims.set(k, r)
                won.push({ scope: r.scope })
              }
              return thenable({ data: won, error: null })
            },
          }
        },
      }
    }
    return null
  }
  return { from, claims, calls }
}

/**
 * Serve the gate's reads from slotTables(opts) (the claim table, and the
 * `locations` read that selects exactly 'id, timezone'); everything else,
 * other `locations` selects included, from `db`.
 */
export function withSlotTables(db, opts) {
  const slots = slotTables(opts)
  return {
    ...db,
    slots,
    from(table) {
      if (table === 'locations') {
        return {
          select: (cols, ...rest) => (cols === 'id, timezone'
            ? slots.from('locations').select(cols)
            : db.from('locations').select(cols, ...rest)),
        }
      }
      return slots.from(table) || db.from(table)
    },
  }
}

class OpenSlots extends Map {
  constructor(day) { super(); this.day = day }
  has() { return true }
  get(scope) {
    return { locationId: scope === 'none' ? null : scope, zone: DEFAULT_TZ, day: this.day, lateHours: 0, legacy: true, fallback: false }
  }
  get size() { return 1 }
}
const OPEN_SUMMARY = { due: 1, claimed: 1, already: 0, claim_failed: 0, waiting: 0, legacy_fallback: 0, zone_unread: 0 }

/**
 * gateDailySlot stand-in: every location is due now, in ITS OWN zone (taken
 * from `rows`, [{ id, timezone }]); for tests whose subject is a per-studio
 * body, not the gate.
 */
export const openGateZoned = (rows) => async (_db, _cronName, { nowMs = Date.now() } = {}) => {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const slots = new OpenSlots(null)
  slots.get = (scope) => {
    const zone = scope === 'none' ? DEFAULT_TZ : zoneOfLocation(byId.get(scope) || { id: scope, timezone: null })
    return { locationId: scope === 'none' ? null : scope, zone, day: dayStrIn(nowMs, zone), lateHours: 0, legacy: zone === DEFAULT_TZ, fallback: false }
  }
  return { ok: true, faulted: false, slots, summary: { ...OPEN_SUMMARY } }
}

/** gateDailySlot stand-in: every location is due today, in Europe/Dublin. */
export async function openGate(_db, _cronName, { nowMs = Date.now() } = {}) {
  return { ok: true, faulted: false, slots: new OpenSlots(dayStrIn(nowMs, DEFAULT_TZ)), summary: { ...OPEN_SUMMARY } }
}

/** As openGate, with every location's day fixed to `day` (for tests that pin "today"). */
export const openGateOn = (day) => async () => ({ ok: true, faulted: false, slots: new OpenSlots(day), summary: { ...OPEN_SUMMARY } })
