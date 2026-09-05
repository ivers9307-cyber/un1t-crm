// EMAIL-MAILBOX-ADMIN.1 — edit one email account.
//
// PATCH /api/locations/[id]/email/mailboxes/[mailboxId]
//   Body: { label?, is_default?, active? }
//
// (RETIRE-TICKETS.1 — `surface` left this body when the mig-575 A/B ended:
// mig 578 deprecated the column and the Move control is gone from the card.
// The `email_mailbox.surface_changed` audit rows from the trial remain the
// greppable record of who moved what, and when.)
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
  guardMailboxAdmin, mailboxUnauthorized, loadMailboxOr404,
} from '../_helpers'
import {
  MAILBOX_LABEL_MAX,
  normalizeMailboxLabel,
  mailboxConstraintMessage,
  deactivationPatch,
} from '@/lib/email-mailbox-admin'
// MAIL-DEADLETTER.2 — reactivating an account makes it resolvable again for
// any orphan inbound dead-letter row addressed to it; stamp those the same
// way a create does. Best-effort, never the PATCH's outcome.
import { restampOrphanInboundDeadLetters } from '@/lib/webhook-dead-letter-restamp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PatchBody = z.object({
  label: z.string().min(1).max(MAILBOX_LABEL_MAX + 200).optional(),
  is_default: z.boolean().optional(),
  active: z.boolean().optional(),
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
      && body.active === undefined) {
    return NextResponse.json({ success: false, error: 'Nothing to change.' }, { status: 400 })
  }

  const db = createServerClient()
  const found = await loadMailboxOr404(db, params.id, params.mailboxId)
  if (found.response) return found.response
  const mailbox = found.mailbox
  // Snapshot the prior state by VALUE. The audit row's whole worth is the
  // before/after pair, and reading `mailbox.label` again after the UPDATE
  // would record the new value as the old one.
  const before = {
    label: mailbox.label,
    is_default: mailbox.is_default,
    active: mailbox.active,
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

  const { error: updateErr } = await db.from('email_mailboxes')
    .update(patch)
    .eq('id', params.mailboxId)
    .eq('location_id', params.id)
  if (updateErr) {
    const friendly = mailboxConstraintMessage(updateErr)
    if (friendly) return NextResponse.json({ success: false, error: friendly }, { status: 409 })
    return NextResponse.json({ success: false, error: updateErr.message }, { status: 500 })
  }

  // Only the inactive → active TRANSITION resolves new mail; a rename or a
  // default move changes nothing about which address receives, and a
  // redundant active:true on an already-active row is a no-op for the morgue.
  if (body.active === true && before.active === false) {
    try {
      await restampOrphanInboundDeadLetters(db, { reason: 'mailbox_reactivated', mailboxId: params.mailboxId })
    } catch { /* logged inside; the PATCH stands */ }
  }

  const after = await loadMailboxOr404(db, params.id, params.mailboxId)

  await logAuditEvent({
    category: 'mutation',
    // Deactivation is its own action so it is greppable in /admin/audit-log —
    // it is the change that makes a studio's mail stop arriving.
    action: body.active === false
      ? 'email_mailbox.deactivated'
      : 'email_mailbox.updated',
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
      },
    },
    request,
  })

  return NextResponse.json({ success: true, data: { mailbox: after.mailbox || null } })
}
