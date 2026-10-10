// POST /api/public/entry/[token]/move — EVENT-MOVE.6
//
// Public, no session. The person who booked an entry moves it to another
// date from the link in their confirmation email. The signed entry token
// (src/lib/entry-manage-tokens.js) is the only credential: any bad, expired
// or forged token, or an entry that no longer exists, is a 404 (never
// 401/403, so a link cannot be probed).
//
// Body { target_event_id, target_wave_id }. Anything else (force, an amount)
// is ignored: a customer never forces a full time and never names a price.
//
// The same rules staff use (checkMove / moveRegistration), plus: only a
// confirmed entry on an event that has not happened yet. Then:
//   - equal or cheaper target: moved at once, recorded as actor 'customer'
//     (mig 712), the new tickets emailed. Nothing is refunded.
//     → { moved: true, registration, notified }
//   - dearer target: nothing moves yet. A move_gap payment (EVENT-MOVE.5)
//     is minted carrying metadata.pending_move; paying it makes the move
//     (completeGapPayment). → { moved: false, pay_url }. pay_url carries
//     `#back=<this token>`: the checkout reads the fragment (never sent to a
//     server) to return here once paid. No token is minted anywhere else.
//   - after an immediate move, any open dearer link on the entry is closed.
//
// Targets are fenced to the entry's organisation (moveLocationIds): a move
// may cross studios, never organisations. An unreadable fence fails closed.
//
// Every refusal carries `error` (the code) and `message` (customer copy,
// src/lib/registration-move-public.js). Status: 404 bad link / gone entry;
// 409 a full time (no numbers), conflict, already paid, host not ready; 500
// a failed read or write; 502 the payment provider; 400 every other rule.
// Rate limited per IP: 10 per 15 minutes.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { verifyEntryManageTokenFromEnv } from '@/lib/entry-manage-tokens'
import { readRegistrationForMove, checkMove, moveRegistration, moveLocationIds } from '@/lib/registration-move'
import { entryLeadName } from '@/lib/registration-entry'
import { entryMoveBlock, customerMoveMessage, CUSTOMER_MOVE_STATUS } from '@/lib/registration-move-public'
import { createGapPayment, closeCustomerGapLinks } from '@/lib/race-gap-payment'
import { dublinTodayStr } from '@/lib/dublin-time'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const PublicEntryMoveSchema = z.object({
  target_event_id: uuidLike,
  target_wave_id: uuidLike.nullable().optional(),
})

const notFound = () => NextResponse.json({ success: false, error: 'not_found', message: customerMoveMessage('not_found') }, { status: 404 })

/** A refusal: the code and the customer sentence, never a number about room. */
function refusal(code) {
  return NextResponse.json(
    { success: false, error: code, message: customerMoveMessage(code) },
    { status: CUSTOMER_MOVE_STATUS[code] || 400 },
  )
}

/**
 * The studios this entry may move to: its organisation's (moveLocationIds),
 * from the organisation already embedded on the entry's event. null = could
 * not read it (fail closed).
 */
async function entryOrganisationLocations(db, reg) {
  const loc = reg.race?.locations
  const organizationId = loc ? (loc.organization_id || null) : undefined
  return moveLocationIds(db, reg.race?.location_id || null, { organizationId })
}

export async function POST(request, props) {
  const { token } = await props.params
  const db = createServerClient()

  const limit = await checkRateLimit(db, `entry-move:${getClientIp(request)}`, { max: 10, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const claim = verifyEntryManageTokenFromEnv(token)
  if (!claim) return notFound()

  const validation = await validateBody(request, PublicEntryMoveSchema)
  if (!validation.ok) return validation.response
  const targetEventId = validation.data.target_event_id
  const targetWaveId = validation.data.target_wave_id || null

  const { registration: reg, error: readErr } = await readRegistrationForMove(db, claim.registrationId)
  if (readErr) return refusal('load_failed')
  if (!reg) return notFound()

  // Unpaid, cancelled, past: refused before any rule runs. A check-in is
  // the rules' own checked_in below (they read it fresh).
  const block = entryMoveBlock({ registration: reg, checkinCount: 0, today: dublinTodayStr() })
  if (block) return refusal(block.code)

  const allowedLocationIds = await entryOrganisationLocations(db, reg)
  if (!allowedLocationIds) return refusal('load_failed')

  // Every rule, fresh, with nothing written: so nobody pays for a move the
  // rules would refuse, and the difference is the server's, never the client's.
  const checked = await checkMove(db, {
    registrationId: reg.id, targetEventId, targetWaveId, force: false, allowedLocationIds, expectedSourceEventId: reg.race_event_id,
  })
  if (!checked.ok) return refusal(checked.error)

  const actor = { type: 'customer', id: reg.contact_id || null, name: entryLeadName({ registration: reg }) || 'Customer' }

  if (!(checked.priceGapCents > 0)) {
    const moved = await moveRegistration(db, {
      registrationId: reg.id, targetEventId, targetWaveId, actor,
      notify: true, force: false, allowedLocationIds, expectedSourceEventId: reg.race_event_id,
    })
    if (!moved.ok) return refusal(moved.error)
    // An older dearer change still open on this entry no longer applies:
    // close its link so it cannot be paid (and then refused). Best-effort.
    try {
      await closeCustomerGapLinks(db, reg.id)
    } catch {
      // closeCustomerGapLinks logs its own failures; the move stands.
    }
    return NextResponse.json({ success: true, data: { moved: true, registration: moved.registration, notified: moved.notified === true } })
  }

  // Dearer: pay first. The checkout returns to this same page — on the EVENT
  // LOCATION's tenant host (W1.L3b; the resolver floors to the CRM host).
  const baseUrl = await resolveCustomerBaseUrl(db, reg.race?.location_id || null)
  const pageUrl = `${baseUrl}/event/entry/${token}`
  const created = await createGapPayment({
    db,
    registration: checked.registration,
    race: checked.registration.race,
    pendingMove: {
      target_event_id: targetEventId,
      target_wave_id: checked.targetWave?.id || null,
      expected_source_event_id: reg.race_event_id,
      actor,
    },
    amountCents: checked.priceGapCents,
    returnUrl: pageUrl,
    cancelUrl: pageUrl,
  })
  if (!created.ok) return refusal(created.error)
  return NextResponse.json({ success: true, data: { moved: false, pay_url: `${created.checkoutUrl}#back=${token}` } })
}
