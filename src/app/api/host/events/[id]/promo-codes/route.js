// /api/host/events/[id]/promo-codes
//
// Host self-serve promo codes (HOST-PORTAL.9) — list + create discount codes
// for ONE of the host's OWN events. Tenancy mirrors every /api/host route:
// getCurrentHost() then race.host_id === session.host.id, 404 otherwise (so
// event ids can't be enumerated).
//
// Codes created here are ALWAYS event-scoped: event_id = the host's event and
// location_id = that event's location (both server-set — never from the body),
// so a host can never mint a location-wide/global code. member_only is forced
// false (host events have member pricing off). Because the public register
// route looks codes up by (location_id, code), host-created codes work at
// checkout with zero changes there.
//
// FEE PRESERVATION (trust boundary): UN1T's €2/ticket booking fee is collected
// inside the Stripe checkout — a code that zeroes the order total makes the
// register route skip Stripe entirely, which would waive the fee. Hosts sit on
// the other side of that fee, so unlike staff codes, a HOST code must never be
// able to zero an order: percent is capped at 99 and fixed must be ≤ ticket
// price − 1 cent. Order totals are price × seats ≥ price, and
// computeDiscountCents caps the discount at the order, so fixed ≤ price − 1
// guarantees total > 0 → checkout always goes through Stripe → the booking fee
// is always charged. Free events (price null/0) can't take codes at all.
// Staff routes are deliberately unchanged — operators may still zero an order.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { normalizeCode } from '@/lib/promo-codes'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Same shape the staff promo-codes routes return (includes redeemed_count for
// the "X of Y used" display).
const SELECT_COLS =
  'id, location_id, event_id, code, discount_type, discount_value, max_redemptions, redeemed_count, member_only, expires_at, active, created_at'

// Host-editable fields ONLY — no event_id / location_id / member_only, which
// are server-set. Mirrors the staff CreateSchema except percent maxes at 99,
// not 100 (fee preservation — see the header comment); the fixed-vs-ticket-
// price cap needs the loaded event, so it's enforced in POST below.
const CreateSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    discount_type: z.enum(['percent', 'fixed']),
    // percent: 0-99 (refined below); fixed: cents.
    discount_value: z.number().int().min(0),
    max_redemptions: z.number().int().min(1).optional(),
    expires_at: z.string().datetime().optional(),
  })
  .refine((d) => d.discount_type !== 'percent' || d.discount_value <= 99, {
    message: "Host discounts can go up to 99% — the ticket can't be fully free.",
    path: ['discount_value'],
  })

// The host's own event, or null (missing OR someone else's — both 404).
async function loadOwnEvent(db, session, id) {
  const { data: race } = await db
    .from('race_events')
    .select('id, host_id, location_id, non_member_fee_cents')
    .eq('id', id)
    .maybeSingle()
  if (!race || race.host_id !== session.host.id) return null
  return race
}

export async function GET(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const race = await loadOwnEvent(db, session, params.id)
  if (!race) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const { data, error } = await db
    .from('promo_codes')
    .select(SELECT_COLS)
    .eq('event_id', race.id)
    .order('created_at', { ascending: false })

  if (error) {
    logError('host-promo-codes', 'list failed', { eventId: race.id, error: error.message })
    return NextResponse.json({ success: false, error: 'Could not load promo codes.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: data || [] })
}

export async function POST(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const race = await loadOwnEvent(db, session, params.id)
  if (!race) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  let body
  try { body = await request.json() } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = CreateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid promo code', issues: parsed.error.issues },
      { status: 400 }
    )
  }
  const input = parsed.data

  // Fee preservation (see header): the per-person ticket price bounds every
  // host discount. Free events have no Stripe checkout to discount at all.
  const priceCents = Number(race.non_member_fee_cents) || 0
  if (priceCents <= 0) {
    return NextResponse.json(
      { success: false, error: "This event is already free — promo codes don't apply." },
      { status: 400 }
    )
  }
  if (input.discount_type === 'fixed' && input.discount_value > priceCents - 1) {
    return NextResponse.json(
      {
        success: false,
        error: `Fixed discounts must be less than the ticket price (€${(priceCents / 100).toFixed(2)}).`,
      },
      { status: 400 }
    )
  }

  const { data, error } = await db
    .from('promo_codes')
    .insert({
      location_id: race.location_id,
      event_id: race.id,
      code: normalizeCode(input.code),
      discount_type: input.discount_type,
      discount_value: input.discount_value,
      max_redemptions: input.max_redemptions ?? null,
      member_only: false,
      expires_at: input.expires_at ?? null,
      active: true,
    })
    .select(SELECT_COLS)
    .single()

  if (error) {
    // UNIQUE (location_id, upper(code)) — friendly conflict, never raw DB text.
    if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
      return NextResponse.json(
        { success: false, error: 'That code is already in use — pick another.', code: 'duplicate_code' },
        { status: 409 }
      )
    }
    logError('host-promo-codes', 'create failed', { eventId: race.id, error: error.message })
    return NextResponse.json({ success: false, error: 'Could not create the promo code.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data }, { status: 201 })
}
