// EMAIL-MAILBOX-ADMIN.1 — the studio's email accounts.
//
// GET  /api/locations/[id]/email/mailboxes
//   The management view: every mailbox at this location INCLUDING deactivated
//   ones (unlike the inbox, which hides them), each carrying its access list —
//   every staff member at the location tagged implicit / granted / none.
//
// POST /api/locations/[id]/email/mailboxes
//   Body: { address, label, is_default? } — add an account.
//
// Master or owner-at-location only; the reasoning is in ./_helpers.js, and it
// is the whole point of the feature (a manager holds `email_inbox` but is not
// elevated, so a manager must never reach a surface that could grant them
// `accounts@`).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { escapeLikePattern } from '@/lib/like-escape'
import { logAuditEvent } from '@/lib/audit'
import {
  MAILBOX_COLUMNS, MAILBOX_LIMIT, GRANT_LIMIT,
  guardMailboxAdmin, mailboxUnauthorized, loadStaffAtLocation,
} from './_helpers'
import {
  MAILBOX_LABEL_MAX,
  normalizeMailboxAddress,
  normalizeMailboxLabel,
  mailboxInputIssues,
  addressTakenMessage,
  mailboxConstraintMessage,
  orderMailboxAdminList,
  mailboxAccessRows,
} from '@/lib/email-mailbox-admin'
// MAILBOX-UNREACHABLE.1 — whether each address can actually receive. Resolved
// here rather than on the client because it needs DNS and a service-role read,
// and because the card is the one screen where the answer has to be present
// the first time it renders.
import { assessMailboxReachability } from '@/lib/mail/mailbox-reachability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return mailboxUnauthorized()
  const guard = guardMailboxAdmin(user, params.id)
  if (guard) return guard

  const db = createServerClient()
  const { data: mailboxes, error } = await db.from('email_mailboxes')
    .select(MAILBOX_COLUMNS)
    .eq('location_id', params.id)
    .limit(MAILBOX_LIMIT)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const { staff, error: staffErr } = await loadStaffAtLocation(db, params.id)
  if (staffErr) return NextResponse.json({ success: false, error: staffErr.message }, { status: 500 })

  const ids = (mailboxes || []).map(m => m.id)
  let grants = []
  if (ids.length > 0) {
    const { data, error: grantErr } = await db.from('email_mailbox_access')
      .select('mailbox_id, profile_id, granted_by, granted_at')
      .in('mailbox_id', ids)
      .limit(GRANT_LIMIT)
    if (grantErr) return NextResponse.json({ success: false, error: grantErr.message }, { status: 500 })
    grants = data || []
  }

  // MAILBOX-UNREACHABLE.1 — never allowed to fail the list. Managing addresses
  // and grants has to keep working when a resolver does not; an absent verdict
  // renders as nothing, which is the same thing a DNS miss renders as.
  let reachability = {}
  try {
    reachability = await assessMailboxReachability(db, params.id, mailboxes || [])
  } catch {
    reachability = {}
  }

  const shaped = orderMailboxAdminList(mailboxes || []).map(m => ({
    ...m,
    access: mailboxAccessRows({ staff, grants: grants.filter(g => g.mailbox_id === m.id) }),
    reachability: reachability[m.id] || null,
  }))

  return NextResponse.json({ success: true, data: { mailboxes: shaped, staff } })
}

// `label` is allowed past Zod well beyond the DB's 40 so the too-long case
// produces mailboxInputIssues' sentence rather than a Zod path/message blob.
const CreateBody = z.object({
  address: z.string().min(3).max(254),
  label: z.string().min(1).max(MAILBOX_LABEL_MAX + 200),
  is_default: z.boolean().optional().default(false),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return mailboxUnauthorized()
  const guard = guardMailboxAdmin(user, params.id)
  if (guard) return guard

  const validation = await validateBody(request, CreateBody)
  if (!validation.ok) return validation.response

  // Re-state every CHECK the table carries, in operator language, BEFORE
  // touching it. A raw "new row violates check constraint
  // email_mailboxes_label_len" tells an operator nothing they can act on.
  const issues = mailboxInputIssues(validation.data)
  if (issues.length > 0) {
    return NextResponse.json({ success: false, error: issues[0], issues }, { status: 400 })
  }
  const address = normalizeMailboxAddress(validation.data.address)
  const label = normalizeMailboxLabel(validation.data.label)

  const db = createServerClient()

  // THE CONFUSING ERROR, PRE-EMPTED. UNIQUE(lower(address)) is GLOBAL, so the
  // clash may be at a studio this operator cannot see, and a raw 23505 would
  // read as a bug in the form. Look it up first and explain the rule.
  //
  // ILIKE, not .eq(): rows predating this editor (mig 485's backfill copied
  // locations.email_inbox_reply_to verbatim) may be mixed-case. ILIKE is a
  // PATTERN match, so the value is escaped — an unescaped `%@un1t.ie` would
  // match the whole domain and refuse a legitimate address.
  const { data: clash, error: clashErr } = await db.from('email_mailboxes')
    .select('id, location_id, label, active')
    .ilike('address', escapeLikePattern(address))
    .limit(1)
    .maybeSingle()
  if (clashErr) return NextResponse.json({ success: false, error: clashErr.message }, { status: 500 })
  if (clash) {
    // Name the other studio only for a master. An owner being told which
    // tenant holds an address would be a cross-tenant disclosure — they get
    // the rule and "deactivating it there frees it up" instead.
    let otherLocationName = null
    if (clash.location_id !== params.id && user.profileRole === 'master') {
      const { data: loc } = await db.from('locations')
        .select('name')
        .eq('id', clash.location_id)
        .maybeSingle()
      otherLocationName = loc?.name || null
    }
    return NextResponse.json({
      success: false,
      error: addressTakenMessage({ address, existing: clash, locationId: params.id, otherLocationName }),
    }, { status: 409 })
  }

  // At most one default per location (partial unique index). Clear the
  // incumbent first or the insert is rejected. Back-to-back rather than in a
  // transaction (supabase-js exposes none): the worst case if the insert then
  // fails is "no default", which every reader already tolerates, rather than
  // two defaults, which the index forbids outright.
  if (validation.data.is_default) {
    const { error: clearErr } = await db.from('email_mailboxes')
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq('location_id', params.id)
      .eq('is_default', true)
    if (clearErr) {
      return NextResponse.json(
        { success: false, error: `Could not clear the existing default account: ${clearErr.message}` },
        { status: 500 }
      )
    }
  }

  const { data: created, error: insertErr } = await db.from('email_mailboxes')
    .insert({
      location_id: params.id,
      address,
      label,
      is_default: !!validation.data.is_default,
      active: true,
    })
    .select(MAILBOX_COLUMNS)
    .single()

  if (insertErr) {
    // Race backstop — two operators adding the same address at once.
    const friendly = mailboxConstraintMessage(insertErr)
    if (friendly) return NextResponse.json({ success: false, error: friendly }, { status: 409 })
    return NextResponse.json({ success: false, error: insertErr.message }, { status: 500 })
  }

  await logAuditEvent({
    category: 'mutation',
    action: 'email_mailbox.created',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    // No target.id: it maps to audit_events.target_profile_id (FK → profiles),
    // and a mailbox is not a profile. Identity rides in `resource`.
    target: { label: `${label} <${address}>`, resource: `email_mailbox/${created?.id}` },
    locationId: params.id,
    details: { address, label, is_default: !!validation.data.is_default },
    request,
  })

  return NextResponse.json({ success: true, data: { mailbox: created } }, { status: 201 })
}
