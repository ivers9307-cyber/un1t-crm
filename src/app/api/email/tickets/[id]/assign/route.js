import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { loadTicketForUser, isElevatedAtLocation } from '../../_helpers'

// POST /api/email/tickets/[id]/assign — who owns this ticket (EMAIL-ASSIGN.1).
//
// assigned_to existed from mig 482 and the 'mine'/'unassigned' views were
// built on it, but nothing ever wrote it: 'mine' was permanently empty and
// two staff sharing a queue had no way to say who owns a ticket. The model is
// the sibling issues feature's claim idiom (REPORT-ISSUE.2), adapted:
//
//   assignee: 'me'   CLAIM. Anyone who can see the ticket may claim an
//                    UNASSIGNED one. The write is conditional on
//                    `assigned_to IS NULL`, so two simultaneous claims race in
//                    Postgres, not in JS — the loser's UPDATE matches nothing
//                    and they get the same 409 they'd have gotten a second
//                    later. A ticket somebody else holds is a 409 outright:
//                    taking over is an explicit elevated REASSIGN, never a
//                    quiet claim.
//   assignee: null   RELEASE. Your own ticket, or anybody's if you are
//                    elevated at the ticket's location. Conditional on the
//                    assignee it was loaded with, same reasoning.
//   assignee: <id>   REASSIGN, elevated-only (master / owner at the ticket's
//                    location). The TARGET must be able to SEE the ticket —
//                    a grant on its mailbox, owner at its location, or master
//                    — because assigning accounts@ mail to someone who cannot
//                    open it strands the ticket in a queue nobody can work.
//                    A NULL-mailbox ticket (deleted address) is visible to
//                    elevated people only, so only they are assignable to it.
//
// BOTH GATES LIVE IN loadTicketForUser (EMAIL-TICKET-CLEANUP.1) — the
// `email_inbox` surface permission resolved at the TICKET'S location plus the
// per-mailbox grant, refusing with 404 so ids can't be probed. The 403s below
// come only AFTER that 404 gate, so they reveal nothing the caller couldn't
// already see.
//
// Deliberately NOT here: auto-assign on inbound (would hide the queue's real
// backlog) and claim-on-reply (a product decision, parked). Collision
// detection builds on this later — out of scope (2026-08-08 audit).

// Any non-'me' string is treated as a profile id: its validity is proven by
// the visibility lookup below (an unknown id simply cannot see the ticket),
// which is a stronger check than shape — and the elevated gate runs first, so
// a non-elevated caller learns nothing by probing ids here.
const AssignSchema = z.object({
  assignee: z.union([z.literal('me'), z.null(), z.string().trim().min(1).max(64)]),
})

// A cast error is a refusal, not an outage: real PostgREST 22P02s an .eq on
// a uuid column fed a non-uuid string. loadTicketForUser sets the precedent
// — a malformed id IS "no such row" (review finding 2; the schema stays
// permissive on purpose so the refusal is uniform for every unknown target).
const isCastError = (e) => e?.code === '22P02'

/**
 * May `profileId` see this ticket? Resolved from the DB because the target is
 * not the caller: master, OR a current MEMBER of the ticket's location who is
 * owner there or holds a grant on the ticket's mailbox.
 *
 * MEMBERSHIP IS REQUIRED alongside the grant (review finding 1): mig 485's
 * grant rows CASCADE on mailbox/profile delete but NOT on profile_locations
 * removal, so an ex-staffer's grant outlives their departure — a grant alone
 * proves nothing about today. The `email_inbox` surface KEY is the one
 * dimension deliberately not re-derived for the target (its resolver tiers
 * live on the caller-shaped user object; re-implementing them here would be a
 * second definition that drifts — the migs 496/502 trade). Residual: a
 * member+grant-holder whose key was switched off can still be named, 404s on
 * the ticket, and the mis-assignment is visible in the queue and reversible
 * by any elevated release — never silent.
 */
async function assigneeCanSee(db, { profileId, mailboxId, locationId }) {
  const { data: profile, error: pErr } = await db.from('profiles')
    .select('id, role')
    .eq('id', profileId)
    .maybeSingle()
  if (pErr && !isCastError(pErr)) return { error: pErr }
  if (profile?.role === 'master') return { ok: true }

  const { data: pl, error: plErr } = await db.from('profile_locations')
    .select('role')
    .eq('profile_id', profileId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (plErr && !isCastError(plErr)) return { error: plErr }
  if (!pl) return { ok: false } // not a member (or not a real id) — cannot see
  if (pl.role === 'owner') return { ok: true }

  if (!mailboxId) return { ok: false } // NULL-mailbox tickets are elevated-only
  const { data: grant, error: gErr } = await db.from('email_mailbox_access')
    .select('mailbox_id')
    .eq('mailbox_id', mailboxId)
    .eq('profile_id', profileId)
    .maybeSingle()
  if (gErr && !isCastError(gErr)) return { error: gErr }
  return { ok: !!grant }
}

/** The assignee's display name, best-effort — cosmetic, never fails the write. */
async function assigneeName(db, profileId) {
  if (!profileId) return null
  try {
    const { data } = await db.from('profiles')
      .select('full_name').eq('id', profileId).maybeSingle()
    return data?.full_name || null
  } catch { return null }
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, AssignSchema)
  if (!validation.ok) return validation.response
  const { assignee } = validation.data

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  const elevated = isElevatedAtLocation(user, ticket.location_id)

  let nextAssignee
  let condition // [method, column, value] the write is conditional on
  if (assignee === 'me') {
    if (ticket.assigned_to === user.id) {
      // Already mine — idempotent, nothing to write.
      return NextResponse.json({
        success: true,
        data: { ticket, assignee_name: await assigneeName(db, user.id) },
      })
    }
    if (ticket.assigned_to) {
      return NextResponse.json({ success: false, error: 'already_assigned' }, { status: 409 })
    }
    nextAssignee = user.id
    condition = ['is', 'assigned_to', null]
  } else if (assignee === null) {
    if (!ticket.assigned_to) {
      return NextResponse.json({ success: true, data: { ticket, assignee_name: null } })
    }
    if (ticket.assigned_to !== user.id && !elevated) {
      return NextResponse.json({ success: false, error: 'not_yours' }, { status: 403 })
    }
    nextAssignee = null
    condition = ['eq', 'assigned_to', ticket.assigned_to]
  } else {
    if (!elevated) {
      return NextResponse.json({ success: false, error: 'not_elevated' }, { status: 403 })
    }
    const seen = await assigneeCanSee(db, {
      profileId: assignee,
      mailboxId: ticket.mailbox_id || null,
      locationId: ticket.location_id,
    })
    if (seen.error) {
      return NextResponse.json({ success: false, error: 'assignee_lookup_failed' }, { status: 500 })
    }
    if (!seen.ok) {
      return NextResponse.json({ success: false, error: 'assignee_cannot_see' }, { status: 400 })
    }
    nextAssignee = assignee
    // Elevated reassign is last-write-wins on purpose — the operator is
    // looking at the queue and correcting it; a stale-assignee 409 here would
    // only make them click twice.
    condition = null
  }

  const now = new Date().toISOString()
  let query = db.from('email_tickets')
    .update({ assigned_to: nextAssignee, updated_at: now })
    .eq('id', ticket.id)
  if (condition) {
    const [method, column, value] = condition
    query = method === 'is' ? query.is(column, value) : query.eq(column, value)
  }
  const { data: updated, error } = await query.select('*').single()
  if (error) {
    // PGRST116 = the conditional matched nothing: somebody won the race
    // between our read and our write. Same answer they'd have gotten a
    // moment later.
    if (error.code === 'PGRST116') {
      return NextResponse.json({ success: false, error: 'already_assigned' }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: { ticket: updated, assignee_name: await assigneeName(db, nextAssignee) },
  })
}
