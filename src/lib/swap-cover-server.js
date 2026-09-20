// src/lib/swap-cover-server.js
//
// COVERLOOP.1 — the DB half of the cover loop. The decisions are in
// ./swap-cover.js (pure); this file does the reads, the sends and the one
// guarded write.
//
// Nothing here throws to its caller on a failed READ: notifyOpenPool runs
// after the swap is committed and the 201 is decided, and the sweep runs as an
// arm of a cron whose own job must not be starved.

import { resolveRoleRecipientIds } from './push'
import { notifyUsersOnce } from './push-dedup'
import { MANAGER_ROLES } from './schemas'
import { logWarn } from './log'
import { openPoolRecipients, shiftWhenLabel } from './swap-cover'

// profile_locations for one studio. The same table and embed
// resolveLocationMemberIds (src/lib/push.js) reads, but with the ERROR kept
// (that helper discards it) and the role columns, so the pure rule can judge
// membership, activity and manager-ness on the row itself.
const MEMBER_SELECT = 'profile_id, location_id, role, profiles!inner(id, role, active)'

// The shape evaluateSwapMoveConflicts reads (src/lib/swap-lifecycle.js), plus
// the block's studio (tenancy re-check) and its roster status (degraded mode).
const DAY_ASSIGNMENT_SELECT = 'id, profile_id, block_id, status, start_time_override, end_time_override, shift_blocks!inner(id, location_id, block_date, start_time, end_time, rosters:roster_id(status))'

/**
 * The studios in the same organisation as `locationId` (always including it).
 * A coach cannot be at two studios at once, but "any studio" stops at the
 * organisation's edge: another tenant's roster is never read. On any failure
 * the answer is this studio alone, with `error` set so the caller degrades.
 */
async function sameOrgLocationIds(db, locationId) {
  const { data: loc, error: locErr } = await db.from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr) return { ids: [locationId], error: locErr.message }
  if (!loc?.organization_id) return { ids: [locationId], error: null }

  const { data: studios, error: orgErr } = await db.from('locations')
    .select('id')
    .eq('organization_id', loc.organization_id)
  if (orgErr) return { ids: [locationId], error: orgErr.message }
  return { ids: [...new Set([locationId, ...(studios || []).map((s) => s.id)])], error: null }
}

/**
 * Tell every coach at the studio who could take this open swap.
 *
 * Recipients (decided by openPoolRecipients, pure): active members of THIS
 * studio (the SCHEDROLES.1 "belongs to the block's studio" rule), minus the
 * requester, minus managers (told by swap_open, resolved with the same helper
 * so the sets cannot drift), minus approved whole-day leave covering the date,
 * minus an overlapping live shift at any studio in the same organisation.
 * Bulk reads, never one pair per coach.
 *
 * FAILURE MODES. The broadcast still goes out where it safely can, but a
 * failed read may only make the audience SMALLER, never larger than the
 * pre-COVERLOOP rule reached (coaches with a live shift at this studio that
 * day on a published roster), and never makes a read wider:
 *   members unreadable        -> nobody
 *   shifts unreadable         -> nobody (the old rule named nobody either)
 *   leave unreadable          -> degraded: only coaches working here that day
 *   organisation unreadable   -> shifts read for THIS studio only, degraded
 * Every one of them is logged. `degraded: true` in the result says it happened.
 *
 * @param {object} db  service-role supabase client
 * @param {{ swapId: string, locationId: string,
 *           block: { id?: string, block_date: string, start_time?: string, end_time?: string },
 *           requester: { id: string, full_name?: string|null } }} args
 * @returns {Promise<{ notified: number, degraded: boolean }>}
 */
export async function notifyOpenPool(db, { swapId, locationId, block, requester }) {
  if (!swapId || !locationId || !block?.block_date) return { notified: 0, degraded: false }

  const [membersRes, managerIds] = await Promise.all([
    db.from('profile_locations').select(MEMBER_SELECT).eq('location_id', locationId),
    resolveRoleRecipientIds(db, locationId, MANAGER_ROLES),
  ])
  if (membersRes.error) {
    logWarn('swap-cover', 'open-pool members read failed; nobody was notified (managers still were)', { swapId, err: membersRes.error.message })
    return { notified: 0, degraded: true }
  }

  const rule = {
    locationId,
    members: membersRes.data || [],
    managerIds,
    requesterId: requester?.id,
    block,
  }
  // Everyone the rule could pick before leave and clashes are known. The bulk
  // reads below are scoped to exactly these people.
  const candidates = openPoolRecipients(rule)
  if (!candidates.length) return { notified: 0, degraded: false }

  let degraded = false
  const org = await sameOrgLocationIds(db, locationId)
  if (org.error) {
    degraded = true
    logWarn('swap-cover', 'open-pool organisation read failed; checking this studio only and notifying only coaches working here that day', { swapId, err: org.error })
  }

  const [leaveRes, assignRes] = await Promise.all([
    db.from('time_off_requests')
      .select('id, profile_id, type, start_date, end_date, total_days, status')
      .in('profile_id', candidates)
      .eq('status', 'approved')
      .lte('start_date', block.block_date)
      .gte('end_date', block.block_date),
    db.from('shift_assignments')
      .select(DAY_ASSIGNMENT_SELECT)
      .in('profile_id', candidates)
      .eq('shift_blocks.block_date', block.block_date)
      .in('shift_blocks.location_id', org.ids),
  ])
  if (assignRes.error) {
    logWarn('swap-cover', 'open-pool shifts read failed; nobody was notified (managers still were)', { swapId, err: assignRes.error.message })
    return { notified: 0, degraded: true }
  }
  if (leaveRes.error) {
    degraded = true
    logWarn('swap-cover', 'open-pool leave read failed; notifying only coaches working here that day', { swapId, err: leaveRes.error.message })
  }

  const ids = openPoolRecipients({
    ...rule,
    orgLocationIds: org.ids,
    timeOff: leaveRes.error ? [] : (leaveRes.data || []),
    assignments: assignRes.data || [],
    rosteredHereOnly: degraded,
  })
  if (!ids.length) return { notified: 0, degraded }

  const actor = requester?.full_name || 'A coach'
  const when = shiftWhenLabel(block)
  await notifyUsersOnce(db, `swap_open_pool:${swapId}`, ids, {
    title: 'A shift needs cover',
    body: `${actor} needs cover: ${when}. Tap to take it.`,
    category: 'swap',
    emailSubject: `A shift needs cover: ${when}`,
    data: { type: 'swap_open_pool', swap_id: swapId, block_date: block.block_date },
  })
  return { notified: ids.length, degraded }
}
