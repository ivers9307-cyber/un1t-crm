// SHELLY-UI.5 — the two things every /api/shelly DEVICE route needs before it
// can act: the tenant-scoped row, and the location's timezone.
//
// WHY THE LOADER LIVES HERE AND NOT IN A ROUTE. Five handlers reach a device
// by id (PATCH, DELETE, toggle, run-now, energy) and every one of them is an
// IDOR if it forgets `.eq('location_id', …)` — service-role clients bypass
// RLS, so the WHERE clause IS the tenant boundary. One loader means one place
// that can be wrong, and one place a test can pin.
//
// AND WHY IT ANSWERS 404 FOR BOTH A MALFORMED ID AND A FOREIGN ONE, with the
// SAME body: a 400 for "that is not a uuid" and a 404 for "not yours" is an
// oracle — the pair tells a caller which of the ids they are guessing are
// real. Detail routes 404 so ids cannot be enumerated (CLAUDE.md), and that
// property only holds if the two answers are indistinguishable, which
// route.test.js asserts by deep-equalling the two bodies.
//
// THE TIMEZONE SEAM. `loadConnectionWithKey` selects shelly_connections
// alone — no `locations` embed — while reconcile.js's engine reads the zone
// from `conn.locations.timezone` (locationTz). Hand a bare connection to
// runNowForDevice or refreshLocationState and a New York studio silently
// resolves to Europe/Dublin: its overrides expire at the wrong midnight and
// its class windows open five hours early, with nothing in the logs. The
// route already holds the full `locations` row on the session
// (`user.activeLocation`, embedded by getCurrentUser), so withLocationTz
// grafts it on and the engine resolves the SAME zone the route used.

import { logWarn } from '@/lib/log'
import { uuidLike } from '@/lib/schemas'
import { resolveTz, isValidTz } from '@/lib/tz-time'

const MODULE = 'shelly-device'

// An ALLOWLIST, and the SAME one the list and adopt responses use (imported by
// src/app/api/shelly/devices/route.js) so the surface can never describe a
// device differently depending on which route answered. `adopted_by` is
// deliberately absent: it is a staff user id the UI never shows, and a column
// added to the table later must not start appearing in a response because
// nobody remembered to subtract it. (No secrets live on this table — the
// allowlist is about contract stability, not about the key.)
export const DEVICE_COLUMNS =
  'id, location_id, device_id, channel, name, model, gen, zone, enabled, schedule_mode, ' +
  'fixed_windows, class_rule, override, last_applied, last_state, last_seen_at, created_at, updated_at'

/**
 * One adopted device, scoped to the caller's location.
 *
 * @returns {{ok: true, device: object}
 *         | {ok: false, status: 404}
 *         | {ok: false, status: 500, error: string}}
 *          `status` is the HTTP answer, so a caller cannot accidentally turn a
 *          read failure into a 404 — "we could not look" is not "it is not
 *          yours", and answering the second would tell an operator their own
 *          device had been deleted.
 */
export async function loadDevice(db, locationId, id) {
  // Malformed id short-circuits BEFORE the query: a non-uuid reaches Postgres
  // as a failed cast (22P02) and would surface as a 500 carrying the id.
  if (!uuidLike.safeParse(id).success) return { ok: false, status: 404 }
  const { data, error } = await db
    .from('shelly_devices')
    .select(DEVICE_COLUMNS)
    .eq('id', id)
    // The tenant boundary. Not a read-back check — the filter itself, so a
    // foreign id can never be loaded and then compared.
    .eq('location_id', locationId)
    // 0 rows is the ordinary "not yours / not there" answer, not an error.
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!data) return { ok: false, status: 404 }
  return { ok: true, device: data }
}

/**
 * The zone this request must do its wall-clock maths in.
 *
 * resolveTz is pure and does NOT log (see its header), so emitting the warning
 * is the edge's job — same rule, and the same wording, as reconcile.js's
 * locationTz. Without it a typo'd zone silently runs a studio on Dublin time,
 * which is a support ticket nobody knows how to open.
 *
 * The test is VALIDITY, not "did the string change": 'europe/dublin' resolves
 * to 'Europe/Dublin', which differs textually and is not a rejection.
 */
export function requestTz(user) {
  const raw = user?.activeLocation?.timezone
  const tz = resolveTz(raw)
  if (typeof raw === 'string' && raw.trim() !== '' && !isValidTz(raw)) {
    logWarn(MODULE, 'unknown location timezone — falling back to Dublin', {
      locationId: user?.activeLocation?.id, timezone: raw, using: tz,
    })
  }
  return tz
}

/**
 * A connection the engine can resolve a timezone from.
 *
 * The returned object still carries `auth_key` — it is loadConnectionWithKey's
 * row with one field grafted on — so it is SERVER ONLY and must never be
 * spread into a response or a log line.
 *
 * `locations` is REPLACED, not merged: the session's active location is the
 * authority here (it is the location every route scoped its query by), and a
 * stale embed on the connection row must not win over it.
 */
export function withLocationTz(conn, user) {
  return { ...conn, locations: { timezone: user?.activeLocation?.timezone ?? null } }
}
