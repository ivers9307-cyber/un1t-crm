// POST /api/events/[id]/raffle/sales — RAFFLE.1: sell tickets at the till.
//
// Body: { request_id, contact_id?, buyer_name, buyer_email, quantity,
// payment_method }. request_id is the till's idempotency key: a double tap or
// a retry returns the same sale and the same numbers.
//
// With contact_id the buyer must be a contact at the event's studio (else
// 404). Without it the buyer is a guest: their name and email live on the
// sale row only. This route writes NOTHING to contacts, pipelines, tags or
// sequences: sell_raffle_tickets (mig 864) writes only the raffle tables.
//
// The email goes after the sale is recorded; its failure never fails the sale.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { uuidLike, email } from '@/lib/schemas'
import { resolveStaffRaffleEvent, loadRaffle } from '@/lib/raffle'
import { sendRaffleTicketsEmail } from '@/lib/raffle-email'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SaleBody = z.object({
  request_id: uuidLike,
  contact_id: uuidLike.nullable().optional(),
  buyer_name: z.string().trim().min(1).max(200),
  buyer_email: email,
  quantity: z.number().int().min(1).max(500),
  payment_method: z.enum(['cash', 'card']),
})

export const POST = withAuth({ permission: null, location: false, schema: SaleBody }, async ({ user, params, input }) => {
  const ctx = await resolveStaffRaffleEvent(user, params?.id)
  if (ctx.response) return ctx.response
  const { db, race } = ctx

  const { data: raffle, error: raffleErr } = await loadRaffle(db, race)
  if (raffleErr) {
    logError('raffle', 'raffle read failed', { err: raffleErr, eventId: race.id })
    return NextResponse.json({ success: false, error: 'The raffle could not be read. Try again.' }, { status: 500 })
  }
  if (!raffle) return NextResponse.json({ success: false, error: 'This event has no raffle yet.' }, { status: 404 })
  if (!raffle.sales_open) return NextResponse.json({ success: false, error: 'Raffle sales are closed.' }, { status: 409 })

  const contactId = input.contact_id || null
  if (contactId) {
    const { data: contact, error: cErr } = await db.from('studio_contacts')
      .select('id').eq('id', contactId).eq('studio_location_id', race.location_id).limit(1).maybeSingle()
    if (cErr) {
      logError('raffle', 'buyer contact check failed', { err: cErr, eventId: race.id })
      return NextResponse.json({ success: false, error: 'The buyer could not be checked. Try again.' }, { status: 500 })
    }
    if (!contact) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const { data: sale, error } = await db.rpc('sell_raffle_tickets', {
    p_raffle_id: raffle.id,
    p_request_id: input.request_id,
    p_contact_id: contactId,
    p_buyer_name: input.buyer_name,
    p_buyer_email: input.buyer_email.trim().toLowerCase(),
    p_quantity: input.quantity,
    p_payment_method: input.payment_method,
    p_sold_by: user.id,
  })
  if (error) {
    if (String(error.message || '').includes('raffle_closed')) {
      return NextResponse.json({ success: false, error: 'Raffle sales are closed.' }, { status: 409 })
    }
    logError('raffle', 'sale failed', { err: error, eventId: race.id })
    return NextResponse.json({ success: false, error: 'The sale was not recorded. Try again.' }, { status: 500 })
  }

  // An idempotent replay of a sale whose email already went must not send it twice.
  let emailStatus = sale.email_status || null
  if (!emailStatus) {
    const sent = await sendRaffleTicketsEmail({ db, sale, raffle, race })
    emailStatus = sent.status
  }
  return NextResponse.json({ success: true, data: { sale: { ...sale, email_status: emailStatus } } })
})
