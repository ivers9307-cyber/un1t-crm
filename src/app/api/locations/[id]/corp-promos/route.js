// WAYSIN.4 — GET/POST /api/locations/[id]/corp-promos: the studio's corporate
// and partner promos (public.corp_promos, mig 816), edited at /settings/promos.
//
//   GET [?live=1] → { promos: Row[], can_edit, platform, public_path }
//   POST { key, name, credits, expires_in_days, live?, tag, lead_source?,
//          glofox_membership_id?, glofox_plan_code?, glofox_plan_name? } → 201 { promo }
//
// Gate: membership first (another studio is a 404, never a 403 that confirms
// it exists), then manager+ AT this studio to read, owner or master AT this
// studio to create (guardMasterOrOwner). The row's platform is the studio's
// membership_source: a Glofox studio's promo must carry its plan binding
// (glofox_plan_missing), a un1t.online studio's never does, and a studio on
// neither cannot run a promo (no_platform). The key is unique per studio and
// immutable after this create.
//
// The rows carry the Glofox plan ids. That is fine for this route (manager+
// staff, the editor needs them) but no CLIENT module may import the readers
// (tests/corp-promos-client-safe.test.js).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, corpPromoCreateSchema } from '@/lib/schemas'
import { listCorpPromos, promoView, CORP_PROMO_COLUMNS } from '@/lib/corp-promos-db'
import { studioPublicPath } from '@/lib/landing-pages'
import { logWarn } from '@/lib/log'
import { promoPlatformFor, judgeGlofoxBinding } from '@/lib/corp-promos-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (status, error, extra = {}) => NextResponse.json({ success: false, error, ...extra }, { status })

async function readStudio(db, locationId) {
  const { data, error } = await db
    .from('locations')
    .select('id, membership_source')
    .eq('id', locationId)
    .maybeSingle()                       // primary key; 0 rows = not found
  return { location: data, error }
}

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorized')
  const { id: locationId } = await params
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) return fail(403, 'Managers and above can see promos.')

  const liveOnly = new URL(request.url).searchParams.get('live') === '1'
  const db = createServerClient()
  const { location, error } = await readStudio(db, locationId)
  if (error) return fail(500, 'Could not read the studio')
  if (!location) return fail(404, 'Not found')

  const listed = await listCorpPromos(db, { locationId, liveOnly })
  if (!listed.ok) return fail(500, 'Could not read the promos')

  // Only the claim-link preview: a failed read shows no path, never fails the list.
  let publicPath = null
  try {
    publicPath = await studioPublicPath(db, locationId)
  } catch (err) {
    logWarn('corp-promos', 'studio public path unreadable', { err, locationId })
  }

  return NextResponse.json({
    success: true,
    data: {
      promos: listed.promos,
      can_edit: guardMasterOrOwner(user, locationId) === null,
      platform: promoPlatformFor(location.membership_source),
      public_path: publicPath,
    },
  })
}

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorized')
  const { id: locationId } = await params
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (guardMasterOrOwner(user, locationId)) return fail(403, 'Only owners and masters can create promos.')

  const validation = await validateBody(request, corpPromoCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { location, error: locError } = await readStudio(db, locationId)
  if (locError) return fail(500, 'Could not read the studio')
  if (!location) return fail(404, 'Not found')
  const platform = promoPlatformFor(location.membership_source)
  if (!platform) return fail(409, 'This studio has no membership platform, so it cannot grant promo credits.', { code: 'no_platform' })

  const binding = judgeGlofoxBinding(platform, body)
  if (!binding.ok) return fail(binding.status, binding.error, { code: binding.code })

  const row = {
    location_id: locationId,
    key: body.key,
    name: body.name,
    platform,
    credits: body.credits,
    expires_in_days: body.expires_in_days,
    live: body.live === true,
    tag: body.tag,
    lead_source: body.lead_source || 'corp_promo',
    ...binding.glofox,
    created_by: user.id || null,
  }
  const { data, error } = await db.from('corp_promos').insert(row).select(CORP_PROMO_COLUMNS).single()
  if (error) {
    if (error.code === '23505') return fail(409, 'This studio already has a promo with that key.', { code: 'key_taken' })
    return fail(500, 'Could not create the promo')
  }
  return NextResponse.json({ success: true, data: { promo: promoView(data) } }, { status: 201 })
}
