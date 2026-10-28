// POST /api/un1t-online/credits/comp — UN1TCOMP.1.
//
// Staff add complimentary class credits, with a use-by date and a reason, to
// a contact's un1t.online account from the Hatch card on the contact page
// (Richard's decision 28 Oct 2026). Gated on the un1t_comp_credits web
// permission at the BOOKING studio (owner, manager and reception by default;
// role templates and per-user overrides honoured), then the same gate as the
// class routes (writes on, the contact in the studio's organisation with an
// account there: 404 otherwise). The limits are enforced here and again in
// the primitive: 1 to 10 credits, a use-by day from tomorrow to a year ahead
// on the STUDIO's clock (expiresInDays = whole calendar days from its today),
// a reason from the fixed list, an optional plain note of at most 200
// characters with no email address or phone number. Then grantCompCredits
// with origin 'staff' and the actor: one POST /credits/grant, never re-sent.
// A done grant hands the card un1t.online's expiry and the studio's editable
// "we've added credits" text (chat_template), which the card drops into an
// open WhatsApp thread when its box is ticked: best effort, never undoing
// the grant.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { gateUn1tStaffBooking, staffWriteAnswer, UN1T_STAFF_COPY } from '@/lib/un1t-staff-booking'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { grantCompCredits } from '@/lib/un1t-online-write-ops'
import { readCompChatTemplate } from '@/lib/book-chat-copy'
import { canGrantCompCredits } from '@/lib/un1t-comp-credits-access'
import { getLocationZone, formatInZone, LocationZoneReadError } from '@/lib/location-time'
import {
  COMP_CREDIT_LIMITS as L,
  COMP_CREDIT_REASON_KEYS,
  compDaysUntil,
  compNoteProblem,
  formatUseBy,
  isDateKey,
} from '@/lib/un1t-comp-credits'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
// A write plus its check read can wait out one budget window.
export const maxDuration = 120

const DAY_OPTS = Object.freeze({ weekday: 'short', day: 'numeric', month: 'short' })

const CompCreditsSchema = z.object({
  contact_id: uuidLike,
  location_id: uuidLike,
  // One per form submission: a double click is one grant (the ledger key).
  request_id: uuidLike,
  amount: z.number().int().min(L.minCredits).max(L.maxCredits),
  use_by: z.string().refine(isDateKey, 'Must be a YYYY-MM-DD day'),
  reason: z.enum([...COMP_CREDIT_REASON_KEYS]),
  note: z.string().nullable().optional().superRefine((v, ctx) => {
    const problem = compNoteProblem(v)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
  }),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const validation = await validateBody(request, CompCreditsSchema)
  if (!validation.ok) return validation.response
  const b = validation.data

  // The permission first: someone without it learns nothing about the contact.
  if (!canGrantCompCredits(user, b.location_id)) {
    return NextResponse.json({ success: false, error: UN1T_STAFF_COPY.compForbidden }, { status: 403 })
  }

  const db = createServerClient()
  const gate = await gateUn1tStaffBooking(db, user, { locationId: b.location_id, contactId: b.contact_id, offText: UN1T_STAFF_COPY.compOff })
  if (!gate.ok) return NextResponse.json({ success: false, error: gate.error }, { status: gate.status })

  let zone
  try {
    zone = await getLocationZone(db, b.location_id)
  } catch (err) {
    if (err instanceof LocationZoneReadError) return NextResponse.json({ success: false, error: UN1T_STAFF_COPY.compZoneUnreadable }, { status: 503 })
    throw err
  }
  const expiresInDays = compDaysUntil(b.use_by, zone)
  if (expiresInDays == null || expiresInDays < L.minDays || expiresInDays > L.maxDays) {
    return NextResponse.json({
      success: false,
      error: 'Invalid request body',
      issues: [{ path: ['use_by'], message: 'Choose a use-by date from tomorrow to a year ahead.' }],
    }, { status: 400 })
  }

  let r
  try {
    r = await grantCompCredits(db, {
      locationId: b.location_id, contactId: b.contact_id, un1tUserId: gate.un1tUserId,
      amount: b.amount, expiresInDays, useBy: b.use_by, reason: b.reason, note: b.note ?? null,
      requestId: b.request_id, origin: 'staff', actor: { id: user.id },
    })
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return NextResponse.json({ success: false, error: UN1T_STAFF_COPY.settingsUnreadable }, { status: 503 })
    throw err
  }
  const { status, body } = staffWriteAnswer(r, { op: 'comp' })
  if (status === 200) {
    const expires = Date.parse(body.data.expires_at ?? '')
    const until = Number.isFinite(expires) ? formatInZone(new Date(expires), zone, DAY_OPTS, 'en-GB') : formatUseBy(b.use_by)
    body.data = { ...body.data, amount: b.amount, use_by: b.use_by, message: UN1T_STAFF_COPY.compAdded(b.amount, until) }
    // The credits ARE added, so a failed read never fails this: the card sends the default.
    const chat = await readCompChatTemplate(db, b.location_id)
    if (chat.error) logWarn('un1t-comp-credits', 'complimentary credits template read failed; the default is used', { locationId: b.location_id, err: chat.error })
    body.data.chat_template = chat.template ?? null
  }
  return NextResponse.json(body, { status })
}
