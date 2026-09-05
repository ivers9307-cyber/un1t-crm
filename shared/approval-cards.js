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
})

// One-line summary of the request payload per kind. Mirrors (and
// extends to all 7 kinds) the subtitle logic the /approvals provider
// uses — kept separate because mobile can't import src/lib.
export function approvalCardSummary(row) {
  const kind = row && row.kind
  const d = (row && row.details) || {}
  let parts = []
  if (kind === 'class_booking' || kind === 'class_cancellation') {
    parts = [d.class_name, d.class_time]
  } else if (kind === 'event_booking' || kind === 'event_cancellation') {
    parts = [d.event_name, d.event_date]
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
