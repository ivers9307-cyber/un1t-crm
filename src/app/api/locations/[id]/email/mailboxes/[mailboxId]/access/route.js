// EMAIL-MAILBOX-ADMIN.1 — who may read ONE email account.
//
// PUT /api/locations/[id]/email/mailboxes/[mailboxId]/access
//   Body: { profile_id, granted }
//
// PER-MAILBOX IS THE AXIS, deliberately. The question an operator actually
// asks is "who should be able to read billing mail?", not "which accounts does
// Sarah have" — so access is edited from the account, with the studio's staff
// listed under it.
//
// One idempotent PUT rather than POST-to-grant / DELETE-to-revoke: the UI
// control is a toggle, and "set this person's access to X" is the operation
// that survives a double-click, a retry, or two operators clicking at once.
//
// Master or owner-at-location only. A MANAGER HOLDS `email_inbox` AND IS NOT
// ELEVATED, so gating this on the surface permission would let a manager grant
// themselves `accounts@` — the exact hole the per-account model exists to
// close. See ../../_helpers.js.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody, uuidLike } from '@/lib/validate'
import { logAuditEvent } from '@/lib/audit'
import {
  guardMailboxAdmin, mailboxUnauthorized, loadMailboxOr404, loadStaffAtLocation,
} from '../../_helpers'
import { isImplicitlyElevated } from '@/lib/email-mailbox-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const AccessBody = z.object({
  profile_id: uuidLike,
  granted: z.boolean(),
})

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return mailboxUnauthorized()
  const guard = guardMailboxAdmin(user, params.id)
  if (guard) return guard

  const validation = await validateBody(request, AccessBody)
  if (!validation.ok) return validation.response
  const { profile_id: profileId, granted } = validation.data

  const db = createServerClient()
  const found = await loadMailboxOr404(db, params.id, params.mailboxId)
  if (found.response) return found.response
  const mailbox = found.mailbox

  // The grantee must work at THIS studio. email_mailbox_access carries no
  // location of its own (the mailbox holds it), so without this check a grant
  // row could be minted for any profile id in the estate — a cross-tenant
  // hole opened from a legitimate operator's own screen. The same 400 answers
  // for "no such profile" and "works elsewhere", so ids stay unenumerable.
  const { staff, error: staffErr } = await loadStaffAtLocation(db, params.id)
  if (staffErr) return NextResponse.json({ success: false, error: staffErr.message }, { status: 500 })
  const person = (staff || []).find(p => p.profile_id === profileId)
  if (!person) {
    return NextResponse.json({
      success: false,
      error: 'That person is not an active staff member at this studio.',
    }, { status: 400 })
  }

  // Elevated people are elevated in CODE, not in rows. Silently no-opping
  // here is worse than refusing: an operator would toggle an owner off, see
  // nothing change, and stop trusting the screen. Say why instead. (The UI
  // shows them as always-on with no toggle; this is the backstop.)
  if (isImplicitlyElevated(person)) {
    return NextResponse.json({
      success: false,
      error: 'Owners of this studio and master admins can already read every account here, without a grant. Their access cannot be granted or revoked from this screen — change their role instead.',
    }, { status: 400 })
  }

  const { data: existing, error: existErr } = await db.from('email_mailbox_access')
    .select('mailbox_id, profile_id, granted_by, granted_at')
    .eq('mailbox_id', params.mailboxId)
    .eq('profile_id', profileId)
    .maybeSingle()
  if (existErr) return NextResponse.json({ success: false, error: existErr.message }, { status: 500 })

  // Already in the requested state — succeed without writing, and without an
  // audit row that claims something changed.
  if (granted === !!existing) {
    return NextResponse.json({ success: true, data: { granted, changed: false } })
  }

  if (granted) {
    const { error } = await db.from('email_mailbox_access')
      .insert({ mailbox_id: params.mailboxId, profile_id: profileId, granted_by: user.id })
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  } else {
    const { error } = await db.from('email_mailbox_access')
      .delete()
      .eq('mailbox_id', params.mailboxId)
      .eq('profile_id', profileId)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // AUDIT BOTH DIRECTIONS, and revoke especially: a revoke DELETES the row, so
  // without this there is no record anywhere that the person ever had access,
  // who gave it, or who took it away. granted_by preserves the grant side on
  // the row itself; only audit_events preserves the revoke.
  await logAuditEvent({
    category: 'mutation',
    action: granted ? 'email_mailbox_access.granted' : 'email_mailbox_access.revoked',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    // The target here IS a profile, so target.id is legitimate — it maps to
    // audit_events.target_profile_id (FK → profiles).
    target: {
      id: profileId,
      label: person.full_name || person.email || null,
      resource: `email_mailbox/${mailbox.id}`,
    },
    locationId: params.id,
    details: { mailbox_address: mailbox.address, mailbox_label: mailbox.label, granted },
    request,
  })

  return NextResponse.json({ success: true, data: { granted, changed: true } })
}
