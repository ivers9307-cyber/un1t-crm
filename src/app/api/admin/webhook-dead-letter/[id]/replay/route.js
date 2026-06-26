// POST /api/admin/webhook-dead-letter/[id]/replay
//
// Manual replay trigger for a single dead-letter row. Master/owner only —
// mirrors the auth pattern of GET /api/admin/webhook-dead-letter.
//
// Only acts on rows with status 'pending' or 'failed'. Rows that are already
// 'resolved' or 'discarded' are rejected (409 / 400 respectively).
//
// Providers not in the idempotent replay registry (e.g. glofox) return 400
// so the UI can surface "this provider cannot be auto-replayed" without
// the user having to try and fail.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { isReplayable, replayDeadLetter } from '@/lib/webhook-replay'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  // Master-or-owner only — mirrors the dead-letter list route.
  if (user.profileRole !== 'master' && user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  const { id } = params
  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 })
  }

  const db = createServerClient()

  // Load the row.
  const { data: row, error: fetchErr } = await db
    .from('webhook_dead_letter')
    .select('id, provider, payload, status, attempts')
    .eq('id', id)
    .single()

  if (fetchErr || !row) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // Only replay actionable rows.
  if (row.status === 'resolved') {
    return NextResponse.json(
      { success: false, error: 'Row already resolved' },
      { status: 409 }
    )
  }
  if (row.status === 'discarded') {
    return NextResponse.json(
      { success: false, error: 'Row is discarded — cannot replay' },
      { status: 400 }
    )
  }

  // Guard: only idempotent providers.
  if (!isReplayable(row.provider)) {
    return NextResponse.json(
      { success: false, error: 'provider not auto-replayable' },
      { status: 400 }
    )
  }

  const result = await replayDeadLetter(db, row)

  return NextResponse.json({
    success: result.ok,
    status: result.status,
    id: row.id,
    provider: row.provider,
  })
}
