// GET/PUT /api/locations/[id]/email-spam-filter
//
// MAIL-SPAM.1 — read + write the per-location inbound spam filter
// (company_settings.email_spam_filter_enabled / email_spam_threshold, mig 584):
//   { enabled: true, threshold: 5.0 }
//
// WHAT IT DRIVES: the inbound webhook quarantines a message whose SpamAssassin
// score (Postmark's SpamScore) is AT OR ABOVE this threshold — the ticket is
// created but flagged, nobody is pushed, nothing lights the badge, and it
// shows only on the Spam view until an operator says otherwise or the 30-day
// purge removes it. See src/lib/email-spam.js for the fail-open rules.
//
// A location with no company_settings row is normal (most have never saved
// branding), so GET synthesises the defaults rather than 404ing, and PUT
// upserts. The upsert touches ONLY the two spam columns, so it can never
// clobber logo_url / favicon_url / company_name — or the quiet-hours and
// email-copy settings that share the row.
//
// Auth mirrors send-quiet-hours exactly: any authenticated user at the
// location READS; owner + master AT THE TARGET LOCATION write.
//
// THE ROLE IS JUDGED AT params.id, NEVER VIA `user.role` (MAILFIX-BRANDGATE.2).
// `user.role` resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), while this write lands on the
// path-param location — so a manager at studio A who is plain STAFF at studio
// B would otherwise PUT /api/locations/<B>/email-spam-filter and change what
// B's inbox quarantines, with a 200. Order: membership first
// (assertLocationAccess — guardMasterOrOwner never checks membership, a
// master belongs nowhere), so an owner of a DIFFERENT studio is told "not one
// of your locations" rather than a role complaint that confirms the studio
// exists; then owner-or-master at the target.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import {
  normalizeSpamSettings,
  SPAM_SETTINGS_COLUMNS,
  DEFAULT_EMAIL_SPAM_THRESHOLD,
  SPAM_THRESHOLD_MIN,
  SPAM_THRESHOLD_MAX,
} from '@/lib/email-spam'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SpamFilterSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().min(SPAM_THRESHOLD_MIN).max(SPAM_THRESHOLD_MAX),
})

// Thin wrapper over the REAL guard, so GET's `can_edit` and PUT's gate cannot
// drift apart: the card never offers a Save the server will refuse, and never
// hides the editor from the target studio's actual owner.
function canEditSpamFilter(user, locationId) {
  if (!user) return false
  return guardMasterOrOwner(user, locationId) === null
}

function shape(row, canEdit) {
  const cfg = normalizeSpamSettings(row)
  return {
    enabled: cfg.enabled,
    threshold: cfg.threshold,
    default_threshold: DEFAULT_EMAIL_SPAM_THRESHOLD,
    can_edit: canEdit,
  }
}

const SELECT_COLS = `${SPAM_SETTINGS_COLUMNS.enabled}, ${SPAM_SETTINGS_COLUMNS.threshold}`

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

  // No row (or a hiccup) is not an error condition — the code-side default in
  // email-spam.js is the whole point, so a missing row cannot silently mean
  // "no filter".
  const row = (!error && data && data[0]) || null
  return NextResponse.json({ success: true, data: shape(row, canEditSpamFilter(user, locationId)) })
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
  if (!canEditSpamFilter(user, locationId)) {
    return NextResponse.json({
      success: false,
      error: 'Only owners and masters can edit the spam filter.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, SpamFilterSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data, error } = await db
    .from('company_settings')
    .upsert({
      location_id: locationId,
      [SPAM_SETTINGS_COLUMNS.enabled]: body.enabled,
      [SPAM_SETTINGS_COLUMNS.threshold]: body.threshold,
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    }, { onConflict: 'location_id' })
    .select(SELECT_COLS)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data: shape(data, true) })
}
