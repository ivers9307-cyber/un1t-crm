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
// Auth: an organisation admin of the active organisation (C141
// ORGROLE.2, C18's rule: master or an org_admin grant; an owner at a
// studio is not enough). It is a staff-device-fleet diagnostic, like
// GET /api/staff-devices, and its only button lives on
// /settings/notifications/health, already organisation-admin only.
// Restricted because the result reveals device counts + invalidation
// state — not secret, but not regular-staff info either.
//
// TENANTSCOPE.1 — a non-master may test only someone in their ACTIVE
// organisation's fleet (loadFleetScope: the same people the fleet page
// that renders this button lists). Anyone else gets the SAME 404 as an
// unknown id, decided before the profile read, so another tenant's
// profile ids can't be probed for existence or active state.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { sendPush } from '@/lib/push'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { logError } from '@/lib/log'
import { loadFleetScope, inFleetScope } from '@/lib/staff-fleet-scope'
import { isActiveOrgAdmin } from '@/lib/org-admin'

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
  if (!isActiveOrgAdmin(user)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const v = await validateBody(request, PushTestSchema)
  if (!v.ok) return v.response
  const recipientId = v.data.recipient_id

  const db = createServerClient()

  let scope
  try {
    scope = await loadFleetScope(db, user)
  } catch (err) {
    logError('admin-push-test', 'fleet scope read failed', { error: String(err?.message || err) })
    return NextResponse.json({ success: false, error: 'Failed to load staff scope' }, { status: 500 })
  }
  if (!inFleetScope(scope, recipientId)) {
    return NextResponse.json({ success: false, error: 'Recipient not found' }, { status: 404 })
  }
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
