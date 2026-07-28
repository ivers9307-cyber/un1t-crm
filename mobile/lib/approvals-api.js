// Mobile-side approvals API. The web /api/approvals/pending aggregator is
// already mobile-shaped (uniform ApprovalItem). Call it via api() so the
// Bearer + x-active-location (+ impersonation) headers are sent and each
// provider scopes to the active studio server-side.
import { api } from './api'

export function getPendingApprovals({ locationId }) {
  return api('/api/approvals/pending', { locationId })
}

// HOST-APPROVALS.1 — approve/reject a host-submitted event from the hub.
// Same route as web /settings/hosts (CAS on pending_review; reject needs a
// reason and emails the host either way).
export function reviewHostEvent(eventId, action, reason = null) {
  return api(`/api/events/${eventId}/review`, {
    method: 'POST',
    body: { action, reason },
  })
}
