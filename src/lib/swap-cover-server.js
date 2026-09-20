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
import { notifyUsersOnce, notifyUsersAtRolesOnce } from './push-dedup'
import { MANAGER_ROLES } from './schemas'
import { logWarn, logError } from './log'
import { isValidTz } from './tz-time'
import {
  openPoolRecipients, shiftWhenLabel,
  coverSweepAction, coverNudgePayload, swapExpiryNotices, swapExpiryNote, deferredExpiryNoticeDue,
  SWAP_EXPIRY_NOTICE_NOTES, EXPIRY_NOTICE_MAX_AGE_MS, OPEN_SWAP_STATUSES,
} from './swap-cover'

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

// ─────────────────────────────────────────────────────────────────────────
// The sweep — called by /api/cron/checklist-sweep every 15 minutes.
// ─────────────────────────────────────────────────────────────────────────

// requester:profiles!requester_id is the same disambiguated embed GET
// /api/schedule/swaps uses (two FKs to profiles on this table). The requester
// shift carries its own start_time_override: "has it started" is judged on the
// EFFECTIVE start (swapShiftHasStarted), the same rule PUT /swaps/:id applies.
const SWEEP_SWAP_SELECT = `
  id, status, location_id, requester_id, target_id, requester_shift_id, created_at, updated_at,
  reviewed_by, review_note,
  requester:profiles!requester_id(full_name),
  requester_shift:shift_assignments!requester_shift_id(id, start_time_override, shift_blocks!block_id(id, block_date, start_time, end_time))
`
// Open swaps are single digits in production. The cap is a guard, not a page
// size: if it is ever hit, the oldest 200 are processed and the rest wait a tick.
const SWEEP_LIMIT = 200

const delivered = (r) => ((r?.sent || 0) + (r?.emailed || 0)) > 0

/**
 * locations.timezone for the studios the sweep is about to act on: the zone
 * the shift start AND the quiet-hours band are judged in. Never throws. A
 * studio whose timezone is empty or not an IANA name is Europe/Dublin (the
 * pure half resolves it) and is warned about ONCE per sweep, however many
 * swaps it has. An unreadable table is Europe/Dublin for everyone, logged.
 */
async function studioTimezones(db, locationIds) {
  const zones = new Map()
  if (!locationIds.length) return zones
  const { data, error } = await db.from('locations').select('id, timezone').in('id', locationIds)
  if (error) {
    logWarn('swap-cover', 'sweep could not read studio timezones; using Europe/Dublin', { err: error.message })
    return zones
  }
  for (const row of data || []) zones.set(row.id, row.timezone)
  for (const id of locationIds) {
    const tz = zones.get(id)
    if (!isValidTz(tz)) {
      logWarn('swap-cover', 'studio timezone is empty or invalid; using Europe/Dublin', { locationId: id, timezone: tz ?? null })
    }
  }
  return zones
}

/**
 * One pass, every 15 minutes. Never throws. Returns counts for the cron.
 *
 *   PASS 1, open swaps: nudge the studio's approvers at T-48h and T-12h; CLOSE
 *   a swap whose shift has started (or no longer exists).
 *   PASS 2, swaps the sweep closed in the last 24h: send the expiry notice that
 *   is still owed.
 *
 * QUIET HOURS gate MESSAGES, never STATE. A nudge due outside 07:00-22:00
 * studio time waits (`quiet`). A started shift's swap is closed on THIS tick
 * at any hour, because nothing else refuses a claim or approval on a shift
 * already being worked; its notice goes with it only in band, and otherwise is
 * left for pass 2 of the first in-band tick, with its ledger key UNCLAIMED.
 *
 * EXACTLY ONCE: both paths send through the same swap_expired* keys of
 * notifyUsersOnce (claim-before-send on push_event_sends), so pass 2 can offer
 * a notice every tick for 24h and only the first is delivered. That also makes
 * pass 2 the recovery for a crash between the UPDATE and the send, and for a
 * send that failed outright (the ledger releases the claim, the next tick
 * retries).
 *
 * @param {object} db  service-role supabase client
 * @param {{ nowMs?: number }} [opts]
 */
export async function runSwapCoverSweep(db, { nowMs = Date.now() } = {}) {
  const stats = { open: 0, nudged: 0, expired: 0, skipped: 0, quiet: 0, announced: 0, errors: 0 }

  const [openRes, closedRes] = await Promise.all([
    db.from('shift_swap_requests')
      .select(SWEEP_SWAP_SELECT)
      .in('status', [...OPEN_SWAP_STATUSES])
      .order('created_at', { ascending: true })
      .limit(SWEEP_LIMIT),
    // Bounded: only rows THIS sweep closed for a started shift (no reviewer,
    // one of the exact system notes), and only for 24h. updated_at is
    // trigger-maintained (mig 010, set_swap_requests_updated_at), so it is the
    // moment of the close. deferredExpiryNoticeDue re-checks every condition.
    db.from('shift_swap_requests')
      .select(SWEEP_SWAP_SELECT)
      .eq('status', 'cancelled')
      .is('reviewed_by', null)
      .in('review_note', [...SWAP_EXPIRY_NOTICE_NOTES])
      .gte('updated_at', new Date(nowMs - EXPIRY_NOTICE_MAX_AGE_MS).toISOString())
      .order('updated_at', { ascending: true })
      .limit(SWEEP_LIMIT),
  ])
  if (openRes.error) {
    logError('swap-cover', 'sweep could not read open swaps', { err: openRes.error.message })
    stats.errors++
  }
  if (closedRes.error) {
    logError('swap-cover', 'sweep could not read recently closed swaps; an owed expiry notice waits a tick', { err: closedRes.error.message })
    stats.errors++
  }
  const swaps = openRes.error ? [] : (openRes.data || [])
  const closed = closedRes.error ? [] : (closedRes.data || [])
  stats.open = swaps.length
  if (!swaps.length && !closed.length) return stats

  const zones = await studioTimezones(db, [...new Set([...swaps, ...closed].map((s) => s.location_id).filter(Boolean))])

  // PASS 1 — open swaps.
  for (const swap of swaps) {
    const decision = coverSweepAction(swap, nowMs, { tz: zones.get(swap.location_id) })
    if (decision.action === 'none') {
      if (decision.reason === 'quiet_hours') stats.quiet++
      continue
    }
    try {
      if (decision.action === 'nudge') {
        const { key, payload } = coverNudgePayload(swap, decision.stage)
        // The same recipients swap_open reached: MANAGER_ROLES at the swap's
        // own studio. At-most-once per (swap, status, stage) via the ledger.
        const result = await notifyUsersAtRolesOnce(db, key, swap.location_id, MANAGER_ROLES, payload)
        if (delivered(result)) stats.nudged++
        else stats.skipped++
        continue
      }
      if (await expireSwap(db, swap, decision.reason, decision.notify)) stats.expired++
      else stats.skipped++
    } catch (e) {
      logError('swap-cover', 'sweep failed on a swap; the next tick retries it', { swapId: swap.id, action: decision.action, err: e?.message })
      stats.errors++
    }
  }

  // PASS 2 — expiry notices still owed (closed in quiet hours, or lost to a
  // crash or a failed send). The list was read BEFORE pass 1, so a swap closed
  // and told on this tick is not offered twice in it.
  for (const swap of closed) {
    if (!deferredExpiryNoticeDue(swap, nowMs, { tz: zones.get(swap.location_id) })) continue
    try {
      if (await sendExpiryNotices(db, swap, 'started')) stats.announced++
    } catch (e) {
      logError('swap-cover', 'deferred expiry notice failed; the next tick retries it', { swapId: swap.id, err: e?.message })
      stats.errors++
    }
  }
  return stats
}

// Send a closed swap's notices through their at-most-once keys. True if
// anything was actually delivered on this call.
async function sendExpiryNotices(db, swap, reason) {
  let any = false
  for (const notice of swapExpiryNotices(swap, reason)) {
    if (delivered(await notifyUsersOnce(db, notice.key, notice.to, notice.payload))) any = true
  }
  return any
}

// Close one swap, at ANY hour. The UPDATE is guarded on the status we READ: if
// a manager's approve RPC (migs 612/615 lock the row and refuse swap_not_open)
// or a coach's claim landed in between, zero rows match, nothing is sent, and
// the next tick reads the new truth. A zero-row UPDATE is not an error in
// PostgREST, so the returned rows are the verdict. reviewed_by is left NULL
// and the note is one of the exact system notes: that pair is how pass 2 finds
// the row again. The notice comes AFTER the write, and only when `notify` (the
// studio is inside 07:00-22:00); otherwise notifyUsersOnce is NOT called, so
// its key stays unclaimed for pass 2.
async function expireSwap(db, swap, reason, notify) {
  const { data, error } = await db.from('shift_swap_requests')
    .update({ status: 'cancelled', review_note: swapExpiryNote(swap, reason) })
    .eq('id', swap.id)
    .eq('status', swap.status)
    .select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) return false

  if (notify) await sendExpiryNotices(db, swap, reason)
  return true
}
