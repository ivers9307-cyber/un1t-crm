// NOTIF.4 — admin test-push endpoint.
//
// POST /api/admin/push/test
// Body: { recipient_id: <profile uuid> }
//
// Sends a single push notification to one user, going through the
// same sendPush() pipeline real notifications use. Category is
// 'test' which is not in the registry — push.js's per-category
// notify_test gating returns undefined (not false), so the push
// goes through; only the user's master push_notifications switch +
// the actual device permission gate it.
//
// Auth: master or owner. Restricted because the result reveals
// device counts + invalidation state — not secret, but not
// regular-staff info either.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { sendPush } from '@/lib/push'

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

  const body = await request.json().catch(() => null)
  const recipientId = body?.recipient_id
  if (!recipientId || typeof recipientId !== 'string') {
    return NextResponse.json({ success: false, error: 'recipient_id required' }, { status: 400 })
  }

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
    category: 'test',
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
