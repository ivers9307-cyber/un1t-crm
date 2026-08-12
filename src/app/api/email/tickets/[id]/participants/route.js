// EMAIL-PARTICIPANTS.6 — take an address off a ticket's reply audience, or put
// it back.
//
// THE SET ITSELF IS NOT STORED. resolveReplyAudience() derives it from the
// messages on every read, so it cannot drift from the mail that actually
// arrived — which is the whole reason a participants table was rejected in mig
// 534. The ONE piece of state is the operator's subtractions
// (email_tickets.excluded_participants), and this route is the only thing that
// writes them. resolveReplyAudience already reads and applies the column, so a
// removal takes effect on the very next read of the ticket, and on the very
// next reply, with no other moving part.
//
// STORED NORMALISED, ALWAYS. The exclusions are matched against
// normalizeAddressList()'d addresses, so an entry written as the operator typed
// it ('Rates@Council.IE') would never match the derived 'rates@council.ie'. The
// button would look like it worked and the next reply would mail them anyway —
// silent, and the exact class of failure this programme exists to end. It also
// means `restore` matches whatever case the operator happens to send, so an
// exclusion can always be lifted by the person looking at it.
//
// THE GATE IS loadTicketForUser, not a check in this handler. A ticket's
// location is not knowable until the row is read, so a per-route hasPermission
// resolves at the CALLER'S ACTIVE location and lets someone holding email_inbox
// at one studio act on another studio's mail (EMAIL-TICKET-CLEANUP.1). Refusals
// are 404, not 403 — a 403 after the row is read is an existence oracle, and
// every other way to be refused on this surface is already indistinguishable.
//
// The address-validity 400 sits AFTER the load for the same reason: a caller
// who may not open the ticket learns nothing from this route beyond "not
// found", whatever they put in the body.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { normalizeAddressList } from '@/lib/email-recipients'
import { loadTicketForUser } from '../../_helpers'

// Both lists are optional, but a body naming neither is a no-op the caller
// almost certainly did not mean — refused rather than answered 200 with the
// list unchanged, which reads as "removed" on a surface whose whole job is
// removing people. The cap matches MAX_RECIPIENTS: nothing here sends mail, but
// an unbounded array on a text[] column is a free write amplifier.
const ParticipantsSchema = z.object({
  remove: z.array(z.string()).max(25).optional(),
  restore: z.array(z.string()).max(25).optional(),
}).refine(
  v => Boolean(v.remove?.length || v.restore?.length),
  { message: 'Name at least one address to remove or restore' }
)

export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, ParticipantsSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  const remove = normalizeAddressList(validation.data.remove || [])
  const restore = normalizeAddressList(validation.data.restore || [])
  // A typo that reached the column would be a permanent exclusion matching
  // nobody — invisible on the ticket, and liftable only by typing the same typo
  // back. Refused whole rather than partially applied.
  const invalid = [...remove.invalid, ...restore.invalid]
  if (invalid.length) {
    return NextResponse.json({
      success: false,
      error: `Not a valid email address: ${invalid.slice(0, 5).join(', ')}`,
    }, { status: 400 })
  }

  // Set semantics, so the UI re-sending what the operator clicked cannot grow
  // the column. An address named in BOTH lists ends up removed: `remove` is
  // applied last, and the safe reading of a contradictory body on a surface
  // whose purpose is taking people off a thread is the narrower audience.
  const restoreSet = new Set(restore.valid)
  const next = [
    ...new Set([
      ...(ticket.excluded_participants || []).filter(a => !restoreSet.has(a)),
      ...remove.valid,
    ]),
  ]

  const { error } = await db.from('email_tickets')
    .update({ excluded_participants: next, updated_at: new Date().toISOString() })
    .eq('id', ticket.id)
  if (error) {
    console.error('[tickets/:id/participants] update failed:', error.message)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { excluded_participants: next } })
}
