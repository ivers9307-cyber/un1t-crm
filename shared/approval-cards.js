//
// Pure helpers for rendering agent approval requests as inline thread
// cards in the unified inbox (web Wave 1, mobile Wave 2). Pure — no DB,
// no network, no platform imports.

export const APPROVAL_KIND_LABELS = Object.freeze({
  pause: 'Pause membership',
  cancellation: 'Cancel membership',
  class_booking: 'Class booking',
  class_cancellation: 'Class cancellation',
  consultation: 'Consultation',
  event_booking: 'Event booking',
  event_cancellation: 'Event cancellation',
  membership_purchase: 'Membership purchase',
  event_move: 'Event move',
})

// EVENT-MOVE.7 — a DATE column (YYYY-MM-DD, Dublin wall-clock) as "Sun 25 Oct".
// Anchored on noon UTC so it never shifts a day in any timezone.
function shortDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(String(iso))) return null
  try {
    const parts = {}
    const fmt = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' })
    for (const p of fmt.formatToParts(new Date(`${String(iso).slice(0, 10)}T12:00:00Z`))) parts[p.type] = p.value
    return `${parts.weekday} ${parts.day} ${parts.month}`
  } catch {
    return String(iso).slice(0, 10)
  }
}

function money(cents, currency) {
  const major = Math.abs(Number(cents) || 0) / 100
  const body = Number.isInteger(major) ? String(major) : major.toFixed(2)
  const symbol = { EUR: '€', GBP: '£' }[currency || 'EUR']
  return symbol ? `${symbol}${body}` : `${currency} ${major.toFixed(2)}`
}

// "Move <entry> from <A, date> to <B, date time>" plus the price difference
// (staff-facing: a difference to collect, or a cheaper date not refunded).
function eventMoveSummary(d) {
  const from = [d.source_event_name, shortDate(d.source_event_date)].filter(Boolean).join(', ')
  const toWhen = [shortDate(d.target_event_date), d.target_wave_label].filter(Boolean).join(' ')
  const to = [d.target_event_name, toWhen].filter(Boolean).join(', ')
  let line = `Move ${d.entry_label || 'entry'}${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}`
  const gap = Number(d.price_gap_cents) || 0
  if (gap > 0) line += ` · ${money(gap, d.currency)} difference to collect`
  if (gap < 0) line += ` · ${money(gap, d.currency)} cheaper, not refunded`
  return line
}

// One-line summary of the request payload per kind. Mirrors (and
// extends to every kind) the subtitle logic the /approvals provider
// uses — kept separate because mobile can't import src/lib.
export function approvalCardSummary(row) {
  const kind = row && row.kind
  const d = (row && row.details) || {}
  let parts = []
  if (kind === 'class_booking' || kind === 'class_cancellation') {
    parts = [d.class_name, d.class_time]
  } else if (kind === 'event_booking' || kind === 'event_cancellation') {
    parts = [d.event_name, d.event_date]
  } else if (kind === 'event_move') {
    return eventMoveSummary(d)
  } else if (kind === 'consultation') {
    parts = [d.date, d.start_time]
  } else if (kind === 'pause') {
    const span = [d.start_date, d.end_date].filter(Boolean).join(' → ')
    parts = [span || null, d.reason]
  } else if (kind === 'cancellation') {
    // CANCEL-FORM.6 — form-originated rows carry a structured end date.
    parts = [d.reason, d.requested_end_date ? `ends ${d.requested_end_date}` : null]
  }
  const line = parts.filter(Boolean).join(' · ')
  if (line) return line
  return `${APPROVAL_KIND_LABELS[kind] || 'Agent'} request`
}

// Merge chat messages and approval requests into one ascending
// timeline. Messages sort before approvals at equal timestamps so a
// request renders under the customer message that triggered it.
// Items: { kind: 'message'|'approval', key, ts, message?|request? }
export function mergeTimeline(messages = [], requests = []) {
  const items = [
    ...messages.map(m => ({ kind: 'message', key: `m:${m.id}`, ts: m.sent_at || m.created_at || null, message: m })),
    ...requests.map(r => ({ kind: 'approval', key: `a:${r.id}`, ts: r.created_at || null, request: r })),
  ]
  return items.sort((a, b) => {
    const ta = a.ts ? new Date(a.ts).getTime() : 0
    const tb = b.ts ? new Date(b.ts).getTime() : 0
    if (ta !== tb) return ta - tb
    if (a.kind === b.kind) return 0
    return a.kind === 'message' ? -1 : 1
  })
}
