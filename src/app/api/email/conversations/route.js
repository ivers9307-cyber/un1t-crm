import { NextResponse } from 'next/server'
import { getCurrentUser, requireInboxPermission } from '@/lib/auth'
import { goneResponse } from './_gone'

// GET /api/email/conversations — RETIRED (EMAIL-CONV-STOP.1, 2026-08-07).
//
// Was the operator inbox list for the mig 394 email channel. It now returns
// 410 Gone and reads nothing: the email surface is /api/email/tickets* (mig
// 482), and this repo no longer touches email_conversations anywhere.
//
// The file is kept rather than deleted because installed mobile builds on
// frozen OTA lanes still call it, and a 404 is indistinguishable from a network
// error inside the app. Full reasoning, and the device_tokens census that says
// nobody is actually on those lanes, in ./_gone.js.
//
// The guard order below is load-bearing: 401 before 403 before 410, so an
// unauthenticated caller learns nothing about which routes exist. INBOX-PERM.2
// re-gated this route from `whatsapp` to `email_inbox` days ago; that gate is
// kept even though the handler now answers nothing.
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const perm = requireInboxPermission(user, 'em')
  if (perm) return perm

  return goneResponse()
}
