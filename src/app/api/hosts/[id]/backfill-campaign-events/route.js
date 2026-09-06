// POST /api/hosts/[id]/backfill-campaign-events?dry=0
//
// HOST-METRICS.1 — one-off + repair backfill of Postmark delivery/open/click/
// bounce/unsubscribe events onto this host's host_campaign_sends rows (mig
// 590 columns), for sends that predate those columns or whose webhook events
// were missed. Dry-run by default (counts only, writes nothing) — an
// operator must explicitly pass ?dry=0 to persist anything. Manager+,
// org-scoped like the rest of /api/hosts/[id] — 404 on a cross-org id, no
// IDOR enumeration.
//
// Window: Postmark retains outbound message history for 45 days, so this
// always asks for [today - 45 days, tomorrow] — wide enough to cover the
// whole retained tail without an operator having to pick dates.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { loadHostForOrg } from '@/lib/hosts'
import { backfillHostCampaignEvents } from '@/lib/host-campaign-backfill'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RETENTION_DAYS = 45

async function gate() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return { error: NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 }) }
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return { error: NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 }) }
  return { user, orgId }
}

function ymd(date) {
  return date.toISOString().slice(0, 10)
}

export async function POST(request, props) {
  const params = await props.params
  const g = await gate()
  if (g.error) return g.error

  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, g.orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })

  // A plain Request works here too — only the origin+searchParams are read.
  const dry = new URL(request.url).searchParams.get('dry') !== '0'

  const now = Date.now()
  const fromDate = ymd(new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000))
  const toDate = ymd(new Date(now + 24 * 60 * 60 * 1000))

  const summary = await backfillHostCampaignEvents(db, { hostId: host.id, dry, fromDate, toDate })
  return NextResponse.json({ success: true, data: summary })
}
