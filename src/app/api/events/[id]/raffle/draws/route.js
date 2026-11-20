// POST /api/events/[id]/raffle/draws — RAFFLE.1: draw a ticket for a prize.
//
// Body: { prize_name }. Picks one ticket uniformly at random (node:crypto)
// from the raffle's tickets that are not in a voided sale and have not been
// drawn. A drawn ticket is out of every later draw (raffle_draws.ticket_id is
// unique); the same person can still win again with another ticket. A draw is
// never deleted.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import {
  resolveStaffRaffleEvent, loadRaffle, listSales, listTickets, listDraws,
  pickRandomIndex, publicWinnerName, DRAW_COLS,
} from '@/lib/raffle'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DrawBody = z.object({ prize_name: z.string().trim().min(1).max(200) })
const failed = () => NextResponse.json({ success: false, error: 'The draw did not happen. Try again.' }, { status: 500 })

async function eligibleTickets(db, raffleId) {
  const [sales, tickets, draws] = await Promise.all([listSales(db, raffleId), listTickets(db, raffleId), listDraws(db, raffleId)])
  if (sales.error || tickets.error || draws.error) return { error: sales.error || tickets.error || draws.error }
  const saleById = new Map(sales.rows.map((s) => [s.id, s]))
  const drawn = new Set(draws.rows.map((d) => d.ticket_id))
  const pool = tickets.rows.filter((t) => {
    const s = saleById.get(t.sale_id)
    return s && !s.voided_at && !drawn.has(t.id)
  })
  return { pool, saleById }
}

export const POST = withAuth({ permission: null, location: false, schema: DrawBody }, async ({ user, params, input }) => {
  const ctx = await resolveStaffRaffleEvent(user, params?.id)
  if (ctx.response) return ctx.response
  const { db, race } = ctx

  const { data: raffle, error: rErr } = await loadRaffle(db, race)
  if (rErr) { logError('raffle', 'draw: raffle read failed', { err: rErr }); return failed() }
  if (!raffle) return NextResponse.json({ success: false, error: 'This event has no raffle yet.' }, { status: 404 })

  // Two attempts: a concurrent draw that took the same ticket fails the
  // unique index, and the second attempt re-reads the pool.
  for (let attempt = 0; attempt < 2; attempt++) {
    const e = await eligibleTickets(db, raffle.id)
    if (e.error) { logError('raffle', 'draw: pool read failed', { err: e.error }); return failed() }
    if (e.pool.length === 0) {
      return NextResponse.json({ success: false, error: 'No tickets left to draw.' }, { status: 409 })
    }
    const ticket = e.pool[pickRandomIndex(e.pool.length)]
    const { data: draw, error } = await db.from('raffle_draws').insert({
      raffle_id: raffle.id, prize_name: input.prize_name, ticket_id: ticket.id, drawn_by: user.id,
    }).select(DRAW_COLS).single()
    if (error) {
      if (error.code === '23505' && attempt === 0) continue
      logError('raffle', 'draw insert failed', { err: error, raffleId: raffle.id })
      return failed()
    }
    const sale = e.saleById.get(ticket.sale_id)
    return NextResponse.json({
      success: true,
      data: {
        draw: {
          ...draw,
          ticket_number: ticket.ticket_number,
          buyer_name: sale?.buyer_name || '',
          winner_display: publicWinnerName(sale?.buyer_name),
        },
        remaining: e.pool.length - 1,
      },
    })
  }
  return failed()
})
