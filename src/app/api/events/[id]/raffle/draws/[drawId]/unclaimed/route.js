// POST /api/events/[id]/raffle/draws/[drawId]/unclaimed — RAFFLE.1
//
// Managers mark a draw "not claimed" (the winner can't be reached or
// declines). Body: { note? }. The draw stays on the record and its ticket
// stays out of later draws; staff then draw again for the same prize.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { uuidLike } from '@/lib/schemas'
import { resolveStaffRaffleEvent, loadRaffle, DRAW_COLS } from '@/lib/raffle'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({ note: z.string().trim().max(300).optional() })
const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const failed = () => NextResponse.json({ success: false, error: 'Could not update the draw. Try again.' }, { status: 500 })

export const POST = withAuth({ permission: null, location: false, schema: Body }, async ({ user, params, input }) => {
  const ctx = await resolveStaffRaffleEvent(user, params?.id, { manager: true })
  if (ctx.response) return ctx.response
  const { db, race } = ctx
  if (!uuidLike.safeParse(params?.drawId).success) return notFound()

  const { data: raffle, error: rErr } = await loadRaffle(db, race)
  if (rErr) { logError('raffle', 'unclaimed: raffle read failed', { err: rErr }); return failed() }
  if (!raffle) return notFound()

  const { data: rows, error } = await db.from('raffle_draws')
    .update({ unclaimed_at: new Date().toISOString(), unclaimed_by: user.id, unclaimed_note: input.note || null })
    .eq('id', params.drawId).eq('raffle_id', raffle.id).is('unclaimed_at', null)
    .select(DRAW_COLS)
  if (error) { logError('raffle', 'unclaimed update failed', { err: error }); return failed() }
  if (!rows?.length) {
    const { data: existing, error: eErr } = await db.from('raffle_draws').select(DRAW_COLS)
      .eq('id', params.drawId).eq('raffle_id', raffle.id).maybeSingle()
    if (eErr) return failed()
    if (!existing) return notFound()
    return NextResponse.json({ success: true, data: { draw: existing } })
  }
  return NextResponse.json({ success: true, data: { draw: rows[0] } })
})
