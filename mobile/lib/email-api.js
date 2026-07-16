// Email inbox API helpers for mobile (INBOX-EMAIL-M.1).
//
// Same posture as Instagram: the email_* tables carry a RESTRICTIVE
// deny-all policy for authenticated/anon (mig 394 mirrors the
// instagram_* RLS from mig 231), so mobile never reads them direct —
// every call rides the existing /api/email/* web routes via the api()
// helper, which carries the Bearer token + x-active-location +
// x-impersonate-target headers. The thread GET resets unread_count
// server-side, so there's no separate mark-read call.

import { api } from './api'

export async function listConversations(locationId) {
  const qs = locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''
  const res = await api(`/api/email/conversations${qs}`, { locationId })
  if (!res.success) return { success: false, error: res.error || 'Failed to load email' }
  return { success: true, data: res.conversations || [] }
}

// Conversation + newest messages in one call. Resets unread server-side.
export async function getThread(conversationId, locationId) {
  const res = await api(`/api/email/conversations/${conversationId}`, { locationId })
  if (!res.success) return { success: false, error: res.error || 'Failed to load conversation' }
  return { success: true, conversation: res.conversation, messages: res.messages || [] }
}

// Operator reply. Server-side this sends via Postmark's transactional
// stream with threading headers (In-Reply-To / References) so the reply
// lands in the customer's mail-client thread — see the web send route.
export function sendText(conversationId, text, locationId) {
  return api(`/api/email/conversations/${conversationId}/send`, {
    method: 'POST',
    locationId,
    body: { text },
  })
}

// Resolve (or un-resolve). Email has no customer agent, so unlike
// WhatsApp/Instagram there's no agent re-arm side effect — resolve is
// purely the queue state (UIX-P1 semantics).
export function resolveConversation(conversationId, resolved, locationId) {
  return api(`/api/email/conversations/${conversationId}`, {
    method: 'PATCH',
    locationId,
    body: { resolved: !!resolved },
  })
}

// Display-name precedence for an email conversation row — mirrors the
// web EmailInbox displayName / UnifiedInbox rowName exactly.
export function emailDisplayName(conv) {
  const c = conv?.contacts
  return c?.name
    || c?.first_name
    || conv?.counterpart_name
    || conv?.counterpart_email
    || 'Email contact'
}
