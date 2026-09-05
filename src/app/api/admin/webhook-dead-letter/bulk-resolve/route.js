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
//
// WHO (MAIL-DEADLETTER.1 review fix). Master is unbounded. Anyone else must be
// OWNER somewhere (403 otherwise — a collection route, nothing to enumerate),
// and the UPDATE is bounded to `.in('location_id', <their owner locations>)`
// via deadLetterOwnerLocationIds — never `user.role`, the caller's ACTIVE-
// studio role, which let an owner in org A acknowledge org B's unfiled mail in
// one POST. SQL's IN is never true for NULL, so NULL-location rows are left
// to master, matching the list route.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { deadLetterOwnerLocationIds } from '../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_TARGETS = new Set(['resolved', 'discarded'])
const OPEN_STATUSES = ['pending', 'failed']

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  // Master, or owner at SOME location — judged per location, not by the
  // active role. The bound below is what decides which rows the write reaches.
  const ownerLocationIds = deadLetterOwnerLocationIds(user)
  if (ownerLocationIds !== null && ownerLocationIds.length === 0) {
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
  let write = db
    .from('webhook_dead_letter')
    .update({ status: target, resolved_at: new Date().toISOString() })
    .eq('provider', provider)
    .in('status', OPEN_STATUSES)
  // Non-master: bound to the caller's owner locations (excludes NULL rows).
  if (ownerLocationIds !== null) write = write.in('location_id', ownerLocationIds)
  const { data, error } = await write.select('id')

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: { provider, status: target, updated: (data || []).length },
  })
}
