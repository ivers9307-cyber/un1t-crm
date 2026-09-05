// MAIL-DEADLETTER.1 — the ONE visibility model for webhook_dead_letter rows,
// shared by the list, replay, resolve and bulk-resolve routes so the surface
// cannot half-fix itself again (the review found replay judged the row's
// location while list/resolve/bulk-resolve still trusted `user.role`, the
// caller's ACTIVE-studio role — so any owner read every org's payloads and
// could resolve any row by walking the bigserial id).
//
// The model: master sees every row. Anyone else sees a row only where they are
// OWNER at the row's location (hasRoleAtLocation). A row with no location_id is
// master-only — UNLESS it is an inbound email whose recipient address resolves
// to a mailbox TODAY, in which case visibility follows where the mail WOULD
// file (no_matching_mailbox rows are stamped NULL by design, DEADLETTER-LOC.1).
// Collection routes cannot afford a per-row resolver, so they bound the QUERY
// to the caller's owner locations instead, which excludes NULL rows outright —
// which is why MAIL-DEADLETTER.2 re-stamps orphan rows the moment a mailbox is
// created or reactivated (src/lib/webhook-dead-letter-restamp.js): the
// per-row resolver below still covers the window before that runs.
//
// This file lives beside the routes (the `_helpers.js` convention — see
// src/app/api/email/tickets/_helpers.js) and is registered in
// check-location-scoping's SCOPING_HELPERS: canReplayDeadLetter is a
// fetch-by-pk-then-judge-its-location guard, deadLetterOwnerLocationIds feeds
// an `.in('location_id', …)` bound.

import { hasRoleAtLocation } from '@/lib/auth'
import { bestEffortInboundLocation } from '@/app/api/webhooks/postmark-inbound/[token]/route'

/**
 * The location a dead-letter row belongs to, for the visibility check: the
 * stamped location_id, else — for inbound email — the location the payload's
 * recipient address resolves to TODAY (null when it still matches no active
 * mailbox, which is also the state in which nothing could replay it).
 */
export async function resolveDeadLetterLocation(db, row) {
  if (row.location_id) return row.location_id
  if (row.provider === 'postmark_inbound') {
    return bestEffortInboundLocation(db, row.payload)
  }
  return null
}

/**
 * Master sees every row. Anyone else must be OWNER at the row's location, and
 * a row with no resolvable location is invisible to them. hasRoleAtLocation
 * returns false for a null location BEFORE its own master check, so master is
 * short-circuited here.
 */
export function canReplayDeadLetter(user, locationId) {
  if (!user) return false
  if (user.profileRole === 'master') return true
  if (!locationId) return false
  return hasRoleAtLocation(user, locationId, ['owner'])
}

/**
 * The bound for the COLLECTION routes (list, bulk-resolve): `null` for master
 * (no bound — every row), else the locations where the caller is OWNER, judged
 * per location by hasRoleAtLocation — never `user.role`. An empty array means
 * "nothing is visible": callers must short-circuit rather than issue
 * `.in('location_id', [])`.
 */
export function deadLetterOwnerLocationIds(user) {
  if (!user) return []
  if (user.profileRole === 'master') return null
  return Object.keys(user.rolesByLocation || {})
    .filter((locationId) => hasRoleAtLocation(user, locationId, ['owner']))
}
