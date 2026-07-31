// NOTIF.4 — admin test-push endpoint.
//
// POST /api/admin/push/test
// Body: { recipient_id: <profile uuid> }
//
// Sends a single push notification to one user, going through the
// same sendPush() pipeline real notifications use.
//
// NO `category` ON PURPOSE (PUSH-TEST.1 — was `category: 'test'`).
// sendPush gates a categorised push on notify_<category>, and
// resolvePermission's last tier is `defaults[role][key] === true`, so
// an UNREGISTERED key resolves to FALSE for every role but master —
// it is not the "no opinion" the old comment here claimed. That was
// true of the raw-key check this predates, and stopped being true
// once the tiered resolver landed. Net effect: this button worked
// when a master tested it on themselves and silently reported
// "sent: 0, skipped: 1" for everyone else — i.e. it broke in exactly
// the situation you reach for it. STAFF-DEV.8 hit the same trap with
// `app_update` and landed on the same answer.
//
// Categoryless is the right shape rather than registering a
// notify_test key: this is an admin-initiated diagnostic aimed at one
// named person, not a preference the recipient should be able to
// switch off (a toggle would just re-create the silent-suppression
// failure with an extra UI row). The user's master push_notifications
// switch and the OS-level device permission remain the only gates,
// which is what "did push reach this phone?" wants to measure.
// Android channel routing comes from `data.type` instead; unmapped
// types land on the legacy 'default' channel, same as before.
//
// Auth: master or owner. Restricted because the result reveals
// device counts + invalidation state — not secret, but not
// regular-staff info either.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { sendPush } from '@/lib/push'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

const PushTestSchema = z.object({
  recipient_id: uuidLike,
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (user.role !== 'master' && user.role !== 'owner' && !user.isMaster) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const v = await validateBody(request, PushTestSchema)
  if (!v.ok) return v.response
  const recipientId = v.data.recipient_id

  const db = createServerClient()
  const { data: target, error } = await db
    .from('profiles')
    .select('id, full_name, active')
    .eq('id', recipientId)
    .maybeSingle()
  if (error || !target) {
    return NextResponse.json({ success: false, error: 'Recipient not found' }, { status: 404 })
  }
  if (!target.active) {
    return NextResponse.json({ success: false, error: 'Recipient is inactive' }, { status: 400 })
  }

  const senderName = user.full_name || user.email || 'Admin'
  const result = await sendPush([recipientId], {
    title: 'Test notification',
    body: `Sent by ${senderName} to check push delivery on your device.`,
    data: {
      type: 'admin_test_push',
      sent_by: user.id,
      sent_at: new Date().toISOString(),
    },
  })

  return NextResponse.json({
    success: true,
    data: result,  // { sent, skipped, invalidated }
  })
}
