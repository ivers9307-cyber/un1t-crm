// GET /api/admin/integrations         master-only list of provider rows
// PATCH /api/admin/integrations/[id]   update credentials / enabled flag
//
// SAAS-6 DECISION: service_integrations stays PLATFORM-WIDE (one row
// per provider, no organization_id). Strava / Garmin / Apple are
// platform OAuth apps — one client id/secret per provider for the
// whole SaaS. Per-tenant rows would mean every gym registering its own
// developer app with each provider, which is the wrong model (and
// Strava's API ToS excludes it from SaaS resale anyway — the Strava
// integration is personal-use only, see fitness-hub notes). Master
// remains the only editor. Do NOT de-singleton this table.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Masters only (profiles.role), no studio. A signed-in non-master keeps the
// old { ok: false, error: 'Forbidden' } 403; a signed-out call is withAuth's 401.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db }) => {
  if (user.profileRole !== 'master') return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const { data, error } = await db
    .from('service_integrations')
    .select('*')
    .order('display_name', { ascending: true })
  if (error) {
    logWarn('admin-integrations', 'list failed', { err: error })
    return NextResponse.json({ ok: false, error: 'Could not load the integrations.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, integrations: data || [] })
})
