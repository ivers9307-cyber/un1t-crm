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
// owner + master WRITE. This copy goes into every recipient's inbox, so the
// write side is deliberately the narrower of the two role sets.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
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

function canEditEmailCopy(user) {
  if (!user) return false
  if (user.isMaster || user.role === 'master') return true
  return user.role === 'owner'
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
  return NextResponse.json({ success: true, data: shape(row, canEditEmailCopy(user)) })
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canEditEmailCopy(user)) {
    return NextResponse.json({
      success: false,
      error: 'Only owners and masters can edit email copy.',
    }, { status: 403 })
  }

  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

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
