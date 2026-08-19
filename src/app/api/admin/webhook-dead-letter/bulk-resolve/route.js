// POST /api/admin/webhook-dead-letter/bulk-resolve — acknowledge every open
// row of ONE provider in a single action (ZOOMSYNC.4).
//
// Why this exists: the per-id sibling ([id]/resolve) is the right shape for the
// email family, where rows arrive one incident at a time and each needs its own
// human judgement. It is the wrong shape for a provider that can park a whole
// population at once. zoom_contact_sync parks a row per phone number, so an
// account-level Zoom refusal (a dropped scope, a lapsed plan) would leave the
// operator to clear the backlog one click at a time — at exactly the moment
// they have just fixed the one credential that caused all of it. The worker's
// PARK_BUDGET caps how many rows that can ever be, and this route is how they
// come back.
//
// Routing note: `bulk-resolve` is a STATIC segment sitting beside the dynamic
// `[id]`. Next resolves static before dynamic, so this wins; row ids are uuids
// and can never collide with the literal anyway.
//
// Body: { provider: string, status?: 'resolved' | 'discarded' }
//   The provider is REQUIRED and there is no "all providers" mode — a blanket
//   clear across sources would let a Zoom cleanup silently acknowledge an
//   unrelated inbound email nobody has looked at.
//
// Only 'pending' and 'failed' rows are touched, matching the single-row route;
// already-terminal rows are left alone rather than re-stamped.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_TARGETS = new Set(['resolved', 'discarded'])
const OPEN_STATUSES = ['pending', 'failed']

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  // Master-or-owner only — mirrors the list and single-row resolve routes.
  if (user.profileRole !== 'master' && user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  let body = {}
  try { body = await request.json() } catch { /* empty body → validation below */ }

  const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
  if (!provider) {
    return NextResponse.json({ success: false, error: 'Missing provider' }, { status: 400 })
  }
  const target = body?.status ?? 'resolved'
  if (!ALLOWED_TARGETS.has(target)) {
    return NextResponse.json({
      success: false,
      error: `Invalid status. Must be one of: ${[...ALLOWED_TARGETS].join(', ')}`,
    }, { status: 400 })
  }

  const db = createServerClient()

  // resolved_at is stamped for both targets — it is what integration health
  // counts on (`resolved_at IS NULL`), same as the single-row route.
  const { data, error } = await db
    .from('webhook_dead_letter')
    .update({ status: target, resolved_at: new Date().toISOString() })
    .eq('provider', provider)
    .in('status', OPEN_STATUSES)
    .select('id')

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: { provider, status: target, updated: (data || []).length },
  })
}
