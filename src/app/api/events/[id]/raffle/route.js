// /api/events/[id]/raffle — RAFFLE.1
//
// GET  — the raffle page's whole state: the raffle (or null), its sales, its
//        draws (with the winning ticket number and buyer) and the totals.
// POST — managers: create the event's raffle, or update its name, single
//        price and ticket options. A change applies to later sales only.
//
// Gate: races at the event's studio (resolveStaffRaffleEvent); 404 for an
// event the caller cannot see.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { resolveStaffRaffleEvent, loadRaffle, loadRaffleState, RAFFLE_COLS } from '@/lib/raffle'
import { getLocationZone, zonedWallClockToInstant, instantToZonedParts } from '@/lib/location-time'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// RAFFLE.2 — ticket options ("3 for €10"), per event. Two or more tickets
// each (one ticket is the single price), one option per ticket count.
const TicketOption = z.object({
  tickets: z.number().int().min(2).max(500),
  price_cents: z.number().int().min(1).max(1000000),
})
const RaffleBody = z.object({
  name: z.string().trim().min(1).max(120),
  ticket_price_cents: z.number().int().min(1).max(100000),
  ticket_options: z.array(TicketOption).max(12).optional()
    .refine((opts) => !opts || new Set(opts.map((o) => o.tickets)).size === opts.length, {
      message: 'Each option needs a different number of tickets.',
    }),
  // RAFFLE.3 — online sales on the event page, and when they stop: a date and
  // a wall-clock time at the event's studio (its locations.timezone).
  online_enabled: z.boolean().optional(),
  online_closes_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  online_closes_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
})

// The closing moment as the date + time inputs show it, in the studio's zone.
function closesLocal(iso, zone) {
  if (!iso) return null
  const p = instantToZonedParts(iso, zone)
  return { date: p.dateKey, time: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}` }
}

export const GET = withAuth({ permission: null, location: false }, async ({ user, params }) => {
  const ctx = await resolveStaffRaffleEvent(user, params?.id)
  if (ctx.response) return ctx.response
  const state = await loadRaffleState(ctx.db, ctx.race)
  if (state.error) {
    logError('raffle', 'state read failed', { err: state.error, eventId: ctx.race.id })
    return NextResponse.json({ success: false, error: 'The raffle could not be read. Try again.' }, { status: 500 })
  }
  const zone = state.raffle?.online_closes_at ? await getLocationZone(ctx.db, ctx.race.location_id) : null
  const raffle = state.raffle
    ? { ...state.raffle, online_closes_local: closesLocal(state.raffle.online_closes_at, zone) }
    : null
  return NextResponse.json({
    success: true,
    data: {
      ...state, raffle,
      event: { id: ctx.race.id, name: ctx.race.name },
      can_manage: ctx.isManager,
      online_available: !ctx.race.host_id,
    },
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

  const options = input.ticket_options
    ? [...input.ticket_options].sort((a, b) => a.tickets - b.tickets)
    : undefined
  let onlineFields = {}
  if (input.online_enabled !== undefined) {
    let closesAt = null
    if (input.online_closes_date && input.online_closes_time) {
      const zone = await getLocationZone(db, race.location_id)
      const ms = zonedWallClockToInstant(input.online_closes_date, input.online_closes_time, zone)
      if (ms == null) return NextResponse.json({ success: false, error: 'That closing date or time is not valid.' }, { status: 400 })
      closesAt = new Date(ms).toISOString()
    }
    if (input.online_enabled && race.host_id) {
      return NextResponse.json({ success: false, error: 'Online raffle sales are only available on UN1T events.' }, { status: 400 })
    }
    onlineFields = { online_enabled: input.online_enabled, online_closes_at: closesAt }
  }
  const fields = {
    name: input.name,
    ticket_price_cents: input.ticket_price_cents,
    ...(options ? { ticket_options: options } : {}),
    ...onlineFields,
  }
  const write = existing
    ? db.from('raffles').update(fields)
      .eq('id', existing.id).eq('location_id', race.location_id).select(RAFFLE_COLS).single()
    : db.from('raffles').insert({
      race_event_id: race.id,
      location_id: race.location_id,
      ...fields,
      created_by: user.id,
    }).select(RAFFLE_COLS).single()
  const { data: raffle, error } = await write
  if (error) {
    logError('raffle', 'raffle save failed', { err: error, eventId: race.id })
    return NextResponse.json({ success: false, error: 'The raffle could not be saved. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { raffle } })
})
