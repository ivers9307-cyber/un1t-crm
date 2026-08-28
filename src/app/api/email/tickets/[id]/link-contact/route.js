import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { loadTicketForUser } from '../../_helpers'

// POST /api/email/tickets/[id]/link-contact — EMAIL-CONTACT-CHIP.2.
//
// "Add to contacts" on an unlinked thread. Gated through loadTicketForUser
// like every other ticket write on this surface: 404, never 403, for a
// ticket that does not exist, sits at a location the caller cannot reach, is
// on a mailbox they cannot see, or is at a location where they lack
// `email_inbox` — all four indistinguishable from outside, same as GET
// …/tickets/[id] and every sibling mutation route.
//
// IDEMPOTENT. A ticket that already carries contact_id answers 200 with that
// contact rather than an error or a second write — a double-click, a retry
// after a flaky response, or two staff opening the same ticket must not
// fight each other or leave an inconsistent contact behind.
//
// REUSES findOrCreateRaceContact with restrictToOrg: true — the SAME
// LEADCAP.1 create-or-link helper every other operator-facing "resolve this
// email to a contact" path uses (team-members, event/race rosters). email is
// GLOBALLY unique on contacts (contacts_email_unique, mig 008), so a second
// create path here would be a second chance to hit 23505 blind, or to link a
// stranger's contact across an organisation the caller cannot see into. No
// second implementation exists in this file.
const CONTACT_COLUMNS = 'id, name, first_name, email, pipeline_stage_slug'

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  // Already linked — answer with the existing contact rather than doing (or
  // refusing) a second write. See the idempotency note above.
  if (ticket.contact_id) {
    const { data: contact, error: contactErr } = await db.from('contacts')
      .select(CONTACT_COLUMNS)
      .eq('id', ticket.contact_id)
      .maybeSingle()
    if (contactErr) {
      console.error('[tickets/:id/link-contact] existing contact lookup failed:', contactErr.message)
      return NextResponse.json({ success: false, error: contactErr.message }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: { contact: contact || null } })
  }

  // Nothing to resolve an identity from. The UI only ever shows the "Add to
  // contacts" button when requester_email is set (TicketThread.jsx), but this
  // route is the actual gate — anything holding a ticket id can still POST.
  if (!ticket.requester_email) {
    return NextResponse.json({
      success: false,
      error: 'This ticket has no sender email to link to a contact.',
    }, { status: 400 })
  }

  const contactId = await findOrCreateRaceContact({
    db,
    locationId: ticket.location_id,
    email: ticket.requester_email,
    name: ticket.requester_name,
    // LEADCAP.1 — match/create anywhere in the SAME organisation, never a
    // bare location match and never a global one: contacts_email_unique is a
    // GLOBAL index, so without org scope a known email either 500s on
    // insert or (worse) would have to fall back to a cross-tenant match.
    restrictToOrg: true,
    // H1 (pre-merge audit) — findOrCreateRaceContact's own INSERT is
    // hard-coded to the race shape (name: name || 'Race competitor', source:
    // 'race_signup', lead_source: 'website'), because every OTHER caller
    // really is a race/event signup. This caller is not, and insertFields is
    // spread LAST in the helper so it overrides all three on CREATE ONLY —
    // an existing contact matched by email is never touched (see the
    // helper's own header comment and findOrCreateRaceContact.test.js).
    //
    // name: requester_name is NULL for any sender whose From header carries
    // no display name (routine for suppliers and bare user@domain senders);
    // without this fallback that contact would be permanently named "Race
    // competitor".
    //
    // source: 'email_inbox' is a NEW value, verified free to introduce —
    // contacts.source carries no CHECK constraint (only host_contacts.source
    // is constrained, a different table) and nothing in the funnel
    // classifier, audience filters, or reporting keys off it exhaustively;
    // mig 279's own comment confirms `source` is untouched by person-match,
    // lead-radar and the pipeline classifier, which all key off lead_source
    // instead. The estate already carries a dozen free-text source values
    // this specific ('staff_inbox', 'manual', 'event_registration', …) — one
    // more naming a genuine origin is the honest choice, not a novelty.
    //
    // lead_source: null, NOT 'website' — this sender did not come through
    // the public website funnel, and 'website' silently drops them into
    // every audience/report built on that filter (the exact H1 failure
    // mode). No email-derived lead_source exists yet, so null is correct
    // pending a real classification, exactly as CLASSIFY.2 already leaves it
    // for every other non-web-form contact.
    insertFields: {
      name: ticket.requester_name || ticket.requester_email,
      source: 'email_inbox',
      lead_source: null,
    },
  })
  // findOrCreateRaceContact never throws; null means it tried and failed
  // (logged internally via logWarn) — nothing was linked, so this is a
  // genuine failure to report, not a "no match" to paper over.
  if (!contactId) {
    return NextResponse.json({
      success: false,
      error: 'Could not link a contact. Nothing was changed — try again.',
    }, { status: 500 })
  }

  const { error: updateErr } = await db.from('email_tickets')
    .update({ contact_id: contactId, updated_at: new Date().toISOString() })
    .eq('id', ticket.id)
  if (updateErr) {
    console.error('[tickets/:id/link-contact] ticket update failed:', updateErr.message)
    return NextResponse.json({ success: false, error: updateErr.message }, { status: 500 })
  }

  // Denormalised contact_id on the messages themselves — the inbound webhook
  // stamps this at ingest time on every message row
  // (postmark-inbound/[token]/route.js), so a thread linked after the fact
  // should read exactly like one that arrived already linked. Best-effort and
  // logged rather than failing the request: the ticket is already linked at
  // this point (the write above committed), and turning a cosmetic backfill
  // miss into a 500 would report failure for a request that in fact
  // succeeded — the CLAUDE.md rule that removing a silent failure must never
  // create a louder one.
  const { error: backfillErr } = await db.from('email_inbox_messages')
    .update({ contact_id: contactId })
    .eq('ticket_id', ticket.id)
    .is('contact_id', null)
  if (backfillErr) {
    console.error('[tickets/:id/link-contact] message contact_id backfill failed:', backfillErr.message)
  }

  const { data: contact, error: contactErr } = await db.from('contacts')
    .select(CONTACT_COLUMNS)
    .eq('id', contactId)
    .maybeSingle()
  if (contactErr) {
    console.error('[tickets/:id/link-contact] linked contact lookup failed:', contactErr.message)
    return NextResponse.json({ success: false, error: contactErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { contact: contact || null } })
}
