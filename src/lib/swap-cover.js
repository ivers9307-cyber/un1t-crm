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
