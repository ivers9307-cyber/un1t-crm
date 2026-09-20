// src/lib/swap-cover.js
//
// COVERLOOP.1 — the PURE half of the cover loop: who is told a shift needs
// cover, how the shift is described, and what the 15-minute sweep does with an
// open swap. The DB half is src/lib/swap-cover-server.js. Same split as
// swap-lifecycle.js (pure) / swap-conflicts.js (DB).

import { evaluateSwapMoveConflicts } from './swap-lifecycle'
import { fmtTime } from './schedule-overlap'
import { isLiveAssignment } from './roster'
import { MANAGER_ROLES } from './schemas'
import { wallMsInTz, dayStrInTz, resolveTz } from './tz-time'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * 'YYYY-MM-DD' -> 'Thu 24 Sep'. block_date is a studio wall-clock CALENDAR
 * date, so the weekday is computed in UTC from its parts: no timezone can move
 * it. '' for anything malformed or impossible (2026-02-31).
 */
export function shiftDayLabel(blockDate) {
  const m = String(blockDate ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return ''
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[mo - 1]}`
}

/**
 * A shift_blocks row -> 'Thu 24 Sep, 06:00 to 07:00'. The BLOCK's times, not
 * the requester's override: a shift that changes hands loses its overrides
 * (SWAP_MOVE_CLEARS), so the block's window is the range the taker would
 * actually work.
 */
export function shiftWhenLabel(block) {
  const day = shiftDayLabel(block?.block_date)
  const start = fmtTime(block?.start_time)
  const end = fmtTime(block?.end_time)
  const times = start && end ? `${start} to ${end}` : ''
  if (day && times) return `${day}, ${times}`
  return day || times || 'an upcoming shift'
}

// A single-day request worth less than a day is a HALF day (total_days is
// NUMERIC(5,1), "supports half days", mig 011). Which half is not recorded, so
// the coach may well be free for the shift: they are told, and the claim
// warning / approval check still has the final word. Anything else approved
// and covering the date is a whole day off. PostgREST sends NUMERIC as a
// string, hence Number(). An unreadable total is treated as a whole day.
function isHalfDayLeave(t) {
  if (!t || t.start_date !== t.end_date) return false
  if (t.total_days == null || t.total_days === '') return false
  const days = Number(t.total_days)
  return Number.isFinite(days) && days < 1
}

// The rule resolveRoleRecipientIds (src/lib/push.js) applies, re-stated on the
// link row itself: a swallowed read failure inside that resolver returns [],
// and an empty manager list must not turn every manager into a pool recipient.
function isManagerLink(link) {
  return MANAGER_ROLES.includes(link?.role) || link?.profiles?.role === 'master'
}

/**
 * Who is told an open swap is up for grabs. Pure.
 *
 * Every ACTIVE member of THIS studio, minus: the requester; managers (they
 * were told by swap_open); anyone already on this block; anyone on approved
 * whole-day leave covering the date; anyone with a live shift overlapping the
 * block's times at any studio IN THE SAME ORGANISATION. Leave and overlap are
 * evaluateSwapMoveConflicts' decision, the one the claim warning and the
 * approval check use, so a coach is not invited to take a shift the approval
 * would then question.
 *
 * TENANCY: an assignment row is only ever USED if its block's studio is in
 * `orgLocationIds` (default: this studio alone). The server half never reads
 * another organisation's rows; this re-check is the belt to that brace.
 *
 * `rosteredHereOnly` is the DEGRADED mode the server half asks for when a read
 * it depends on failed: the audience is additionally limited to coaches with a
 * live shift at this studio that day on a published roster, which is exactly
 * who the pre-COVERLOOP rule reached. A failure can shrink the audience, never
 * widen it.
 *
 * @param {object} args
 * @param {string} args.locationId        the swap's studio
 * @param {string[]} [args.orgLocationIds] studios in the same organisation (incl. this one)
 * @param {object[]} args.members         profile_locations rows: { profile_id, location_id, role, profiles: { role, active } }
 * @param {string[]} args.managerIds      swap_open recipients (resolveRoleRecipientIds)
 * @param {string} args.requesterId
 * @param {{id?:string, block_date:string, start_time?:string, end_time?:string}} args.block
 * @param {object[]} [args.timeOff]       time_off_requests rows for the candidates
 * @param {object[]} [args.assignments]   that day's shift_assignments rows (shift_blocks embed)
 * @param {boolean} [args.rosteredHereOnly]
 * @returns {string[]} profile ids, in member order
 */
export function openPoolRecipients({
  locationId, orgLocationIds, members, managerIds, requesterId, block,
  timeOff = [], assignments = [], rosteredHereOnly = false,
}) {
  if (!locationId || !block?.block_date) return []
  const managers = new Set(managerIds || [])
  const sameOrg = new Set(orgLocationIds?.length ? orgLocationIds : [locationId])
  sameOrg.add(locationId)

  const usable = (assignments || []).filter((a) => a && sameOrg.has(a.shift_blocks?.location_id))
  const wholeDayLeave = (timeOff || []).filter((t) => t && !isHalfDayLeave(t))

  const onThisBlock = new Set(
    usable
      .filter((a) => isLiveAssignment(a) && block.id
        && (a.block_id === block.id || a.shift_blocks?.id === block.id))
      .map((a) => a.profile_id),
  )
  const rosteredHere = new Set(
    usable
      .filter((a) => isLiveAssignment(a)
        && a.shift_blocks?.location_id === locationId
        && a.shift_blocks?.block_date === block.block_date
        && a.shift_blocks?.rosters?.status === 'published')
      .map((a) => a.profile_id),
  )

  const out = []
  const seen = new Set()
  for (const link of members || []) {
    const id = link?.profile_id
    if (!id || link.location_id !== locationId) continue    // a member of THIS studio
    if (seen.has(id)) continue
    seen.add(id)
    if (link.profiles?.active !== true) continue            // not deactivated
    if (id === requesterId) continue
    if (managers.has(id) || isManagerLink(link)) continue
    if (onThisBlock.has(id)) continue
    if (rosteredHereOnly && !rosteredHere.has(id)) continue
    const move = { role: 'taker', coachId: id, block, leavingAssignmentId: null }
    if (evaluateSwapMoveConflicts(move, { timeOff: wholeDayLeave, assignments: usable }).length > 0) continue
    out.push(id)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// Quiet hours.
//
// A staff push that is NOT a direct response to the recipient's own action
// (here: the manager nudges and the expiry notice) may only be SENT while the
// studio's wall clock is inside this band. Outside it the sweep does nothing
// for that studio and a later tick tries again. The open-pool broadcast is a
// direct consequence of a coach posting a swap and is not subject to this.
// ─────────────────────────────────────────────────────────────────────────

export const STAFF_PUSH_HOURS = Object.freeze({ start: '07:00', end: '22:00' })

/**
 * Is `nowMs` inside 07:00 (inclusive) to 22:00 (exclusive) on the studio's
 * wall clock? `tz` is locations.timezone: nullable free text, so an empty or
 * invalid value is Europe/Dublin (resolveTz), never a throw. DST-exact: both
 * edges are resolved through wallMsInTz on the studio's own calendar day, so
 * the band is 07:00-22:00 local on the 23-hour and the 25-hour day alike. An
 * unreadable clock is OUTSIDE the band: when in doubt, send nothing.
 */
export function inStaffPushHours(nowMs, tz) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return false
  const zone = resolveTz(tz)
  const day = dayStrInTz(nowMs, zone)
  const opens = wallMsInTz(day, STAFF_PUSH_HOURS.start, zone)
  const closes = wallMsInTz(day, STAFF_PUSH_HOURS.end, zone)
  if (opens == null || closes == null) return false
  return nowMs >= opens && nowMs < closes
}

// ─────────────────────────────────────────────────────────────────────────
// The sweep (an arm of /api/cron/checklist-sweep, every 15 minutes).
// ─────────────────────────────────────────────────────────────────────────

const HOUR_MS = 3600 * 1000
export const OPEN_SWAP_STATUSES = Object.freeze(['pending', 'awaiting_approval'])

// Nearest first: the first stage whose range covers "now" wins. A stage is a
// RANGE ("inside the last 48h"), not a window around a moment, so a missed
// cron tick, or a night of quiet hours, fires late instead of never; the
// push_event_sends ledger makes each stage fire once.
export const COVER_NUDGE_STAGES = Object.freeze([
  Object.freeze({ key: 't12', hours: 12 }),
  Object.freeze({ key: 't48', hours: 48 }),
])

// shift_swap_requests.review_note for a swap the sweep closed. There is no
// reviewer (reviewed_by stays NULL): this text is how a reader tells a system
// close from a coach's own cancel.
export const SWAP_EXPIRY_NOTES = Object.freeze({
  started: 'Closed automatically: the shift started before this swap was taken and approved.',
  shift_removed: 'Closed automatically: the shift was removed from the roster.',
})

/** UTC ms the block starts, on the studio's wall clock. null if unreadable. */
export function swapBlockStartMs(block, tz) {
  return wallMsInTz(block?.block_date, fmtTime(block?.start_time), resolveTz(tz))
}

// What is due for this swap, ignoring the time of day.
function dueAction(swap, nowMs, tz) {
  if (!swap || !OPEN_SWAP_STATUSES.includes(swap.status)) return { action: 'none' }
  // mig 603: deleting the assignment NULLs requester_shift_id and the swap row
  // survives. An open swap about a shift that no longer exists can never be
  // finalised, so it closes. Judged on the COLUMN, never on a missing embed.
  if (swap.requester_shift_id == null) return { action: 'expire', reason: 'shift_removed' }
  const block = swap.requester_shift?.shift_blocks
  if (!block) return { action: 'none' }
  const startMs = swapBlockStartMs(block, tz)
  if (startMs == null) return { action: 'none' }
  if (nowMs >= startMs) return { action: 'expire', reason: 'started' }

  const createdMs = Date.parse(swap.created_at)
  for (const stage of COVER_NUDGE_STAGES) {
    const stageOpensMs = startMs - stage.hours * HOUR_MS
    if (nowMs < stageOpensMs) continue
    // Posted inside this stage's range: swap_open told the managers moments
    // ago, and the ranges nest, so no wider stage applies either.
    if (Number.isFinite(createdMs) && createdMs >= stageOpensMs) return { action: 'none' }
    return { action: 'nudge', stage: stage.key }
  }
  return { action: 'none' }
}

/**
 * What the sweep does with one open swap, right now. Pure.
 *
 * QUIET HOURS are decided HERE, not by the caller: anything that is due while
 * the studio's wall clock is outside 07:00-22:00 comes back as
 * { action: 'none', reason: 'quiet_hours' }. Nothing is sent and nothing is
 * written; because stages are ranges and expiry is "now >= start", the first
 * tick inside the band picks it up (a T-12h nudge due at 02:00 goes at 07:00,
 * a 06:00 shift's swap closes at 07:00). That includes a removed shift, which
 * sends nothing anyway: outside the band the arm does nothing for the studio.
 *
 * @param {object} swap  shift_swap_requests row with
 *   requester_shift: { id, shift_blocks: { id, block_date, start_time, end_time } } | null
 * @param {number} nowMs
 * @param {{ tz?: string|null }} [opts]  the studio's locations.timezone
 * @returns {{action:'none', reason?:'quiet_hours'} | {action:'nudge', stage:'t48'|'t12'} | {action:'expire', reason:'started'|'shift_removed'}}
 */
export function coverSweepAction(swap, nowMs, { tz } = {}) {
  const due = dueAction(swap, nowMs, tz)
  if (due.action === 'none') return due
  if (!inStaffPushHours(nowMs, tz)) return { action: 'none', reason: 'quiet_hours' }
  return due
}

const requesterName = (swap) => swap?.requester?.full_name || 'A coach'

/**
 * The manager re-push for one stage. data.type reuses swap_open /
 * swap_awaiting on purpose: every installed build already routes those to
 * /approvals?tab=team&focus=<id> (mobile/lib/notification-nav.js), so this
 * needs no OTA. The status is in the key: a swap that was nudged while
 * pending and is later claimed still gets its awaiting-approval nudge.
 */
export function coverNudgePayload(swap, stage) {
  const when = shiftWhenLabel(swap?.requester_shift?.shift_blocks)
  const name = requesterName(swap)
  const key = `swap_cover_nudge:${swap.id}:${swap.status}:${stage}`
  if (swap.status === 'awaiting_approval') {
    return {
      key,
      payload: {
        title: 'Swap still waiting for approval',
        body: `${when}: ${name}'s shift has been taken by a colleague and still needs your approval. Tap to approve.`,
        category: 'swap',
        emailSubject: `A shift swap still needs your approval: ${when}`,
        data: { type: 'swap_awaiting', swap_id: swap.id },
      },
    }
  }
  return {
    key,
    payload: {
      title: 'Shift still uncovered',
      body: `Still uncovered: ${when}. ${name} posted it and nobody has taken it yet. Tap to review.`,
      category: 'swap',
      emailSubject: `Still uncovered: ${when}`,
      data: { type: 'swap_open', swap_id: swap.id },
    },
  }
}

/**
 * Who is told a swap expired, and how. data.type is swap_decision (every
 * installed build routes it to the Schedule tab on block_date).
 * shift_removed tells nobody: the roster change notification already told the
 * coach their shift went, and there is no date left to describe.
 */
export function swapExpiryNotices(swap, reason) {
  if (reason !== 'started' || !swap?.id) return []
  const block = swap.requester_shift?.shift_blocks
  const when = shiftWhenLabel(block)
  const claimed = swap.status === 'awaiting_approval'
  const common = {
    title: 'Swap request expired',
    category: 'swap',
    emailSubject: 'Your swap request expired',
    data: { type: 'swap_decision', swap_id: swap.id, status: 'cancelled', block_date: block?.block_date ?? null },
  }
  const out = [{
    key: `swap_expired:${swap.id}`,
    to: [swap.requester_id],
    payload: {
      title: common.title,
      body: claimed
        ? `Your swap for ${when} was not approved before the shift started, so it has closed and the shift stayed with you.`
        : `Nobody took your shift on ${when} before it started, so the swap request has closed and the shift stayed with you.`,
      category: common.category,
      emailSubject: common.emailSubject,
      data: common.data,
    },
  }]
  if (claimed && swap.target_id) {
    out.push({
      key: `swap_expired_taker:${swap.id}`,
      to: [swap.target_id],
      payload: {
        title: common.title,
        body: `The swap you took for ${when} was not approved before the shift started, so it has closed. The shift stayed with ${requesterName(swap)}.`,
        category: common.category,
        emailSubject: common.emailSubject,
        data: common.data,
      },
    })
  }
  return out
}
