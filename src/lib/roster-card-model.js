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
// The briefing (BLOCKEDIT.1) is written for coaches; the model carries only
// that one exists.
//
// Web-only on purpose: anything under shared/ publishes an OTA.

import { liveAssignments } from './roster'
import { futureBlockStaffing, countStaffingGaps, staffingGapsHeadline, staffingGapsBreakdown } from './roster-staffing'
import { formatTime12h, formatTimeRange12h } from './schedule-overlap'
import { timeOffLeaveLabel } from '../../shared/time-off'
import { unavailableFor, unavailableSummary, describeRule } from '../../shared/availability'
import { isAdminShift, SHIFT_KIND_LABELS } from '../../shared/shift-kind'
import { briefingOf } from '../../shared/shift-briefing'

/**
 * The card's surface tone. The template's colour is no longer a fill, because
 * a pastel per template (nearly all blue, evenings pink-red) collided with the
 * amber/red that means "needs a coach".
 *
 *   'neutral'  a class shift (and anything whose kind cannot be read)
 *   'admin'    SHIFTTYPE.1 — an admin shift: a DIFFERENT neutral (slate), never
 *              amber or red, because an admin shift has no minimum and never
 *              needs a coach. ShiftCard maps the tone to a surface class and
 *              adds the "Admin" word, so colour is never the only signal.
 *
 * @returns {'neutral'|'admin'}
 */
export function cardTone(block) {
  return isAdminShift(block) ? 'admin' : 'neutral'
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
  // SHIFTTYPE.1 — an admin shift is labelled in words for everyone (not a
  // capacity fact), and never carries a staffing status: its caller passes
  // futureBlockStaffing's null for it.
  const isAdmin = isAdminShift(block)
  const kindLabel = isAdmin ? SHIFT_KIND_LABELS.admin : null
  // BLOCKEDIT.1 — whether the shift carries a coach briefing. The TEXT stays
  // out of the model: the card only says one exists; the dialog shows it.
  const hasBriefing = Boolean(briefingOf(block))
  const coaches = liveAssignments(assignments).map((a) => {
    const hasOverride = !!(a.start_time_override || a.end_time_override)
    const from = formatTime12h(a.start_time_override || block?.start_time)
    const to = formatTime12h(a.end_time_override || block?.end_time)
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
  if (coaches.length === 0 && !status) {
    // An admin shift has no status even in the future, so "(past)" would lie.
    emptyText = isAdmin ? 'Nobody assigned' : (isManager ? 'No coach (past)' : 'No coach assigned')
  }

  const timeLabel = formatTimeRange12h(block?.start_time, block?.end_time)
  // ONE tooltip for the whole card. The card's click target is a <button>
  // stretched over its text, so a `title` on the template label or on a name
  // is never under the pointer; the container's is. Built only from what the
  // model already holds, so it inherits the coach boundary.
  const hoverTitle = [
    templateName,
    kindLabel,
    hasBriefing ? 'Has a briefing' : null,
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
    kindLabel,
    hasBriefing,
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
// If the initial does not separate them either ("Sam Alpha" / "Sam Avery"),
// that pair gets full names: two identical labels on one line name nobody.
// Comparison ignores case; what is printed is what was stored.
function firstNames(rows) {
  const parts = rows.map((a) => String(a.profiles?.full_name || 'Unknown').trim().split(/\s+/))
  const lower = (x) => String(x || '').toLowerCase()
  const withInitial = (p) => (p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}` : p[0])
  return parts.map((p) => {
    const sameFirst = parts.filter((q) => lower(q[0]) === lower(p[0]))
    if (sameFirst.length < 2) return p[0]
    const label = withInitial(p)
    const collides = sameFirst.filter((q) => lower(withInitial(q)) === lower(label)).length > 1
    return collides ? p.join(' ') : label
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
        // SHIFTTYPE.1 — an admin shift has no minimum, so "No coach" would
        // read as a gap; say what the week card says.
        text = isAdminShift(blk) ? `${time} Nobody assigned` : `${time} No coach`
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

// How much a leave type says. When one person has two requests covering the
// same day, the bar shows the one that says most: a named kind of leave beats
// "Unavailable", which beats "Other", which beats a type this code never met.
const LEAVE_SPECIFICITY = { holiday: 3, sick: 3, unpaid: 3, unavailable: 2, other: 1 }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// '2026-09-21' → '21 Sep'. String slices only: no Date, so no timezone can move a day.
const dayMonth = (iso) => `${Number(String(iso).slice(8, 10))} ${MONTHS[Number(String(iso).slice(5, 7)) - 1] || ''}`.trim()

/**
 * The leave bars of ONE day in the week view: one per PERSON.
 *
 * Seen live once the cards went quiet: a person with two overlapping requests
 * had the same bar drawn twice on every day of the week (the month cell, which
 * shows one entry, never did). Per person the more specific type wins, then
 * the earlier start date, then the id (so the choice is stable between
 * renders). The text is "Firstname · Type", which fits a 99-116px column where
 * "Firstname Lastname — Type" never did; the title carries the full name, the
 * date range, and says when other requests were folded in.
 *
 * It does NOT decide who may see a bar: the caller filters first (a coach is
 * shown only their own leave) and this dedupes whatever it is handed. Pure.
 *
 * @param {Array} timeOff  time_off_requests rows: id, profile_id, type, start_date, end_date, profiles.full_name
 * @param {string} dateStr YYYY-MM-DD
 * @returns {Array<{id:string, profileId:string, type:string, text:string, title:string}>}
 */
export function dayLeaveBars(timeOff, dateStr) {
  const covering = (timeOff || []).filter((t) => t && t.start_date <= dateStr && t.end_date >= dateStr)
  const byPerson = new Map()
  for (const t of covering) {
    const key = t.profile_id || `row:${t.id}`
    const list = byPerson.get(key)
    if (list) list.push(t)
    else byPerson.set(key, [t])
  }
  const kept = [...byPerson.values()].map((list) => {
    const sorted = [...list].sort((a, b) =>
      (LEAVE_SPECIFICITY[b.type] || 0) - (LEAVE_SPECIFICITY[a.type] || 0)
      || String(a.start_date).localeCompare(String(b.start_date))
      || String(a.id).localeCompare(String(b.id)))
    return { row: sorted[0], folded: list.length - 1 }
  })
  const names = firstNames(kept.map((k) => k.row))
  return kept.map(({ row, folded }, i) => {
    const label = timeOffLeaveLabel(row.type)
    const range = row.start_date === row.end_date ? dayMonth(row.start_date) : `${dayMonth(row.start_date)} – ${dayMonth(row.end_date)}`
    const more = folded > 0 ? ` (+${folded} overlapping request${folded === 1 ? '' : 's'})` : ''
    return {
      id: row.id,
      profileId: row.profile_id,
      type: row.type,
      text: `${names[i]} · ${label}`,
      title: `${row.profiles?.full_name || 'Unknown'} — ${label}, ${range}${more}`,
    }
  })
}

/**
 * AVAIL.1 — the availability rules that speak for ONE day, per person:
 * Map<profile_id, rules[]>. The one place the "which rules apply on this day"
 * decision lives, so the Days view's bars (dayUnavailableBars) and the
 * Coaches grid (GRID.1, roster-grid-model.js) can never disagree about it.
 *
 * With `todayIso`, a WEEKLY rule is dropped on a day before today: it is what
 * the coach says now about every such weekday, and on a past week it would
 * claim an unavailability nobody declared then. Dated rules are about their
 * own dates, so they are kept on any day (the kept history rows). Whether a
 * kept rule actually covers `dateStr`, or a given time, is unavailableFor's
 * question (shared/availability.js). Pure.
 *
 * @param {Array} availability  flat rules from GET /api/schedule/availability?location_id=
 * @param {string} dateStr YYYY-MM-DD
 * @returns {Map<string, Array>}
 */
export function dayAvailabilityRules(availability, dateStr, { todayIso = null } = {}) {
  const pastDay = Boolean(todayIso) && dateStr < todayIso
  const byPerson = new Map()
  for (const rule of availability || []) {
    const id = rule?.profile_id
    if (!id) continue
    if (pastDay && rule.kind === 'weekly') continue
    if (!byPerson.has(id)) byPerson.set(id, [])
    byPerson.get(id).push(rule)
  }
  return byPerson
}

/**
 * AVAIL.1 — the unavailability bars of ONE day in the manager's week view:
 * one per person with any rule that day, "Firstname · Unavailable 9am–12pm".
 * The title has the full name, every rule and its note.
 *
 * Only people in `staff` (the studio's coaches, which the calendar already
 * holds) are drawn: a rule for anyone else has no name to show. People in
 * `skipProfileIds` are left out: the caller passes the day's leave bars, and
 * leave already says more than "unavailable". ADVISORY: nothing is blocked
 * by a bar. Pure.
 *
 * With `todayIso`, a WEEKLY rule is drawn only on today and later: it is
 * what the coach says now about every such weekday, and on a past week it
 * would claim an unavailability nobody declared then. Dated rules are about
 * their own dates, so they are drawn on any day (the kept history rows).
 *
 * @param {Array} availability  flat rules from GET /api/schedule/availability?location_id=
 * @param {string} dateStr YYYY-MM-DD
 * @param {Array<{id:string, full_name:string}>} staff
 * @returns {Array<{id:string, profileId:string, text:string, title:string}>}
 */
export function dayUnavailableBars(availability, dateStr, staff, { skipProfileIds = [], todayIso = null } = {}) {
  const skip = new Set(skipProfileIds)
  const nameById = new Map((staff || []).map((s) => [s.id, s.full_name]))
  const people = []
  for (const [profileId, rules] of dayAvailabilityRules(availability, dateStr, { todayIso })) {
    if (skip.has(profileId) || !nameById.has(profileId)) continue
    const hits = unavailableFor(rules, dateStr)
    if (hits) people.push({ profileId, fullName: nameById.get(profileId) || 'Unknown', hits })
  }
  people.sort((a, b) => a.fullName.localeCompare(b.fullName) || a.profileId.localeCompare(b.profileId))
  const names = firstNames(people.map((p) => ({ profiles: { full_name: p.fullName } })))
  return people.map((p, i) => ({
    id: `unavail-${p.profileId}-${dateStr}`,
    profileId: p.profileId,
    text: `${names[i]} · Unavailable ${unavailableSummary(p.hits)}`,
    title: `${p.fullName}: unavailable ${p.hits.map((r) => (r.note ? `${describeRule(r)} (${r.note})` : describeRule(r))).join('; ')}`,
  }))
}
