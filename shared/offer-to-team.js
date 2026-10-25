// shared/offer-to-team.js
//
// REPLACE.1b — "Offer to team": may a manager offer this shift, how many
// coaches it still needs, and what an offer reads as. Pure and dependency-
// light (shared/ is the phone seam: this file publishes an OTA). The web block
// dialog, the phone Manage card and POST /api/schedule/blocks/[id]/offer all
// ask offerRefusal, so the button a manager sees and the answer the route
// gives cannot disagree. claim_shift_offer (mig 641) re-derives
// offerTargetCount in SQL: keep the two in step
// (tests/migration-641-shift-offers.test.js pins the pair).
//
// A coach's card carries when, what and where only: never a count or a
// minimum (COACHSCOPE.1).

import { isAdminShift } from './shift-kind.js'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Live = not cancelled (a swap-drop tombstone), same rule as liveAssignments.
const liveCount = (block) => (Array.isArray(block?.shift_assignments) ? block.shift_assignments : [])
  .filter((a) => a && a.status !== 'cancelled').length

/**
 * How many live coaches the shift should have before nobody else is needed.
 * A class shift: its minimum, at least 1. An admin shift: 1. It has no
 * minimum (SHIFTTYPE.1), so it is offered only while empty.
 */
export function offerTargetCount(block) {
  if (isAdminShift(block)) return 1
  return Math.max(Number(block?.min_coaches) || 0, 1)
}

/** Does the shift still need a coach? Below its target and below max_coaches. */
export function offerStillNeeded(block) {
  const live = liveCount(block)
  const max = Number(block?.max_coaches)
  if (Number.isFinite(max) && max > 0 && live >= max) return false
  return live < offerTargetCount(block)
}

export const OFFER_REFUSALS = Object.freeze({
  not_published: 'Publish the roster first: coaches only see published shifts.',
  past: 'This shift is in the past.',
  started: 'This shift has already started.',
  already_offered: 'This shift is already offered to the team.',
  staffed: 'This shift already has the coaches it needs.',
  unknown: 'This shift could not be read.',
})

/**
 * null when the shift may be offered, else a key of OFFER_REFUSALS. `started`
 * is the caller's answer: the route asks swapShiftHasStarted on the studio's
 * clock; the buttons pass false and let the route have the last word.
 *
 * @param {object|null} block  shift_blocks row with rosters.status, shift_templates.kind, min/max, shift_assignments[]
 * @param {{ todayIso?: string, started?: boolean, hasOpenOffer?: boolean }} opts
 * @returns {null|'not_published'|'past'|'started'|'already_offered'|'staffed'|'unknown'}
 */
export function offerRefusal(block, { todayIso, started = false, hasOpenOffer = false } = {}) {
  if (!block || !block.block_date) return 'unknown'
  if (block.rosters?.status !== 'published') return 'not_published'
  if (todayIso && block.block_date < todayIso) return 'past'
  if (started) return 'started'
  if (hasOpenOffer) return 'already_offered'
  if (!offerStillNeeded(block)) return 'staffed'
  return null
}

/**
 * The manager's one-line state of an open offer (GET ?view=manage row).
 * 'sent' reads "Offered to N coaches" (review 5): broadcast_count is how many
 * coaches it was OFFERED to, the recipients asked, not how many phones took
 * the push (an opted-out coach is still offered it, on Today).
 */
export function offerStateLabel(offer) {
  const base = 'Offered to the team'
  const n = Number(offer?.broadcast_count) || 0
  switch (offer?.notice_state) {
    case 'sent': return `Offered to ${n} ${n === 1 ? 'coach' : 'coaches'}`
    case 'nobody': return `${base} · nobody is free to ask`
    case 'sending': return `${base} · telling coaches now`
    case 'morning': return `${base} · coaches are told from 7am`
    case 'failed': return `${base} · the notification couldn't be sent`
    default: return base
  }
}

// 'Tue 29 Sep' from the ISO day's own parts: Date.UTC only, so no host
// timezone moves the day. '' for a day the calendar does not have.
function dayLabel(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return ''
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[mo - 1]}`
}
const hhmm = (t) => (/^\d{2}:\d{2}/.test(String(t ?? '')) ? String(t).slice(0, 5) : '')

/** A coach card's when-line: 'Tue 29 Sep · 06:00-07:00'. */
export function offerWhenLine(offer) {
  const day = dayLabel(offer?.block_date)
  const s = hhmm(offer?.start_time)
  const e = hhmm(offer?.end_time)
  const times = s && e ? `${s}-${e}` : ''
  return [day, times].filter(Boolean).join(' · ')
}

/** GET ?view=manage rows keyed by block_id. */
export function indexOffersByBlock(rows) {
  const out = {}
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.block_id) out[r.block_id] = r
  }
  return out
}

/** Words after POST /blocks/[id]/offer. status 0 = no answer. */
export function offerPostResultText(status, body) {
  if (status >= 200 && status < 300 && body?.success === true) {
    return body?.data?.notice === 'morning'
      ? { tone: 'warning', text: 'Offered to the team. Coaches see it on Today now and get a notification from 7am.' }
      : { tone: 'success', text: 'Offered to the team. Coaches who are free are being told now.' }
  }
  return { tone: 'error', text: body?.error || 'Could not offer the shift.' }
}

/** Words after POST /offers/[id]/claim. */
export function offerClaimResultText(status, body) {
  if (status >= 200 && status < 300 && body?.success === true) {
    return { tone: 'success', text: "It's yours. It is on your roster now." }
  }
  return { tone: 'error', text: body?.error || 'Could not claim the shift.' }
}
