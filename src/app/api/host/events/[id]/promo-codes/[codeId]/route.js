// /api/host/events/[id]/promo-codes/[codeId]
//
// Host self-serve promo codes (HOST-PORTAL.9) — toggle/delete ONE code on ONE
// of the host's OWN events. Double tenancy gate: getCurrentHost() → the event
// must be theirs (404 otherwise), THEN the code row must belong to that event
// (404 otherwise) — a code id from another event/location can't be reached.
//
// PATCH toggles `active` ONLY (hosts recreate a code to change its terms).
// DELETE hard-deletes; past redemptions are safe — registrations snapshot
// their own promo_discount_cents and promo_code_id is ON DELETE SET NULL.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SELECT_COLS =
  'id, location_id, event_id, code, discount_type, discount_value, max_redemptions, redeemed_count, member_only, expires_at, active, created_at'

const PatchSchema = z.object({ active: z.boolean() })

// The host's own event + the code row scoped to it. Returns { race, code } or
// { response } (always a 404 — missing and not-theirs are indistinguishable).
async function loadOwnCode(db, session, eventId, codeId) {
  const notFound = () =>
    ({ response: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) })

  const { data: race } = await db
    .from('race_events')
    .select('id, host_id, location_id')
    .eq('id', eventId)
    .maybeSingle()
  if (!race || race.host_id !== session.host.id) return notFound()

  const { data: code } = await db
    .from('promo_codes')
    .select('id')
    .eq('id', codeId)
    .eq('event_id', race.id)
    .maybeSingle()
  if (!code) return notFound()

  return { race, code }
}

export async function PATCH(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const gate = await loadOwnCode(db, session, params.id, params.codeId)
  if (gate.response) return gate.response

  let body
  try { body = await request.json() } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid update', issues: parsed.error.issues },
      { status: 400 }
    )
  }

  const { data, error } = await db
    .from('promo_codes')
    .update({ active: parsed.data.active })
    .eq('id', gate.code.id)
    .eq('event_id', gate.race.id)
    .select(SELECT_COLS)
    .single()

  if (error) {
    logError('host-promo-codes', 'toggle failed', { codeId: gate.code.id, error: error.message })
    return NextResponse.json({ success: false, error: 'Could not update the promo code.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data })
}

export async function DELETE(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const gate = await loadOwnCode(db, session, params.id, params.codeId)
  if (gate.response) return gate.response

  const { error } = await db
    .from('promo_codes')
    .delete()
    .eq('id', gate.code.id)
    .eq('event_id', gate.race.id)

  if (error) {
    logError('host-promo-codes', 'delete failed', { codeId: gate.code.id, error: error.message })
    return NextResponse.json({ success: false, error: 'Could not delete the promo code.' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
