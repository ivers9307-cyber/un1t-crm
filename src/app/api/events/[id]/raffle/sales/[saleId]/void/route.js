// POST /api/events/[id]/raffle/sales/[saleId]/void — RAFFLE.1
//
// Managers void a till mistake. Body: { reason }. Every ticket of the sale
// drops out of later draws and out of the totals; the numbers are never
// reused. A sale with a drawn ticket cannot be voided (409): that would
// change a result after the fact.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { uuidLike } from '@/lib/schemas'
import { resolveStaffRaffleEvent, loadRaffle, SALE_COLS } from '@/lib/raffle'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VoidBody = z.object({ reason: z.string().trim().min(1).max(300) })
const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const failed = () => NextResponse.json({ success: false, error: 'The sale could not be voided. Try again.' }, { status: 500 })

export const POST = withAuth({ permission: null, location: false, schema: VoidBody }, async ({ user, params, input }) => {
  const ctx = await resolveStaffRaffleEvent(user, params?.id, { manager: true })
  if (ctx.response) return ctx.response
  const { db, race } = ctx
  if (!uuidLike.safeParse(params?.saleId).success) return notFound()

  const { data: raffle, error: rErr } = await loadRaffle(db, race)
  if (rErr) { logError('raffle', 'void: raffle read failed', { err: rErr }); return failed() }
  if (!raffle) return notFound()

  const { data: sale, error: sErr } = await db.from('raffle_sales').select(SALE_COLS)
    .eq('id', params.saleId).eq('raffle_id', raffle.id).eq('location_id', race.location_id).maybeSingle()
  if (sErr) { logError('raffle', 'void: sale read failed', { err: sErr }); return failed() }
  if (!sale) return notFound()
  if (sale.voided_at) return NextResponse.json({ success: true, data: { sale } })

  const { data: tickets, error: tErr } = await db.from('raffle_tickets').select('id')
    .eq('raffle_id', raffle.id).eq('sale_id', sale.id)
  if (tErr) { logError('raffle', 'void: tickets read failed', { err: tErr }); return failed() }
  const ids = (tickets || []).map((t) => t.id)
  if (ids.length) {
    const { data: drawn, error: dErr } = await db.from('raffle_draws').select('id')
      .eq('raffle_id', raffle.id).in('ticket_id', ids).limit(1)
    if (dErr) { logError('raffle', 'void: draws read failed', { err: dErr }); return failed() }
    if (drawn?.length) {
      return NextResponse.json({ success: false, error: 'A ticket from this sale has already been drawn, so it cannot be voided.' }, { status: 409 })
    }
  }

  const { data: updated, error } = await db.from('raffle_sales')
    .update({ voided_at: new Date().toISOString(), voided_by: user.id, void_reason: input.reason })
    .eq('id', sale.id).eq('raffle_id', raffle.id).eq('location_id', race.location_id).is('voided_at', null)
    .select(SALE_COLS)
  if (error) { logError('raffle', 'void failed', { err: error, saleId: sale.id }); return failed() }
  return NextResponse.json({ success: true, data: { sale: updated?.[0] || sale } })
})
