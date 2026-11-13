// POST /api/campaigns/[id]/duplicate
//
// CAMPHIST.1 — the reuse path for a campaign that has already gone out.
//
// Until this existed the only way to reuse a campaign was `?edit=1`, which
// opens the editor on the campaign ITSELF and saves over it. That silently
// corrupts history: `campaign_recipients`, `campaign_link_clicks` and
// `email_sends` all keep pointing at a `campaigns` row whose subject and body
// are no longer what was sent, so every report built on them describes the
// wrong creative and there is no copy of the real one anywhere.
//
// `POST /api/campaigns/[id]/send` has been telling operators to "clone the
// campaign if they want to send it again" since CAMPAIGN.13. This is that
// clone.
//
// WHAT CARRIES OVER: the creative and its setup — name (prefixed), subject,
// preview text, sender fields, design_json, html_content, audience_filter,
// template, Postmark stream, and the A/B test *configuration*.
//
// WHAT DOES NOT: anything that is a record of a send. No id, no recipients
// (they hang off campaign_id, so a fresh id means a clean slate by
// construction), no counters, no sent_at / send_started_at / scheduled_at, no
// A/B outcome, no resend flags, no cancel/error state. Status is always
// 'draft', whatever the source was.
//
// Modelled on /api/sequences/[id]/clone, which solves the same problem for
// sequences and is the established shape in this repo.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { buildCampaignDuplicate } from '@/lib/campaign-duplicate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const sourceId = params?.id
  if (!sourceId || !uuidLike.safeParse(sourceId).success) {
    return NextResponse.json({ success: false, error: 'Invalid campaign id' }, { status: 400 })
  }

  const db = createServerClient()

  const { data: source, error: srcErr } = await db
    .from('campaigns')
    .select('*')
    .eq('id', sourceId)
    .single()
  if (srcErr || !source) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }

  // Service-role client: RLS does nothing here, so the tenant check is this.
  // 404 not 403, so campaign ids cannot be enumerated.
  const guard = assertLocationAccessOr404(user, source.location_id)
  if (guard) return guard

  // COMMSFIX.D.5 parity — permission is checked against the CAMPAIGN's
  // location, never the session's active one. Duplicating is a step on the way
  // to sending, so it takes the same 'email' permission the send route does.
  if (!hasPermissionForLocation(user, source.location_id, 'email')) {
    return NextResponse.json({ success: false, error: 'No email permission at this location' }, { status: 403 })
  }

  const { data: created, error: insErr } = await db
    .from('campaigns')
    .insert(buildCampaignDuplicate(source, user.id))
    .select()
    .single()

  if (insErr || !created) {
    return NextResponse.json(
      { success: false, error: insErr?.message || 'Could not duplicate campaign' },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true, data: { id: created.id, name: created.name } })
}
