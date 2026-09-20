// src/lib/roster-card-model.js
// ROSTERLOOK.1 — what the roster DRAWS, decided outside the JSX.
//
// The week card, the day header, the month cell and the toolbar each used to
// decide inline what to show, so the only way to test a decision was to render
// 2,700 lines of calendar and look for text. jsdom cannot see layout (memory
// `jsdom-cannot-see-layout`), so the decisions live here as pure functions
// with table-driven tests, and the components only lay out what they are given.
//
// 🔴 THE COACH BOUNDARY IS IN THIS FILE, not only in the JSX. A coach's feed
// never carries max_coaches / min_coaches / notes, and these models never copy
// them: capacity is not read for ANYONE (the "1/15" chip is gone), and staffing
// status exists only when `isManager` is true. A component cannot leak what its
// model does not contain.
//
// Web-only on purpose: anything under shared/ publishes an OTA.

import { liveAssignments } from './roster'
import { formatTime12h, formatTimeRange12h } from './schedule-overlap'

/**
 * The card's surface tone. 'neutral' for every block today: the template's
 * colour is no longer a fill, because a pastel per template (nearly all blue,
 * evenings pink-red) collided with the amber/red that means "needs a coach".
 * Wave 2 returns 'admin' here for a non-class block; ShiftCard already maps a
 * tone to a surface class, so that is a change to THIS function and one line
 * of its TONE_SURFACE map, not to the card's markup.
 *
 * @returns {'neutral'}
 */
export function cardTone(_block) {
  // `_block` is Wave 2's input; the underscore is the repo's unused-arg escape.
  return 'neutral'
}

/**
 * Everything one week-view card says.
 *
 * @param {object} block        shift_blocks row (start_time, end_time, shift_templates.name)
 * @param {Array}  assignments  block.shift_assignments, cancelled rows included
 * @param {{status:'empty'|'short'|'ok',count:number,min:number}|null} staffing
 *        futureBlockStaffing(block, today); null for a past block
 * @param {{isManager?:boolean, viewerId?:string|null}} [opts]
 */
export function shiftCardModel(block, assignments, staffing, { isManager = false, viewerId = null } = {}) {
  const templateName = block?.shift_templates?.name || 'Shift'
  const coaches = liveAssignments(assignments).map((a) => {
    const hasOverride = !!(a.start_time_override || a.end_time_override)
    const from = formatTime12h(a.start_time_override || block.start_time)
    const to = formatTime12h(a.end_time_override || block.end_time)
    return {
      id: a.id,
      name: a.profiles?.full_name || 'Unknown',
      isMe: !!viewerId && a.profile_id === viewerId,
      adjusted: hasOverride
        ? {
            title: `Adjusted: ${from}–${to}${a.partial_reason ? ` · ${a.partial_reason}` : ''}`,
            srLabel: `Adjusted hours: ${from} to ${to}${a.partial_reason ? `. ${a.partial_reason}` : ''}`,
          }
        : null,
    }
  })

  // Staffing numbers ONLY when short, and only for a manager.
  let status = null
  if (isManager && staffing?.status === 'short') {
    status = {
      kind: 'short',
      label: `${staffing.count} of ${staffing.min}`,
      srPrefix: 'Below minimum: ',
      title: `Below minimum: ${staffing.count} of ${staffing.min} coaches`,
    }
  } else if (isManager && staffing?.status === 'empty') {
    status = { kind: 'empty', label: 'Needs coach', srPrefix: '', title: 'No coach is assigned to this shift' }
  }

  let emptyText = null
  if (coaches.length === 0 && !status) emptyText = isManager ? 'No coach (past)' : 'No coach assigned'

  return {
    tone: cardTone(block),
    timeLabel: formatTimeRange12h(block?.start_time, block?.end_time),
    // The card button's spoken name is built from this plus the day; it keeps
    // the ROSTER-FIX.6b-7 shape "9am Morning shift".
    shortLabel: `${formatTime12h(block?.start_time)} ${templateName} shift`,
    templateName,
    coaches,
    status,
    emptyText,
  }
}
