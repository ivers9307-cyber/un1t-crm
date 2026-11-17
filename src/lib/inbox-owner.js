// INBOXASSIGN.1 — client-safe helpers for thread ownership (no server
// imports: the inbox list and the mail list both use these in the browser).
// The write side lives in src/lib/inbox-assignment.js.

export const OWNER_FILTERS = Object.freeze([
  { id: 'any', label: 'Anyone' },
  { id: 'mine', label: 'Mine' },
  { id: 'unassigned', label: 'Unassigned' },
])

/** Does a loaded row pass the owner filter? 'any' (or unknown) passes everything. */
export function matchesOwnerFilter(row, filter, userId) {
  if (filter === 'mine') return !!userId && row?.assigned_to === userId
  if (filter === 'unassigned') return !row?.assigned_to
  return true
}

/**
 * The compact owner text for a list row: 'You', the owner's first name, or
 * 'Assigned' when the name did not resolve. null for an unowned row.
 */
export function ownerShortLabel(row, userId) {
  if (!row?.assigned_to) return null
  if (userId && row.assigned_to === userId) return 'You'
  const first = String(row.assignee_name || '').trim().split(/\s+/)[0]
  return first || 'Assigned'
}

/** The thread header's sentence. */
export function ownerSentence({ assignedTo, assigneeName, viewerId }) {
  if (!assignedTo) return 'Unassigned'
  if (viewerId && assignedTo === viewerId) return 'Assigned to you'
  return assigneeName ? `Assigned to ${assigneeName}` : 'Assigned'
}

const ENDPOINTS = Object.freeze({
  whatsapp: (id) => `/api/whatsapp/conversations/${encodeURIComponent(id)}/assign`,
  instagram: (id) => `/api/instagram/conversations/${encodeURIComponent(id)}/assign`,
  mail: (id) => `/api/email/mail/${encodeURIComponent(id)}/assign`,
})

/** The assign route for a channel's thread, or null for an unknown channel. */
export function assignEndpoint(channel, id) {
  const build = ENDPOINTS[channel]
  return build && id ? build(id) : null
}
