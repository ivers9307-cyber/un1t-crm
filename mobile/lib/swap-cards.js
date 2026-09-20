// mobile/lib/swap-cards.js
//
// COVERLOOP.2 — what the phone's swap surfaces SAY and DECIDE: the when-line on
// a swap card, the confirm step's wording, the reason that is POSTed, and
// whether a shift carries the "Swap pending" chip. Pure — no React Native — so
// it is vitest-testable (there is no RN component test runner). Callers:
// components/dashboard/PersonalDashboard.jsx, components/dashboard/
// StudioDashboard.jsx, components/schedule/SwapConfirmSheet.jsx and
// app/(staff)/(tabs)/schedule.jsx.

import { effectiveShiftStart, effectiveShiftEnd } from 'shared/roster-month'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const OPEN_SWAP_STATUSES = ['pending', 'awaiting_approval']

export const SWAP_PENDING_LABEL = 'Swap pending'
export const SWAP_PICKER_TITLE = 'Ask a coach to cover'
export const SWAP_PICKER_EMPTY = 'No other coaches at this studio to ask.'
export const SWAP_ALREADY_OPEN_MESSAGE = 'A swap request is already open for this shift. You can cancel it under My requests on the Dashboard tab.'
// SwapCreateSchema (src/app/api/schedule/swaps/route.js): reason max 2000.
export const SWAP_REASON_MAX = 2000

/**
 * 'YYYY-MM-DD' -> 'Thu 24 Sep'. shift_date is a Dublin wall-clock CALENDAR
 * date: the weekday comes from its parts in UTC, so neither the handset's
 * timezone nor Hermes's Intl support can move or break it. '' if malformed.
 */
export function swapDayLabel(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return ''
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[mo - 1]}`
}

const hhmm = (t) => String(t || '').slice(0, 5)

/**
 * The when-line of a swap card: 'Thu 24 Sep · 06:00-07:00'.
 *
 * The BLOCK's hours when the row carries them (block_start_time, since
 * COVERLOOP.2): a shift that changes hands loses the previous coach's paid-
 * window override, so the block's hours are what the taker works. An older API
 * response has no block_* keys; then the collapsed override / template applies,
 * which is what effectiveShiftStart resolves.
 */
export function swapShiftWhen(shift) {
  const day = swapDayLabel(shift?.shift_date)
  const start = hhmm(shift?.block_start_time || effectiveShiftStart(shift))
  const end = hhmm(shift?.block_end_time || effectiveShiftEnd(shift))
  const times = start && end ? `${start}-${end}` : ''
  return [day, times].filter(Boolean).join(' · ')
}

/**
 * The dashboard's posted-swap row (shared/dashboard-data.js: requester_shift.
 * shift_blocks { block_date, start_time, end_time, shift_templates }) as the
 * shift shape swapShiftWhen reads.
 */
export function postedSwapShift(swap) {
  const b = swap?.requester_shift?.shift_blocks || {}
  return {
    shift_date: b.block_date ?? null,
    block_start_time: b.start_time ?? null,
    block_end_time: b.end_time ?? null,
    shift_templates: b.shift_templates ?? null,
  }
}

/** The reason as it is POSTed: trimmed, capped, null when blank. */
export function swapReasonForPost(text) {
  if (typeof text !== 'string') return null
  const t = text.trim().slice(0, SWAP_REASON_MAX)
  return t || null
}

/**
 * The confirm step. `coach` set = a targeted request; null = an open post.
 * reasonHint is true to the API: a coach who is not party to a swap never sees
 * its reason (slimSwapForCoach), the named target and any reviewer do.
 */
export function swapConfirmCopy({ shift, coach }) {
  const name = shift?.shift_templates?.name || 'this shift'
  const when = swapShiftWhen(shift)
  const what = when ? `${name} on ${when}` : name
  if (coach) {
    return {
      title: SWAP_PICKER_TITLE,
      message: `Ask ${coach.full_name || 'this coach'} to take ${what}? They can accept or decline, then a manager approves it.`,
      reasonHint: 'Shown to the coach you ask and to your manager.',
      cta: 'Send request',
    }
  }
  return {
    title: 'Post for swap',
    message: `Post ${what} for another coach to take? Coaches who can cover it and your managers are told, and a manager approves whoever takes it.`,
    reasonHint: 'Shown to your manager only.',
    cta: 'Post shift',
  }
}

/** The alert after a successful POST. */
export function swapPostedCopy(coach) {
  if (coach) return { title: 'Request sent', message: `${coach.full_name || 'They'} ${coach.full_name ? 'has' : 'have'} been asked to take this shift.` }
  return { title: 'Posted', message: 'Coaches who can cover it and your managers have been notified.' }
}

/** Does this shift row carry an open swap? (open_swap_status: see below.) */
export function hasOpenSwap(shift) {
  return OPEN_SWAP_STATUSES.includes(shift?.open_swap_status)
}

/**
 * Dashboard shifts + my posted swaps -> the same open_swap_status field
 * GET /api/schedule/shifts puts on the Schedule tab's rows. A dashboard
 * shift's id IS the assignment id (shared/dashboard-data.js), which is what
 * a swap's requester_shift_id names.
 */
export function annotateOpenSwaps(shifts, postedSwaps) {
  const byShift = new Map()
  for (const s of Array.isArray(postedSwaps) ? postedSwaps : []) {
    if (s?.requester_shift_id && OPEN_SWAP_STATUSES.includes(s.status)) byShift.set(s.requester_shift_id, s.status)
  }
  return (Array.isArray(shifts) ? shifts : []).map((sh) => ({ ...sh, open_swap_status: byShift.get(sh.id) ?? null }))
}
