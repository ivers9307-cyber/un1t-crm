// /api/events/[id]/raffle — RAFFLE.1
//
// GET  — the raffle page's whole state: the raffle (or null), its sales, its
//        draws (with the winning ticket number and buyer) and the totals.
// POST — managers: create the event's raffle, or update its name and price.
//
// Gate: races at the event's studio (resolveStaffRaffleEvent); 404 for an
// event the caller cannot see.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { resolveStaffRaffleEvent, loadRaffle, loadRaffleState, RAFFLE_COLS } from '@/lib/raffle'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RaffleBody = z.object({
  name: z.string().trim().min(1).max(120),
  ticket_price_cents: z.number().int().min(1).max(100000),
})

export const GET = withAuth({ permission: null, location: false }, async ({ user, params }) => {
  const ctx = await resolveStaffRaffleEvent(user, params?.id)
  if (ctx.response) return ctx.response
  const state = await loadRaffleState(ctx.db, ctx.race)
  if (state.error) {
    logError('raffle', 'state read failed', { err: state.error, eventId: ctx.race.id })
    return NextResponse.json({ success: false, error: 'The raffle could not be read. Try again.' }, { status: 500 })
  }
  return NextResponse.json({
    success: true,
    data: { ...state, event: { id: ctx.race.id, name: ctx.race.name }, can_manage: ctx.isManager },
  })
})

export const POST = withAuth({ permission: null, location: false, schema: RaffleBody }, async ({ user, params, input }) => {
  const ctx = await resolveStaffRaffleEvent(user, params?.id, { manager: true })
  if (ctx.response) return ctx.response
  const { db, race } = ctx

  const { data: existing, error: readErr } = await loadRaffle(db, race)
  if (readErr) {
    logError('raffle', 'raffle read failed', { err: readErr, eventId: race.id })
    return NextResponse.json({ success: false, error: 'The raffle could not be read. Try again.' }, { status: 500 })
  }

  const write = existing
    ? db.from('raffles').update({ name: input.name, ticket_price_cents: input.ticket_price_cents })
      .eq('id', existing.id).eq('location_id', race.location_id).select(RAFFLE_COLS).single()
    : db.from('raffles').insert({
      race_event_id: race.id,
      location_id: race.location_id,
      name: input.name,
      ticket_price_cents: input.ticket_price_cents,
      created_by: user.id,
    }).select(RAFFLE_COLS).single()
  const { data: raffle, error } = await write
  if (error) {
    logError('raffle', 'raffle save failed', { err: error, eventId: race.id })
    return NextResponse.json({ success: false, error: 'The raffle could not be saved. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { raffle } })
})
