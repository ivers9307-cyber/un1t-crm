// shared/candidates.js
//
// CANDIDATES.1 — ranked candidates wherever a coach is picked: the web assign
// picker, the phone's Manage "Add coach" sheet and the phone's "Ask a coach to
// cover" sheet. PURE: no IO, no clock, no host timezone. The server reads
// (src/lib/candidates-data.js); this module judges, ranks and words, so the
// web and the phone can never disagree.
//
// Per candidate (an active member of the block's studio, not live on it):
//   free              no live shift overlapping this one at ANY studio of the
//                     organisation (effective windows as real instants; ends
//                     that only touch are not an overlap)
//   busy              the earliest such overlapping shift, or null
//   on_leave          approved leave covering the day { label, start_date, end_date }
//   unavailable       an AVAIL.1 rule touching the shift { summary, detail }
//   on_site           the nearest other live shift at THIS studio that day
//                     { block_id, start, end, name, gap_minutes }
//   week_minutes      rostered minutes Mon–Sun of the block's week, every
//                     studio of the organisation, THIS shift excluded
//   contracted_hours  employees only, only when it could be read
//   rest_gap / week_over  WORKTIME.1's candidateWorkingTime, employees only
//
// Ranking (compareCandidates), the order in the Wave 2 index:
//   1. tier: ready → advisory (short rest, over 48h) → unavailable → blocked
//      (on leave, or already working then). NOTHING blocks: tiers sort and
//      badge, and the pickers keep every row tickable.
//   2. on site that day first
//   3. an employee still under their contracted hours first, lowest share of
//      the contract first; then everyone else, fewest hours this week first
//      (OWNER REVIEW: salaried hours are already paid for)
//   4. name, then id
// A facet the server could not read is null, never false: unknown is
// neutral, and the pickers say what was not checked.
//
// Hours only: nothing here reads or returns a rate, a cost or a salary.

import {
  workingWindow, candidateWorkingTime, isWorkingTimeCovered, untimedShiftCount,
  hoursMinutesLabel, MIN_REST_HOURS, MAX_WEEK_HOURS, REST_BETWEEN_LABEL,
} from './working-time.js'
import { unavailableFor, unavailableSummary, describeRule } from './availability.js'
import { timeOffLeaveLabel } from './time-off.js'

export const CANDIDATE_TIERS = Object.freeze(['ready', 'advisory', 'unavailable', 'blocked'])
const CANDIDATE_TONES = Object.freeze({ ready: 'good', advisory: 'warn', unavailable: 'muted', blocked: 'bad' })

// Free at this studio; the organisation's other studios could not be read.
const FREE_HERE = 'Free here'

export const CANDIDATES_RANKING_NOTE = 'Ranking coaches…'
export const CANDIDATES_UNRANKED_NOTE = 'Coaches could not be checked or ranked, so they are listed A–Z.'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME = /^(\d{1,2}):(\d{2})/

// ── Private helpers (src/lib exports its own date helpers; tests/shared-pair-
// sync.test.js makes a shared export NAME a pair someone must classify) ─────

// '20:00' → '8pm', '21:30' → '9:30pm': the same output as the web's
// formatTime12h, so a badge reads the same whichever side built it.
function time12(t) {
  const m = String(t ?? '').match(TIME)
  if (!m) return ''
  const h = Number(m[1]) % 24
  const suffix = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m[2] === '00' ? `${h12}${suffix}` : `${h12}:${m[2]}${suffix}`
}

// '2026-05-05' → 'Tue 5 May'. Date.UTC only: no host timezone moves a day.
function dayLabel(iso) {
  const m = String(iso ?? '').match(ISO_DAY)
  if (!m) return ''
  const wd = WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()]
  return `${wd} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`
}

// The Monday of the Mon–Sun week containing `iso` (WORKTIME.1's bucket).
function weekStartOf(iso) {
  const m = String(iso ?? '').match(ISO_DAY)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7
  return new Date(ms - sinceMonday * DAY_MS).toISOString().slice(0, 10)
}

function joinList(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// 0 → '0h' (for "0h of 30h"); otherwise WORKTIME's label.
const hoursOnly = (minutes) => (minutes === 0 ? '0h' : hoursMinutesLabel(minutes))

// ── Tiers and ranking ───────────────────────────────────────────────────────

/** 'ready' | 'advisory' | 'unavailable' | 'blocked'. Unknown facets are neutral. */
export function candidateTier(c) {
  if (!c) return 'ready'
  if (c.on_leave || c.free === false) return 'blocked'
  if (c.unavailable) return 'unavailable'
  if (c.rest_gap || c.week_over) return 'advisory'
  return 'ready'
}

/** 'good' | 'warn' | 'muted' | 'bad', from the tier. */
export function candidateTone(c) {
  return CANDIDATE_TONES[c?.tier ?? (c ? candidateTier(c) : null)] || 'muted'
}

const tierIndex = (c) => CANDIDATE_TIERS.indexOf(c?.tier ?? candidateTier(c))

// [group, value]: group 0 = an employee under their contract, by share of it;
// group 1 = everyone else, by minutes this week. Unknown hours sort last in
// group 1 and tie with each other, so they fall through to the name.
function loadKey(c) {
  const week = Number.isFinite(c?.week_minutes) ? c.week_minutes : null
  const contract = Number(c?.contracted_hours) > 0 ? Number(c.contracted_hours) * 60 : null
  if (contract !== null && week !== null && week < contract) return [0, week / contract]
  return [1, week === null ? Number.POSITIVE_INFINITY : week]
}

export function compareCandidates(a, b) {
  const byTier = tierIndex(a) - tierIndex(b)
  if (byTier) return byTier
  const bySite = (b?.on_site ? 1 : 0) - (a?.on_site ? 1 : 0)
  if (bySite) return bySite
  const [ga, va] = loadKey(a)
  const [gb, vb] = loadKey(b)
  if (ga !== gb) return ga - gb
  if (va !== vb) return va < vb ? -1 : 1
  const byName = String(a?.full_name ?? '').localeCompare(String(b?.full_name ?? ''), 'en', { sensitivity: 'base' })
  if (byName) return byName
  return String(a?.profile_id ?? '').localeCompare(String(b?.profile_id ?? ''))
}

/**
 * Copies of `list`, sorted, each with `tier`, `rank` (1-based) and `reason`.
 * Rank the PROJECTED facts: a colleague's list must be ranked on what a
 * colleague may see, or the order itself leaks the rest.
 */
export function rankCandidates(list, audience = 'manager', { crossStudioChecked = true } = {}) {
  return (list || [])
    .filter(Boolean)
    .map((c) => ({ ...c, tier: candidateTier(c) }))
    .sort(compareCandidates)
    .map((c, i) => ({ ...c, rank: i + 1, reason: candidateReason(c, audience, { crossStudioChecked }) }))
}

// ── Words ───────────────────────────────────────────────────────────────────

/**
 * The web picker's badges, worst first: [{ key, tone, text, title }]. Texts
 * and titles are the ones the picker already showed (ROSTER-FIX.6c clash and
 * leave, WORKTIME.1 rest and week, AVAIL.1b unavailable), so a manager sees
 * the same words from the ranked answer.
 */
export function candidateBadges(c) {
  if (!c) return []
  const out = []
  if (c.on_leave) {
    const { label, start_date: s, end_date: e } = c.on_leave
    out.push({ key: 'leave', tone: 'bad', text: 'on approved leave', title: `${label || 'Leave'}, ${dayLabel(s)}${e && e !== s ? ` to ${dayLabel(e)}` : ''}` })
  }
  if (c.busy) {
    const b = c.busy
    out.push({
      key: 'busy', tone: 'warn',
      text: `clashes with ${time12(b.start)} ${b.name || 'another shift'}`,
      // Main's clash title (ROSTER-FIX.6c), plus the studio when it is another one.
      title: `Already on ${b.name || 'another shift'}, ${time12(b.start)}–${time12(b.end)}${b.location_name ? ` at ${b.location_name}` : ''}`,
    })
  }
  if (c.unavailable) {
    out.push({ key: 'unavailable', tone: 'muted', text: `Unavailable: ${c.unavailable.summary}`, title: c.unavailable.detail || '' })
  }
  if (c.rest_gap) {
    const g = c.rest_gap
    const o = g.other || {}
    const where = o.location_name ? ` at ${o.location_name}` : ''
    out.push({
      key: 'rest', tone: 'warn',
      text: `${hoursMinutesLabel(g.rest_minutes)} rest`,
      title: `Only ${hoursMinutesLabel(g.rest_minutes)} between this shift and ${o.name || 'another shift'} ${time12(o.start)}–${time12(o.end)}${where} on ${dayLabel(o.date)}. Employees need ${MIN_REST_HOURS} hours ${REST_BETWEEN_LABEL}.`,
    })
  }
  if (c.week_over) {
    const hm = hoursMinutesLabel(c.week_over.minutes)
    out.push({
      key: 'week', tone: 'warn',
      text: `${hm} this week`,
      title: `Assigning this shift brings their week to ${hm} across every studio, over the ${MAX_WEEK_HOURS}-hour limit.`,
    })
  }
  return out
}

/** '12h of 39h this week' · '2h this week' · 'No shifts this week' · null (unknown). */
export function candidateHoursLine(c) {
  if (!Number.isFinite(c?.week_minutes)) return null
  if (Number(c.contracted_hours) > 0) return `${hoursOnly(c.week_minutes)} of ${Number(c.contracted_hours)}h this week`
  return c.week_minutes === 0 ? 'No shifts this week' : `${hoursMinutesLabel(c.week_minutes)} this week`
}

/**
 * The web row's second line: 'Here 7am–9am · 2h this week'. When the other
 * studios could not be read (`crossStudioChecked` false), a free row with
 * nothing worse to say leads 'Free here', so an unbadged row is not read as
 * free everywhere.
 */
export function candidateMeta(c, { crossStudioChecked = true } = {}) {
  if (!c) return null
  const parts = []
  if (c.on_site) parts.push(`Here ${time12(c.on_site.start)}–${time12(c.on_site.end)}`)
  else if (!crossStudioChecked && c.free === true && !c.on_leave && !c.unavailable) parts.push(FREE_HERE)
  const hours = candidateHoursLine(c)
  if (hours) parts.push(hours)
  return parts.length ? parts.join(' · ') : null
}

/**
 * The phone row's one line (and `reason` in the API). The worst thing first,
 * then the hours. A colleague (the coach asking for cover) is told free or
 * working, nothing else. `crossStudioChecked` false (the other studios could
 * not be read): "free" is only known HERE, and the words say so.
 */
export function candidateReason(c, audience = 'manager', { crossStudioChecked = true } = {}) {
  if (!c) return null
  if (audience === 'colleague') {
    if (c.free === true) return crossStudioChecked ? 'Free then' : `${FREE_HERE} then`
    if (c.free === false) return 'Working then'
    return null
  }
  let lead = null
  if (c.on_leave) lead = `On leave (${c.on_leave.label || 'Leave'})`
  else if (c.busy) lead = `Working ${time12(c.busy.start)}–${time12(c.busy.end)} ${c.busy.name || 'another shift'}${c.busy.location_name ? ` at ${c.busy.location_name}` : ''}`
  else if (c.unavailable) lead = `Unavailable ${c.unavailable.summary}`
  else if (c.rest_gap) lead = `Only ${hoursMinutesLabel(c.rest_gap.rest_minutes)} rest`
  else if (c.week_over) lead = `${hoursMinutesLabel(c.week_over.minutes)} with this shift`
  else if (c.on_site) lead = `Here ${time12(c.on_site.start)}–${time12(c.on_site.end)}`
  else if (c.free === true) lead = crossStudioChecked ? 'Free' : FREE_HERE
  const line = [lead, candidateHoursLine(c)].filter(Boolean).join(' · ')
  return line || null
}

const UNCHECKED_LABELS = [
  ['shifts', 'other shifts'],
  ['cross_studio', 'the other studios'],
  ['leave', 'leave'],
  ['availability', 'availability'],
  ['contract', 'contracted hours'],
]

/** 'Could not check leave and availability, so the order may be off.' or null. */
export function candidatesUncheckedNote(checked) {
  const missing = UNCHECKED_LABELS.filter(([key]) => checked?.[key] === false).map(([, label]) => label)
  return missing.length ? `Could not check ${joinList(missing)}, so the order may be off.` : null
}

/**
 * The client's reading of a GET /api/schedule/blocks/[id]/candidates body.
 *   { ok: true, audience, candidates (by rank), checked, untimed }
 *   { ok: false, reason: 'failed' }        no answer, or success !== true
 *   { ok: false, reason: 'unrecognised' }  a success of another shape (an
 *                                          older server): say nothing, fall back
 */
export function parseCandidatesAnswer(json) {
  if (!json || json.success !== true) return { ok: false, reason: 'failed' }
  const d = json.data
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.candidates)) return { ok: false, reason: 'unrecognised' }
  const rankOf = (c) => (Number.isFinite(c.rank) ? c.rank : Number.POSITIVE_INFINITY)
  const candidates = d.candidates
    .filter((c) => c && typeof c === 'object' && c.profile_id)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (rankOf(a.c) === rankOf(b.c) ? a.i - b.i : rankOf(a.c) < rankOf(b.c) ? -1 : 1))
    .map(({ c }) => c)
  return {
    ok: true,
    audience: d.audience === 'colleague' ? 'colleague' : 'manager',
    candidates,
    checked: d.checked && typeof d.checked === 'object' ? d.checked : {},
    untimed: Number(d.untimed) > 0 ? Number(d.untimed) : 0,
  }
}

// ── Facts ───────────────────────────────────────────────────────────────────

// A window as a slot a badge names. The studio is named only when it is
// ANOTHER one (the manager is assigning here).
function slotOf(w, hereLocationId) {
  return {
    block_id: w.block_id ?? null,
    date: w.date,
    start: w.start,
    end: w.end,
    name: w.name,
    location_name: hereLocationId && w.location_id === hereLocationId ? null : (w.location_name ?? null),
  }
}

/**
 * One person's facts about one shift. `target` is workingWindow() of the
 * shift (null when it has no usable times); `candidateRow` is the shift as
 * this person's row (for WORKTIME.1's rule); `own` is this person's live
 * assignments from the reader, any studio of the organisation. `checked`
 * false for a facet = the reader could not read it: that facet stays null.
 */
export function candidateFacts({
  target, candidateRow, own = [], leave = [], rules = [], contractedHours = null,
  covered = false, hereLocationId = null, checked = {},
} = {}) {
  const date = candidateRow?.block_date ?? target?.date ?? null
  const facts = {
    free: null, busy: null, on_site: null, week_minutes: null, rest_gap: null, week_over: null,
    on_leave: null, unavailable: null, contracted_hours: null,
  }

  if (checked.shifts !== false && target) {
    const seen = new Set()
    const windows = []
    for (const row of own) {
      const w = workingWindow(row)
      if (!w || w.block_id === target.block_id) continue
      const key = w.block_id ?? `${w.date}|${w.start}|${w.end}|${w.location_id}`
      if (seen.has(key)) continue
      seen.add(key)
      windows.push(w)
    }
    const overlaps = (w) => w.startMs < target.endMs && target.startMs < w.endMs
    const busy = windows.filter(overlaps).sort((a, b) => a.startMs - b.startMs)[0] || null
    facts.free = !busy
    facts.busy = busy ? slotOf(busy, hereLocationId) : null
    const near = windows
      .filter((w) => !overlaps(w) && hereLocationId && w.location_id === hereLocationId && w.date === target.date)
      .map((w) => ({ w, gap: Math.round((w.endMs <= target.startMs ? target.startMs - w.endMs : w.startMs - target.endMs) / MINUTE_MS) }))
      .sort((a, b) => a.gap - b.gap || a.w.startMs - b.w.startMs)[0]
    facts.on_site = near
      ? { block_id: near.w.block_id ?? null, start: near.w.start, end: near.w.end, name: near.w.name, gap_minutes: near.gap }
      : null
    const week = weekStartOf(target.date)
    facts.week_minutes = Math.round(windows
      .filter((w) => weekStartOf(w.date) === week)
      .reduce((sum, w) => sum + (w.endMs - w.startMs), 0) / MINUTE_MS)
    if (covered && candidateRow) {
      const wt = candidateWorkingTime(own, candidateRow, { hereLocationId })
      facts.rest_gap = wt.restGap
      facts.week_over = wt.weekHours
    }
  }

  if (checked.leave !== false && date) {
    const hit = (leave || [])
      .filter((l) => l?.start_date && l.end_date && l.start_date <= date && l.end_date >= date)
      .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))[0]
    facts.on_leave = hit
      // The label only: the raw type value never leaves the server (review 5).
      ? { label: timeOffLeaveLabel(hit.type), start_date: hit.start_date, end_date: hit.end_date }
      : null
  }

  if (checked.availability !== false && date) {
    const matches = unavailableFor(rules, date, target?.start ?? null, target?.end ?? null)
    facts.unavailable = matches
      ? {
        summary: unavailableSummary(matches),
        detail: matches.map((r) => (r.note ? `${describeRule(r)} (${r.note})` : describeRule(r))).join('; '),
      }
      : null
  }

  if (checked.contract !== false && covered && Number(contractedHours) > 0) facts.contracted_hours = Number(contractedHours)
  return facts
}

function groupByProfile(rows) {
  const out = new Map()
  for (const r of rows || []) {
    if (!r?.profile_id) continue
    if (!out.has(r.profile_id)) out.set(r.profile_id, [])
    out.get(r.profile_id).push(r)
  }
  return out
}

const valueOf = (mapOrObject, key) => {
  if (!mapOrObject) return null
  return (typeof mapOrObject.get === 'function' ? mapOrObject.get(key) : mapOrObject[key]) ?? null
}

/**
 * The ranked candidate list for one block.
 *
 * @param {{
 *   block: { id, location_id, block_date, start_time, end_time, shift_templates },
 *   members: Array<{ profile_id, full_name, role, employment_type }>,  eligible, not on the block
 *   shifts: object[],   readOrgShiftRows rows (every studio of the organisation)
 *   leave: Array<{ profile_id, type, start_date, end_date }>,  approved
 *   rules: Array<{ profile_id, ...AVAIL rule }>,
 *   contracts: Map|object  profile_id → contracted hours per week (employees)
 *   checked: { shifts, cross_studio, leave, availability, contract },
 *   audience: 'manager' | 'colleague',
 * }} args
 * @returns {{ candidates: object[], untimed: number }}
 *   manager:   every fact + tier, rank, reason
 *   colleague: { profile_id, full_name, role, free, tier, rank, reason } only
 */
export function buildCandidates({
  block, members = [], shifts = [], leave = [], rules = [], contracts = null, checked = {}, audience = 'manager',
} = {}) {
  if (!block?.id) return { candidates: [], untimed: 0 }
  const colleague = audience === 'colleague'
  const here = block.location_id ?? null
  const rowFor = (profileId) => ({
    profile_id: profileId,
    block_id: block.id,
    block_date: block.block_date,
    location_id: here,
    location_name: null,
    name: block.shift_templates?.name || 'Shift',
    status: 'scheduled',
    start_time: block.start_time ?? null,
    end_time: block.end_time ?? null,
    shift_templates: { start_time: block.shift_templates?.start_time ?? null, end_time: block.shift_templates?.end_time ?? null },
  })
  const target = workingWindow(rowFor('target'))
  const shiftsBy = groupByProfile(shifts)
  const leaveBy = groupByProfile(leave)
  const rulesBy = groupByProfile(rules)
  const people = (members || []).filter((m) => m?.profile_id)

  const facts = people.map((m) => {
    const f = candidateFacts({
      target,
      candidateRow: rowFor(m.profile_id),
      own: shiftsBy.get(m.profile_id) || [],
      leave: colleague ? [] : leaveBy.get(m.profile_id) || [],
      rules: colleague ? [] : rulesBy.get(m.profile_id) || [],
      contractedHours: colleague ? null : valueOf(contracts, m.profile_id),
      covered: !colleague && isWorkingTimeCovered(m.employment_type),
      hereLocationId: here,
      checked,
    })
    const base = { profile_id: m.profile_id, full_name: m.full_name ?? null, role: m.role ?? null }
    // Project BEFORE ranking: a colleague's order must not encode the rest.
    return colleague ? { ...base, free: f.free } : { ...base, ...f }
  })

  const ids = new Set(people.map((m) => m.profile_id))
  const untimed = colleague || people.length === 0
    ? 0
    : untimedShiftCount((shifts || []).filter((s) => ids.has(s?.profile_id))) + (target ? 0 : 1)
  return {
    candidates: rankCandidates(facts, colleague ? 'colleague' : 'manager', { crossStudioChecked: checked?.cross_studio !== false }),
    untimed,
  }
}
