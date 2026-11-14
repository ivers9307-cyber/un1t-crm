// APPROVALSQ.4 — what a team-and-money card does when a person presses Approve
// or Decline on /approvals. Each entry calls the SAME route, with the same body,
// as the page that decides the item today; no route changes behaviour. The
// route's own error text is returned untouched so the card can show it.
//
// Result = { ok, error?, data?, status }. status 0 means no answer arrived.

const GENERIC_ERROR = 'Something went wrong. Please try again.'
const NETWORK_ERROR = 'Network error. Please try again.'

async function call(url, { method = 'POST', body, cache } = {}) {
  let res
  try {
    res = await fetch(url, {
      method,
      ...(cache ? { cache } : {}),
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
  } catch {
    return { ok: false, error: NETWORK_ERROR, status: 0 }
  }
  let json
  try {
    json = await res.json()
  } catch {
    return { ok: false, error: GENERIC_ERROR, status: res.status }
  }
  if (!res.ok || json?.success === false) {
    return { ok: false, error: json?.error || `Failed (HTTP ${res.status})`, data: json?.data, body: json, status: res.status }
  }
  // `body` is the whole answer: time-off approve puts `clashes` and a swap
  // conflict puts `code` + `conflicts` beside `data`, not inside it.
  return { ok: true, data: json?.data, body: json, status: res.status }
}

const orNull = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null)

export const TEAM_ACTIONS = {
  fte_expenses: {
    approveLabel: 'Approve',
    declineLabel: 'Decline',
    reasonLabel: 'Reason for declining',
    reasonRequired: true,
    approve: (item) => call(`/api/expenses/${item.id}/approve`),
    decline: (item, reason) => call(`/api/expenses/${item.id}/decline`, { body: { reason: orNull(reason) } }),
    approvedText: 'Approved. It goes to the accountant queue.',
    declinedText: 'Declined. They can submit a new claim.',
    pageLabel: 'Expenses',
  },
  host_events: {
    approveLabel: 'Approve',
    declineLabel: 'Decline',
    reasonLabel: 'Reason for declining (the host is told)',
    reasonRequired: true,
    approve: (item) => call(`/api/events/${item.id}/review`, { body: { action: 'approve' } }),
    decline: (item, reason) => call(`/api/events/${item.id}/review`, { body: { action: 'reject', reason: orNull(reason) } }),
    approvedText: 'Approved. The event is published and the host has been told.',
    declinedText: 'Declined. The host has been told.',
    pageLabel: 'Hosts',
  },
  time_off_cancellations: {
    approveLabel: 'Cancel their leave',
    declineLabel: 'Keep their leave',
    approveConfirm: 'Cancel this approved leave?',
    reasonLabel: 'Note to them (optional)',
    reasonRequired: false,
    approve: (item) => call(`/api/schedule/time-off/${item.id}/cancel-request`, { body: { decision: 'approve', note: null } }),
    decline: (item, reason) => call(`/api/schedule/time-off/${item.id}/cancel-request`, { body: { decision: 'reject', note: orNull(reason) } }),
    approvedText: 'Leave cancelled. Any holiday days go back to their allowance.',
    declinedText: 'Kept. Their leave stays approved.',
    pageLabel: 'Time Off',
  },
  contractor_invoices: {
    approveLabel: 'Approve',
    declineLabel: 'Decline',
    reasonLabel: 'Reason for the contractor',
    reasonRequired: true,
    approve: (item) => call(`/api/invoices/${item.id}/approve`),
    decline: (item, reason) => call(`/api/invoices/${item.id}/decline`, { body: { reason: orNull(reason) } }),
    approvedText: 'Approved. It goes to the accountant queue.',
    declinedText: 'Declined. The contractor has been told.',
    approvedTextWithWarnings: 'Approved.',
    declinedTextWithWarnings: 'Declined.',
    pageLabel: 'Invoices',
  },
  time_off: {
    approveLabel: 'Approve',
    declineLabel: 'Reject',
    reasonLabel: 'Note to them (optional)',
    reasonRequired: false,
    approve: (item) => call(`/api/schedule/time-off/${item.id}`, { method: 'PUT', body: { status: 'approved' } }),
    decline: (item, reason) => call(`/api/schedule/time-off/${item.id}`, { method: 'PUT', body: { status: 'rejected', review_note: orNull(reason) } }),
    approvedText: 'Approved.',
    declinedText: 'Rejected.',
    pageLabel: 'Time Off',
  },
  shift_swaps: {
    approveLabel: 'Approve',
    declineLabel: 'Reject',
    reasonLabel: 'Note to them (optional)',
    reasonRequired: false,
    approve: (item) => call(`/api/schedule/swaps/${item.id}`, { method: 'PUT', body: { status: 'approved' } }),
    decline: (item, reason) => call(`/api/schedule/swaps/${item.id}`, { method: 'PUT', body: { status: 'rejected', review_note: orNull(reason) } }),
    approvedText: 'Approved. The roster is updated.',
    declinedText: 'Rejected.',
    pageLabel: 'Swaps',
  },
}

// Follow-up helpers the three extra-step cards use.
export function loadInvoiceRosterCheck(id) {
  return call(`/api/invoices/${id}`, { method: 'GET', cache: 'no-store' })
}

export function unassignLeaveClashes(id, assignmentIds) {
  return call(`/api/schedule/time-off/${id}/unassign-clashes`, { body: { assignment_ids: assignmentIds } })
}

// The same approval, re-sent after the person has seen the conflicts.
export function approveSwapAnyway(item) {
  return call(`/api/schedule/swaps/${item.id}`, { method: 'PUT', body: { status: 'approved', confirm_conflicts: true } })
}

export const TEAM_LINK_ONLY_KEYS = ['invoices_queue', 'rosters', 'issues', 'hyrox_sessions']

export function isDecidableInPlace(providerKey) {
  return Object.prototype.hasOwnProperty.call(TEAM_ACTIONS, providerKey)
}
