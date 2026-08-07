import { NextResponse } from 'next/server'
import { getCurrentUser, requireInboxPermission } from '@/lib/auth'
import { goneResponse } from '../_gone'

// GET / PATCH /api/email/conversations/[id] — RETIRED (EMAIL-CONV-STOP.1,
// 2026-08-07).
//
// GET was the conversation + message thread (and zeroed unread_count as a side
// effect); PATCH stamped or cleared resolved_at. Both now return 410 Gone and
// read and write nothing — the email surface is /api/email/tickets* (mig 482),
// and this repo no longer touches email_conversations anywhere.
//
// Kept rather than deleted for installed mobile builds on frozen OTA lanes; a
// 404 from a missing route is indistinguishable from a network error inside the
// app. Full reasoning + the device_tokens census in ../_gone.js.
//
// 401 before 403 before 410, so an unauthenticated caller cannot enumerate. The
// `email_inbox` gate from INBOX-PERM.2 stays in front even though the handlers
// now answer nothing; the 410 supersedes it in practice, not in code.
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const perm = requireInboxPermission(user, 'em')
  if (perm) return perm

  return goneResponse()
}

export async function PATCH() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const perm = requireInboxPermission(user, 'em')
  if (perm) return perm

  return goneResponse()
}
