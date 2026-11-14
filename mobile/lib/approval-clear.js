// APPROVALSQ.2 — the phone's quiet clear. Pure helpers, no React/Supabase
// (there is no RN component runner; the logic lives here and is tested).
// A clear is PATCH { status: 'declined', silent: true }: the request closes
// and the customer is sent nothing.
import { BOOKING_KINDS } from 'shared/approvals-next-steps'

export const CLEARED_LABEL = 'Cleared, customer not told'
export const CLEAR_WARNING = 'Mia told this customer the team would confirm. Clearing sends them nothing.'

/** True when a request was closed by a quiet clear (not an ordinary decline). */
export function isCleared(request) {
  if (!request) return false
  return request.details?.cleared?.silent === true
    || request.customer_notified?.reason === 'cleared'
}

/**
 * Show the booking warning in the clear sheet: a waiting (not failed)
 * booking-shaped or consultation request, where Mia promised a confirmation.
 */
export function clearWarns(item) {
  if (!item || item.failed) return false
  return item.kind === 'consultation' || BOOKING_KINDS.has(item.kind)
}

/** The PATCH lost the race to a colleague (409 / "Already decided"). */
export function isAlreadyDecided(res) {
  if (!res) return false
  return res.status === 409 || /already decided/i.test(res.error || '')
}
