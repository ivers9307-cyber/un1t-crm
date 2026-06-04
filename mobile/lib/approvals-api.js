// Mobile-side approvals API. The web /api/approvals/pending aggregator is
// already mobile-shaped (uniform ApprovalItem). Call it via api() so the
// Bearer + x-active-location (+ impersonation) headers are sent and each
// provider scopes to the active studio server-side.
import { api } from './api'

export function getPendingApprovals({ locationId }) {
  return api('/api/approvals/pending', { locationId })
}
