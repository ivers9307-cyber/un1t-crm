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
import { futureBlockStaffing, countStaffingGaps, staffingGapsHeadline, staffingGapsBreakdown } from './roster-staffing'
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

  const timeLabel = formatTimeRange12h(block?.start_time, block?.end_time)
  // ONE tooltip for the whole card. The card's click target is a <button>
  // stretched over its text, so a `title` on the template label or on a name
  // is never under the pointer; the container's is. Built only from what the
  // model already holds, so it inherits the coach boundary.
  const hoverTitle = [
    templateName,
    timeLabel,
    coaches.map((c) => (c.adjusted ? `${c.name} (${c.adjusted.title})` : c.name)).join(', '),
    status?.title,
  ].filter(Boolean).join(' · ')

  return {
    tone: cardTone(block),
    timeLabel,
    hoverTitle,
    // The card button's spoken name is built from this plus the day; it keeps
    // the ROSTER-FIX.6b-7 shape "9am Morning shift".
    shortLabel: `${formatTime12h(block?.start_time)} ${templateName} shift`,
    templateName,
    coaches,
    status,
    emptyText,
  }
}

const NO_STATUS = Object.freeze({ tone: 'none', label: '', labelWide: '', srLabel: '', title: '', empty: 0, short: 0 })

/**
 * The staffing status of ONE day, for the week view's day header and the
 * month view's cell. Replaces three things that each said it differently: the
 * Studio Overview tile ("UNDERMANNED 4/1"), and the month cell's "!1" / "↓1".
 *
 *   tone   'none'  no future shift on the day: say nothing
 *          'ok'    every future shift is at or above its minimum
 *          'short' at least one below its minimum, none empty   (amber)
 *          'empty' at least one with no coach                   (red)
 *   label  visible text, ONLY when not ok, and it says WHICH problem in
 *          words ("2 no coach", "1 short") so red vs amber is never the only
 *          difference. When both apply it is the more severe one, which
 *          always fits the narrowest header.
 *   labelWide  the same, plus the other problem when both apply
 *          ("1 no coach · 1 short"), for a header wide enough to hold it
 *   srLabel / title  the sentence, built from the same two functions the week
 *          banner uses, so the header and the banner cannot disagree
 *
 * Answers from futureBlockStaffing, like every other staffing surface
 * (ROSTERVIS.1), so cancelled assignments never count and past days are quiet.
 * Manager-only by CALLER: a coach's blocks carry no min_coaches, and the
 * calendar passes `status={null}` for a coach.
 */
export function dayHeaderStatus(blocksForDay, { todayIso } = {}) {
  const future = (blocksForDay || []).filter((blk) => futureBlockStaffing(blk, todayIso))
  if (future.length === 0) return NO_STATUS
  const gaps = countStaffingGaps(future, { todayIso })
  if (gaps.total === 0) {
    // "Shifts at minimum", never "Fully staffed": the dialog this opens also
    // weighs EVENT demand against supply minus leave, and can say UNDERMANNED
    // on a day whose shifts are all at minimum. Claim only what was measured.
    return { tone: 'ok', label: '', labelWide: '', srLabel: 'Shifts at minimum', title: 'Every shift has its minimum number of coaches', empty: 0, short: 0 }
  }
  const sentence = `${staffingGapsHeadline(gaps, '')}: ${staffingGapsBreakdown(gaps)}`
  const parts = [
    gaps.empty > 0 ? `${gaps.empty} no coach` : '',
    gaps.short > 0 ? `${gaps.short} short` : '',
  ].filter(Boolean)
  return {
    tone: gaps.empty > 0 ? 'empty' : 'short',
    label: parts[0],
    labelWide: parts.join(' · '),
    srLabel: sentence,
    title: sentence,
    empty: gaps.empty,
    short: gaps.short,
  }
}

// First names for a line with ~120px to spend. Two people sharing a first name
// ON THE SAME SHIFT get a last initial; across shifts the time disambiguates.
function firstNames(assignments) {
  const parts = assignments.map((a) => String(a.profiles?.full_name || 'Unknown').trim().split(/\s+/))
  return parts.map((p) => {
    const shared = parts.filter((q) => q[0] === p[0]).length > 1
    return shared && p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}` : p[0]
  })
}

/**
 * The lines of one month-view cell: "5:45 Alex, Blake".
 *
 * Replaces "5:45am 2/10": a time and a capacity ratio, three times over, with
 * nobody named. Capacity is not read for anyone now. Staffing numbers appear
 * ONLY on a short line ("(1 of 2)"), and only for a manager.
 *
 *   tone  'ok'     staffed (or: the viewer is a coach)
 *         'short'  manager, below minimum       amber
 *         'empty'  manager, future, no coach    red, "Needs coach"
 *         'quiet'  nobody on it and nothing to act on (past, or a coach's view)
 *
 * @param {Array} blocks  the day's VISIBLE blocks (the caller applies My shifts)
 * @returns {{ lines: Array<{id:string,tone:string,text:string,title:string}>, more: number }}
 */
export function monthCellLines(blocks, { todayIso, isManager = false, limit = 3 } = {}) {
  const sorted = [...(blocks || [])].sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')))
  const lines = sorted.slice(0, limit).map((blk) => {
    const live = liveAssignments(blk.shift_assignments)
    const staffing = isManager ? futureBlockStaffing(blk, todayIso) : null
    const time = formatTime12h(blk.start_time, { amSuffix: false })
    const names = firstNames(live)

    let tone = 'ok'
    let text
    let statusWords = ''
    if (names.length === 0) {
      if (staffing?.status === 'empty') {
        tone = 'empty'
        text = `${time} Needs coach`
        statusWords = 'No coach is assigned to this shift'
      } else {
        tone = 'quiet'
        text = `${time} No coach`
      }
    } else if (staffing?.status === 'short') {
      tone = 'short'
      text = `${time} ${names.join(', ')} (${staffing.count} of ${staffing.min})`
      statusWords = `Below minimum: ${staffing.count} of ${staffing.min} coaches`
    } else {
      text = `${time} ${names.join(', ')}`
    }

    const title = [
      blk.shift_templates?.name || 'Shift',
      formatTimeRange12h(blk.start_time, blk.end_time),
      live.map((a) => a.profiles?.full_name || 'Unknown').join(', '),
      statusWords,
    ].filter(Boolean).join(' · ')

    return { id: blk.id, tone, text, title }
  })
  return { lines, more: Math.max(0, sorted.length - limit) }
}

/**
 * What the one toolbar row shows, and what the More menu holds.
 *
 * The gating is the gating ScheduleCalendar has always had, written down once:
 *   everyone   Time off, My shifts | All staff, Week | Month
 *   manager    Select multiple, Copy last week, Copy last month, Manage templates
 *   manager + week view   Publish
 * Icons are attached by RosterToolbar (by key); this stays a pure data shape.
 * `checked` present = a menuitemcheckbox. `href` present = a link, not a button.
 */
export function rosterToolbarModel({ isManager = false, viewType = 'week', selectMode = false, selectedCount = 0, copying = false } = {}) {
  if (!isManager) {
    return { timeOffInline: true, moreItems: [], moreLabel: 'More', moreActive: false, showPublish: false }
  }
  return {
    timeOffInline: false,
    // The mode is in the WORDS. The old row had a button of its own reading
    // "Selecting (3)"; an amber "More" that still says "More" hides it.
    moreLabel: copying
      ? 'More · copying…'
      : selectMode
        ? `More · selecting${selectedCount > 0 ? ` (${selectedCount})` : ''}`
        : 'More',
    moreActive: selectMode,
    showPublish: viewType === 'week',
    moreItems: [
      { key: 'time-off', label: 'Time off', href: '/schedule/time-off' },
      {
        key: 'select',
        label: selectMode ? `Exit multi-select (${selectedCount})` : 'Select multiple',
        checked: selectMode,
        title: selectMode ? 'Exit multi-select' : 'Select multiple shifts to assign a coach in bulk',
      },
      { key: 'copy-week', label: 'Copy last week', disabled: copying, title: "Duplicate last week's shifts into this week" },
      { key: 'copy-month', label: 'Copy last month', disabled: copying, title: "Duplicate last month's shifts into this month" },
      { key: 'templates', label: 'Manage templates', href: '/settings/shifts', title: 'Add, edit, or retire the shift templates that build this roster' },
    ],
  }
}
