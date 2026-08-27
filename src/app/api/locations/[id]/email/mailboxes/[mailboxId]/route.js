// EMAIL-MAILBOX-ADMIN.1 — edit one email account.
//
// PATCH /api/locations/[id]/email/mailboxes/[mailboxId]
//   Body: { label?, is_default?, active?, surface? }
//
// INBOX-SURFACE.C — `surface` IS THE A/B SWITCH, and it lives here rather than
// on a route of its own because it is the same kind of decision as `active`
// and `is_default`: a property of one account, set by the one population
// allowed to manage accounts, on the screen where accounts are managed. A
// separate endpoint would be a second gate to keep in step with this one.
//
// It moves that account's mail between two surfaces — the ticket queue at
// /communications/tickets and the mail surface at /communications/mail. NOTHING
// IS COPIED AND NOTHING IS DELETED: `surface` is read at LIST time by whichever
// queue is asking, so flipping it is instantaneous, reversible, and leaves
// every ticket, message and attachment exactly where it was. That is precisely
// why it is safe to offer as a plain toggle rather than a migration.
//
// It is audit-logged under its OWN action for the same reason deactivation is:
// an operator asking "where did our mail go" needs one greppable line in
// /admin/audit-log that says who moved it and when.
//
// THERE IS NO DELETE, DELIBERATELY.
// email_tickets.mailbox_id is ON DELETE SET NULL, so deleting a mailbox would
// silently orphan every ticket that arrived at it — the correspondence
// survives but loses the one field that says which address it came in on, and
// with it any chance of replying from the right place. `active = false` is the
// removal path: it stops inbound routing (resolveMailboxByRecipient skips
// inactive mailboxes and returns null rather than guessing) and hides the tab
// from everyone including owners, while the row and its history stay.
//
// THE ADDRESS IS IMMUTABLE, DELIBERATELY.
// Editing it in place would silently reattribute every historic ticket to an
// address that never received them. Deactivate and add the new one.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { logAuditEvent } from '@/lib/audit'
import {
  MAILBOX_SURFACES, guardMailboxAdmin, mailboxUnauthorized, loadMailboxOr404,
} from '../_helpers'
import {
  MAILBOX_LABEL_MAX,
  normalizeMailboxLabel,
  mailboxConstraintMessage,
  deactivationPatch,
} from '@/lib/email-mailbox-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PatchBody = z.object({
  label: z.string().min(1).max(MAILBOX_LABEL_MAX + 200).optional(),
  is_default: z.boolean().optional(),
  active: z.boolean().optional(),
  // Validated against the same two values the table's named CHECK carries, so
  // a typo is a 400 with a sentence rather than a 23514 the operator cannot
  // read. z.enum, not a free string: `surface` decides which screen a studio's
  // mail appears on, and a third value would be a mailbox on NO screen.
  surface: z.enum(MAILBOX_SURFACES).optional(),
})

export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return mailboxUnauthorized()
  const guard = guardMailboxAdmin(user, params.id)
  if (guard) return guard

  const validation = await validateBody(request, PatchBody)
  if (!validation.ok) return validation.response
  const body = validation.data
  if (body.label === undefined && body.is_default === undefined
      && body.active === undefined && body.surface === undefined) {
    return NextResponse.json({ success: false, error: 'Nothing to change.' }, { status: 400 })
  }

  const db = createServerClient()
  const found = await loadMailboxOr404(db, params.id, params.mailboxId)
  if (found.response) return found.response
  const mailbox = found.mailbox
  // Snapshot the prior state by VALUE. The audit row's whole worth is the
  // before/after pair, and reading `mailbox.label` again after the UPDATE
  // would record the new value as the old one.
  // `surface` falls back to 'tickets' when the column is absent from the row
  // (pre-mig-575), matching the column's own DEFAULT — so the audit row never
  // records a move away from `undefined`.
  const before = {
    label: mailbox.label,
    is_default: mailbox.is_default,
    active: mailbox.active,
    surface: mailbox.surface || MAILBOX_SURFACES[0],
  }

  const patch = { updated_at: new Date().toISOString() }

  if (body.label !== undefined) {
    const label = normalizeMailboxLabel(body.label)
    if (!label) {
      return NextResponse.json({ success: false, error: 'Give the account a short label — it names the tab staff click.' }, { status: 400 })
    }
    if (label.length > MAILBOX_LABEL_MAX) {
      return NextResponse.json({ success: false, error: `Labels are at most ${MAILBOX_LABEL_MAX} characters.` }, { status: 400 })
    }
    patch.label = label
  }

  // Deactivating clears is_default (see deactivationPatch): a hidden,
  // undeliverable address must not stay flagged as the studio's default.
  // Applied BEFORE the is_default branch so an explicit is_default:true in the
  // same request wins for `active: true` and is refused below for `false`.
  if (body.active !== undefined) Object.assign(patch, deactivationPatch(body.active))

  const willBeActive = body.active !== undefined ? body.active : before.active

  if (body.is_default === true) {
    if (!willBeActive) {
      return NextResponse.json({
        success: false,
        error: 'A deactivated account cannot be the default — reactivate it first.',
      }, { status: 400 })
    }
    // Clear the incumbent before setting ours; the partial unique index
    // allows exactly one is_default per location.
    const { error: clearErr } = await db.from('email_mailboxes')
      .update({ is_default: false, updated_at: patch.updated_at })
      .eq('location_id', params.id)
      .eq('is_default', true)
    if (clearErr) {
      return NextResponse.json(
        { success: false, error: `Could not clear the existing default account: ${clearErr.message}` },
        { status: 500 }
      )
    }
    patch.is_default = true
  } else if (body.is_default === false) {
    patch.is_default = false
  }

  // INBOX-SURFACE.C — no interaction with any of the branches above, and that
  // is deliberate. A moved account keeps its label, its default flag, its
  // grants and its whole ticket history; only the queue that LISTS it changes.
  // Deactivated accounts may be moved too: the panel stays reachable for one
  // (see the card), and refusing here would strand a deactivated account on
  // whichever surface it happened to be on.
  if (body.surface !== undefined) patch.surface = body.surface

  const { error: updateErr } = await db.from('email_mailboxes')
    .update(patch)
    .eq('id', params.mailboxId)
    .eq('location_id', params.id)
  if (updateErr) {
    const friendly = mailboxConstraintMessage(updateErr)
    if (friendly) return NextResponse.json({ success: false, error: friendly }, { status: 409 })
    return NextResponse.json({ success: false, error: updateErr.message }, { status: 500 })
  }

  const after = await loadMailboxOr404(db, params.id, params.mailboxId)

  await logAuditEvent({
    category: 'mutation',
    // Deactivation is its own action so it is greppable in /admin/audit-log —
    // it is the change that makes a studio's mail stop arriving.
    // A surface move outranks a plain update for the same reason deactivation
    // does — it is the change that makes a studio's mail appear somewhere else
    // — but NOT deactivation, which stops mail arriving at all and is the more
    // serious of the two if somebody manages to do both in one request.
    action: body.active === false
      ? 'email_mailbox.deactivated'
      : (patch.surface !== undefined && patch.surface !== before.surface
        ? 'email_mailbox.surface_changed'
        : 'email_mailbox.updated'),
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { label: `${before.label} <${mailbox.address}>`, resource: `email_mailbox/${params.mailboxId}` },
    locationId: params.id,
    details: {
      address: mailbox.address,
      before,
      after: {
        label: patch.label ?? before.label,
        is_default: patch.is_default ?? before.is_default,
        active: patch.active ?? before.active,
        surface: patch.surface ?? before.surface,
      },
    },
    request,
  })

  return NextResponse.json({ success: true, data: { mailbox: after.mailbox || null } })
}
