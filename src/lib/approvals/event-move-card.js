// EVENT-MOVE.7 — how Mia's event_move request reads on the WEB approval
// surfaces: its label, its one-line summary, what a refused move means, and
// the decide card's done line. Every other kind falls through to the shared
// helpers (shared/approval-cards.js, shared/agent-request-failure.js).
//
// Why web-only: shared/** is a phone OTA publish path and the fleet lane is
// frozen, so this kind does not touch it. Until a later OTA moves this into
// shared/, the PHONE shows its generic card for event_move (the kind label
// falls back to "Agent request", the summary to "Agent request", and a failed
// move to the generic "Glofox rejected the action" line). The server-computed
// fields the phone reads from the /approvals provider (subtitle, failedWhy)
// already come from here, so those are right on the phone too.
//
// Pure and browser-safe: a client component (the decide card) imports it.

import { APPROVAL_KIND_LABELS, approvalCardSummary } from '@shared/approval-cards'
import { failureExplanation } from '@shared/agent-request-failure'

export const EVENT_MOVE_KIND = 'event_move'
export const EVENT_MOVE_LABEL = 'Event move'

// A DATE column (YYYY-MM-DD, Dublin wall-clock) as "Sun 25 Oct". Anchored on
// noon UTC so it never shifts a day in any timezone.
const DUBLIN_SHORT = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' })
function shortDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(String(iso))) return null
  const parts = {}
  for (const p of DUBLIN_SHORT.formatToParts(new Date(`${String(iso).slice(0, 10)}T12:00:00Z`))) parts[p.type] = p.value
  return `${parts.weekday} ${parts.day} ${parts.month}`
}

function money(cents, currency) {
  const major = Math.abs(Number(cents) || 0) / 100
  const body = Number.isInteger(major) ? String(major) : major.toFixed(2)
  const symbol = { EUR: '€', GBP: '£' }[currency || 'EUR']
  return symbol ? `${symbol}${body}` : `${currency} ${major.toFixed(2)}`
}

/**
 * "Move <entry> from <A, date> to <B, date time>" plus the price difference
 * (staff-facing: a difference to collect, or a cheaper date not refunded).
 */
export function eventMoveSummary(details) {
  const d = details || {}
  const from = [d.source_event_name, shortDate(d.source_event_date)].filter(Boolean).join(', ')
  const toWhen = [shortDate(d.target_event_date), d.target_wave_label].filter(Boolean).join(' ')
  const to = [d.target_event_name, toWhen].filter(Boolean).join(', ')
  let line = `Move ${d.entry_label || 'entry'}${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}`
  const gap = Number(d.price_gap_cents) || 0
  if (gap > 0) line += ` · ${money(gap, d.currency)} difference to collect`
  if (gap < 0) line += ` · ${money(gap, d.currency)} cheaper, not refunded`
  return line
}

/**
 * A refused move (details.result.move_error, written by the approvals route)
 * in the move's own words, never Glofox's. null when the result is not one.
 */
export function eventMoveFailureExplanation(result) {
  if (!result?.move_error) return null
  const said = typeof result.message === 'string' && result.message.trim()
    ? `: ${result.message.trim()}`
    : ` (${result.move_error}).`
  return `The move did not go through${said} Nothing was moved. Fix it, then retry, or move the entry by hand from the event's teams page.`
}

/** The decide card's line once a move went through (our events, not Glofox). */
export function eventMoveDoneLine({ hasThread, notified } = {}) {
  const tickets = notified ? ' The new tickets were emailed.' : ' The moved email did NOT go, so send them their tickets.'
  return `Done. The entry is moved${hasThread ? ' and the customer was told in-thread' : ''}.${tickets}`
}

// ── web helpers: event_move here, every other kind to the shared ones ──

/** The kind's label, or null when unknown (callers keep their own fallback). */
export function approvalKindLabel(kind) {
  if (kind === EVENT_MOVE_KIND) return EVENT_MOVE_LABEL
  return APPROVAL_KIND_LABELS[kind] || null
}

/** One-line summary of a request row. */
export function approvalSummary(row) {
  if (row?.kind === EVENT_MOVE_KIND) return eventMoveSummary(row.details)
  return approvalCardSummary(row)
}

/** Operator line for a failed execution, or null when the row is not one. */
export function explainFailure(row) {
  if (!row || row.status !== 'failed') return null
  return eventMoveFailureExplanation(row.details?.result) || failureExplanation(row)
}
