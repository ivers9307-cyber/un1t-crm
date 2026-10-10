// W1.M3b — how a cron (or Mia) DISCOVERS the locations a membership source
// serves. Until this task five crons sniffed `settings->'glofox'` plus the
// three legacy credentials to decide who to sync, which (a) tried Hatch Street
// and CCF Autos every tick (empty slices) and (b) never saw a registry-only
// Glofox connection. Discovery now goes through the seam:
//
//   listLocationsByMembershipSource(db, key)   → the ids on that source
//   membershipSourceState(db, id)               → configured | unconfigured | unknown
//
// so a cron can say WHY a location was skipped instead of silently passing it.
// A failed read is `{ error }` with every list null, never "no locations": the
// caller must answer 500 and NOT stamp its heartbeat (a quiet tick that visited
// nobody would read as healthy).
import { listLocationsByMembershipSource, membershipSourceState } from './source'
import { logWarn, logError } from '@/lib/log'

// PostgREST `.in()` is a URL; keep each chunk short.
const ID_CHUNK = 200

/**
 * Active locations whose membership_source is `key`, each with its state.
 *
 * @param {object} db   service-role client
 * @param {string} key  a value the mig 717 CHECK admits
 * @param {{ module?: string }} [opts]  log module for the skip lines
 * @returns {Promise<{
 *   locations: Array<{ id: string, name: string|null, source: string|null, state: string, missing?: string[], readError?: string }>|null,
 *   eligible: Array<object>|null,   // state === 'configured': the ones to work
 *   skipped: Array<object>|null,    // unconfigured | unknown: logged, counted, not worked
 *   error: any,
 * }>}
 */
export async function locationsWithSource(db, key, { module = 'membership-source' } = {}) {
  const { ids, error } = await listLocationsByMembershipSource(db, key)
  if (error) return { locations: null, eligible: null, skipped: null, error }

  const rows = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const { data, error: rowErr } = await db
      .from('locations')
      .select('id, name, active')
      .in('id', chunk)
      .order('id')
    if (rowErr) {
      logError(module, 'locations by membership_source: rows unreadable', { key, err: rowErr })
      return { locations: null, eligible: null, skipped: null, error: rowErr }
    }
    for (const row of data || []) rows.push(row)
  }

  const locations = []
  for (const row of rows) {
    if (row.active !== true) continue
    const state = await membershipSourceState(db, row.id)
    locations.push({ id: row.id, name: row.name ?? null, ...state })
  }

  const eligible = locations.filter((l) => l.state === 'configured')
  const skipped = locations.filter((l) => l.state !== 'configured')
  for (const s of skipped) {
    if (s.state === 'unknown') {
      logError(module, 'membership source state unknown; location skipped this tick', {
        locationId: s.id, source: s.source, readError: s.readError ?? null,
      })
    } else if (s.state === 'none') {
      // Listed under `key`, then read back as 'none': the column changed mid-tick.
      logWarn(module, 'membership source changed mid-tick; location skipped this tick', {
        locationId: s.id, key,
      })
    } else {
      logWarn(module, 'membership source not configured; location skipped this tick', {
        locationId: s.id, source: s.source, state: s.state, missing: s.missing ?? [],
      })
    }
  }
  return { locations, eligible, skipped, error: null }
}

/**
 * The skip counts a cron puts in its response / heartbeat outcome.
 *
 * `skipped_source_changed` counts a location listed under the source but whose
 * per-location read then said 'none': its membership_source was changed
 * between the list and the state read (mid-tick). It is neither unconfigured
 * nor unreadable, so it is not folded into either.
 */
export function skippedSummary(skipped) {
  const out = { skipped_unconfigured: 0, skipped_unknown: 0, skipped_source_changed: 0 }
  for (const s of skipped || []) {
    if (s.state === 'unknown') out.skipped_unknown++
    else if (s.state === 'none') out.skipped_source_changed++
    else out.skipped_unconfigured++
  }
  return out
}

/**
 * The ids of every location with NO membership source, for the crons that walk
 * every active location and read Glofox-shaped columns: they skip these with a
 * counted `skipped_no_source`. A failed read is `{ ids: null, error }`: the
 * caller answers 500 and does not stamp.
 *
 * @returns {Promise<{ ids: Set<string>|null, error: any }>}
 */
export async function noSourceLocationIds(db) {
  const { ids, error } = await listLocationsByMembershipSource(db, 'none')
  if (error) return { ids: null, error }
  return { ids: new Set(ids), error: null }
}
