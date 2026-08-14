// ATTR-3 — attribution canary + weekly attribution metric. Pure decision
// logic only; the IO runner is src/lib/hr-attribution-sweep.js.
//
// WHY THIS EXISTS
// Measured 2026-08-14: in 30 days every one of the 27 bridge-created
// heart-rate sessions was contact-less (46,774 orphaned samples) while all
// 2,130 participation sessions carried zero samples — capture worked, but
// the strap→member link was never made, so no member ever received real HR
// data and nothing anywhere said so. The claim surfaces shipped the same day
// fix the funnel; this module is the alarm on the funnel: it notices when
// the attribution PROMISE breaks, and it reports the number that tells the
// business whether the funnel converts (attributed sessions per week — the
// metric the downstream-feature freeze is gated on).
//
// BASE-RATE DISCIPLINE (the `blind` grade lesson, 2026-08-12): only ~20% of
// classes have any strap, and registrations start from ~1. A canary that
// fired on "no attributed sessions today" would cry wolf daily and be
// ignored within a week. So the canary is conditional on a BROKEN PROMISE
// and nothing else: a REGISTERED strap was seen broadcasting during a class
// for real minutes, and attribution still didn't happen. An empty room, an
// unregistered strap, a quiet day — none of these can fire it.

/** A visit must carry at least this many samples to count (~1 min at 1Hz) —
 * a member walking past the studio door with a warm strap is not a class. */
export const MIN_VISIT_SAMPLES = 60

/** Slack around the visit window when matching sessions: a session opened
 * shortly before the strap was first detected (or closed shortly after it
 * went silent) still belongs to the visit. */
export const SESSION_MATCH_SLACK_MS = 30 * 60_000

/** The freeze gate: downstream HR features stay frozen until this many
 * attributed sessions land in each of two consecutive weeks. */
export const FREEZE_TARGET_PER_WEEK = 10

/**
 * Pure: find attribution breaks — registered straps that were worn during a
 * class today and did NOT end up attributed to their owner.
 *
 * A break means one of two distinct failures, and the reason says which:
 *   'no_session'   — auto-association never created/adopted ANY session for
 *                    the owner in the visit window. The mig 112 path or the
 *                    claim-flow adoption is broken.
 *   'anon_session' — a session exists for exactly this strap in the window
 *                    but with contact_id NULL: the router saw the strap and
 *                    still treated it as unregistered. Worse than no_session
 *                    (the registration was actively ignored), listed first.
 *
 * @param {object} opts
 * @param {Array<{device_key:string, location_id:string, started_at:string,
 *   last_sample_at:string, sample_count:number, class_name?:string|null,
 *   glofox_event_id?:string|null}>} opts.visits today's hr_detection_visits
 * @param {Array<{identifier:string, contact_id:string}>} opts.registrations
 *   ACTIVE contact_devices rows
 * @param {Array<{contact_id:string|null, device_identifier:string|null,
 *   started_at:string, ended_at:string|null, location_id:string}>} opts.sessions
 *   today's heart_rate_sessions (any source)
 * @param {number} [opts.minSamples]
 * @param {number} [opts.slackMs]
 * @returns {Array<{device_key:string, contact_id:string, location_id:string,
 *   class_name:string|null, visit_started_at:string, sample_count:number,
 *   reason:'anon_session'|'no_session'}>}
 */
export function findAttributionBreaks({
  visits = [],
  registrations = [],
  sessions = [],
  minSamples = MIN_VISIT_SAMPLES,
  slackMs = SESSION_MATCH_SLACK_MS,
} = {}) {
  const ownerByKey = new Map()
  for (const r of registrations || []) {
    if (r?.identifier && r?.contact_id) ownerByKey.set(r.identifier, r.contact_id)
  }
  if (ownerByKey.size === 0) return []

  const breaks = []
  for (const v of visits || []) {
    const owner = ownerByKey.get(v?.device_key)
    if (!owner) continue
    if ((v.sample_count ?? 0) < minSamples) continue
    // Only visits during a class: the detection recorder stamps the live
    // occurrence onto the visit. Outside class hours a registered strap
    // legitimately produces no session (that is HR-ROUTE's design), so an
    // unstamped visit can never be a broken promise.
    if (!v.class_name && !v.glofox_event_id) continue

    const visitStart = Date.parse(v.started_at) - slackMs
    const visitEnd = Date.parse(v.last_sample_at) + slackMs
    const overlaps = (s) => {
      const sStart = Date.parse(s.started_at)
      const sEnd = s.ended_at ? Date.parse(s.ended_at) : Number.POSITIVE_INFINITY
      return sStart <= visitEnd && sEnd >= visitStart
    }

    const owned = (sessions || []).some(
      (s) => s.contact_id === owner && s.location_id === v.location_id && overlaps(s),
    )
    if (owned) continue

    const anon = (sessions || []).some(
      (s) => s.contact_id == null && s.device_identifier === v.device_key
        && s.location_id === v.location_id && overlaps(s),
    )
    breaks.push({
      device_key: v.device_key,
      contact_id: owner,
      location_id: v.location_id,
      class_name: v.class_name || null,
      visit_started_at: v.started_at,
      sample_count: v.sample_count ?? 0,
      reason: anon ? 'anon_session' : 'no_session',
    })
  }
  // anon_session first — the router actively ignored a registration.
  breaks.sort((a, b) => (a.reason === b.reason ? 0 : a.reason === 'anon_session' ? -1 : 1))
  return breaks
}

/**
 * Pure: the weekly numbers, from pre-counted inputs. No IO, no message
 * prose — countsFor both weeks come from the sweep, this just decides what
 * they mean for the freeze.
 *
 * The freeze lifts on two CONSECUTIVE weeks at/above target, judged on the
 * two completed weeks in hand. Stateless on purpose: recomputing both weeks
 * from the DB every Sunday beats trusting a stored counter that a backfill
 * or deletion would silently invalidate.
 *
 * @param {object} opts
 * @param {{attributed:number, members:number, samples:number,
 *   anonSessions:number, newRegistrations:number, memberClaims:number,
 *   activeDevices:number}} opts.current   the week just ended
 * @param {{attributed:number}} opts.previous the week before it
 * @param {number} [opts.target]
 * @returns {{freezeLifted:boolean, weeksAtTarget:0|1|2, statusLine:string}}
 */
export function assessFreezeGate({ current, previous, target = FREEZE_TARGET_PER_WEEK } = {}) {
  const cur = current?.attributed ?? 0
  const prev = previous?.attributed ?? 0
  const weeksAtTarget = cur >= target ? (prev >= target ? 2 : 1) : 0
  const freezeLifted = weeksAtTarget === 2
  const statusLine = freezeLifted
    ? `Freeze LIFTED: ${prev} then ${cur} attributed sessions — two consecutive weeks at ${target}+.`
    : weeksAtTarget === 1
      ? `Freeze holds: ${cur} attributed this week (target ${target} met) — one more week at target lifts it.`
      : `Freeze holds: ${cur} attributed this week (target ${target}; last week ${prev}).`
  return { freezeLifted, weeksAtTarget, statusLine }
}
