import { NextResponse } from 'next/server'
import { getCurrentUser, requireInboxPermission } from '@/lib/auth'
import { goneResponse } from '../../_gone'

// POST /api/email/conversations/[id]/send — RETIRED (EMAIL-CONV-STOP.1,
// 2026-08-07).
//
// Was the operator reply for the mig 394 email channel: real mail on the wire
// from the company address, on Postmark's transactional stream. It now returns
// 410 Gone, reads nothing, writes nothing and — the assertion that matters —
// NEVER REACHES sendEmail. Replies are sent from /api/email/tickets/[id]/reply
// (mig 482), which carries the per-mailbox email_mailbox_access grant this
// route never had.
//
// Kept rather than deleted for installed mobile builds on frozen OTA lanes; a
// 404 from a missing route is indistinguishable from a network error inside the
// app, and on a compose screen that reads as "did my reply send?". Full
// reasoning + the device_tokens census in ../../_gone.js.
//
// 401 before 403 before 410, so an unauthenticated caller cannot enumerate. The
// `email_inbox` gate from INBOX-PERM.2 stays in front even though the handler
// now answers nothing.
export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const perm = requireInboxPermission(user, 'em')
  if (perm) return perm

  return goneResponse()
}
