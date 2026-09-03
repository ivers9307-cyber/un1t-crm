// GET/PUT /api/locations/[id]/email-copy
//
// K7 — read + write the per-location, recipient-facing strings on the hosted
// ("view in browser") copy of a campaign (company_settings, mig 530):
//   { view_in_browser_label, hosted_copy_note }
//
// These are customer-facing copy, which the repo requires to be
// operator-editable with a default fallback rather than hard-coded. Both
// columns are NULLABLE and NULL means "use the code-side default", so a
// location that never touches this behaves exactly as it did before. Sending
// an empty string is the documented way to go BACK to the default: it stores
// NULL rather than shipping an empty, unclickable link label.
//
// A location with no company_settings row is normal (most have never saved
// branding), so GET synthesises the defaults rather than 404ing, and PUT
// upserts. The upsert touches ONLY the two copy columns, so it can never
// clobber logo_url / favicon_url / company_name / send_quiet_hours_* on an
// existing row.
//
// Auth mirrors send-quiet-hours: any authenticated user at the location READS;
// owner + master AT THE TARGET LOCATION write. This copy goes into every
// recipient's inbox, so the write side is deliberately the narrower of the two
// role sets.
//
// MAILFIX-BRANDGATE.2 — the role is judged AT params.id, never via
// `user.role`. That field resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), while this write lands on the
// path-param location — so the old `user.role === 'owner'` check let an
// owner at studio A who is plain STAFF at studio B PUT
// /api/locations/<B>/email-copy and rewrite B's recipient-facing copy with a
// 200. Same shape and order as the #1586 branding routes / guardMailboxAdmin:
// membership first (assertLocationAccess — guardMasterOrOwner never checks
// membership, a master belongs nowhere), so an owner of a DIFFERENT studio is
// told "not one of your locations" rather than a role complaint that confirms
// the studio exists; then owner-or-master at the target. Role miss keeps this
// route's own copy over the guard's generic one.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import {
  resolveEmailCopy,
  EMAIL_COPY_COLUMNS,
  DEFAULT_EMAIL_COPY,
} from '@/lib/campaign-web-view'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Caps mirror the CHECK constraints in mig 530. `.trim()` before the length
// check so trailing whitespace cannot push an otherwise-fine label over.
const EmailCopySchema = z.object({
  view_in_browser_label: z.string().trim().max(120),
  hosted_copy_note: z.string().trim().max(400),
})

// Thin wrapper over the REAL guard, so GET's `can_edit` and PUT's gate cannot
// drift apart: the card never offers a Save the server will refuse, and never
// hides the editor from the target studio's actual owner. No second role
// predicate lives in this file.
function canEditEmailCopy(user, locationId) {
  if (!user) return false
  return guardMasterOrOwner(user, locationId) === null
}

function shape(row, canEdit) {
  const copy = resolveEmailCopy(row)
  return {
    view_in_browser_label: copy.viewInBrowserLabel,
    hosted_copy_note: copy.hostedCopyNote,
    // So the card can show "this is the default" and offer a reset without
    // re-deriving the strings client-side.
    default_view_in_browser_label: DEFAULT_EMAIL_COPY.viewInBrowserLabel,
    default_hosted_copy_note: DEFAULT_EMAIL_COPY.hostedCopyNote,
    can_edit: canEdit,
  }
}

const SELECT_COLS = `${EMAIL_COPY_COLUMNS.viewInBrowserLabel}, ${EMAIL_COPY_COLUMNS.hostedCopyNote}`

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db
    .from('company_settings')
    .select(SELECT_COLS)
    .eq('location_id', locationId)
    .limit(1)

  // No row (or a hiccup) is not an error condition — the code-side default is
  // the whole point, so a missing row cannot silently mean "no copy".
  const row = (!error && data && data[0]) || null
  return NextResponse.json({ success: true, data: shape(row, canEditEmailCopy(user, locationId)) })
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Target FIRST — the id is already on the path — then membership, then the
  // role AT THAT TARGET (see the header for why not `user.role`). Both gates
  // precede validation so a refused caller learns nothing about the schema.
  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canEditEmailCopy(user, locationId)) {
    return NextResponse.json({
      success: false,
      error: 'Only owners and masters can edit email copy.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, EmailCopySchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Empty means "back to the default", which is NULL on disk. Storing '' would
  // be a third state that renders as an invisible link label.
  const orNull = (s) => (s === '' ? null : s)

  const db = createServerClient()
  const { data, error } = await db
    .from('company_settings')
    .upsert({
      location_id: locationId,
      [EMAIL_COPY_COLUMNS.viewInBrowserLabel]: orNull(body.view_in_browser_label),
      [EMAIL_COPY_COLUMNS.hostedCopyNote]: orNull(body.hosted_copy_note),
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    }, { onConflict: 'location_id' })
    .select(SELECT_COLS)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data: shape(data, true) })
}
