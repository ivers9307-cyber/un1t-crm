// /api/glofox/sync-member — single-member sync (GLOFOX2.1).
//
// Master-only debug + first-mile-validation endpoint. Fetches ONE
// Glofox member by id, runs the mapping + match-or-create, and
// returns a structured response for the operator to inspect
// before any DB write.
//
// Query params:
//   member_id    required   the Glofox _id of the member to pull
//   location_id  optional   defaults to user.activeLocation
//   dry_run      optional   defaults to 'true' — set to 'false'
//                            to actually persist the change
//
// Response shape (dry_run=true):
//   {
//     ok: true,
//     dry_run: true,
//     glofox_payload: { ... raw Glofox member ... },
//     preview: {
//       action: 'create' | 'update' | 'ambiguous' | 'invalid',
//       mapped: { ... mapped CRM contact ... },
//       changes: { field: { from, to }, ... },
//       existing_id?, conflicts?, reason?
//     }
//   }
//
// Response shape (dry_run=false):
//   { ok: true, dry_run: false, action, contact_id, mapped, changes }
//
// On the ambiguous path we NEVER write — operator has to merge
// the two CRM contacts manually first then re-run.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { glofoxFetch, glofoxCredentialsForLocation } from '@/lib/glofox'
import { previewMemberSync, applyMemberSync } from '@/lib/glofox-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  const url = new URL(request.url)
  const memberId = (url.searchParams.get('member_id') || '').trim()
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id || null
  // Dry-run defaults to true — explicit ?dry_run=false to persist.
  const dryRun = url.searchParams.get('dry_run') !== 'false'

  if (!memberId) {
    return NextResponse.json({ ok: false, error: 'Provide ?member_id=<glofox _id>' }, { status: 400 })
  }
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({
      ok: false,
      error: 'Provide ?location_id=<uuid> or set an active location',
    }, { status: 400 })
  }

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json({
      ok: false,
      error: 'Glofox credentials not configured for this location. Set them in Settings → Locations → Glofox Integration.',
    }, { status: 400 })
  }

  // Fetch the member from Glofox. Endpoint per the docs:
  //   GET /2.0/members/{member_id}
  let glofoxRes, glofoxBody
  try {
    glofoxRes = await glofoxFetch(creds, `/2.0/members/${encodeURIComponent(memberId)}`)
    try { glofoxBody = await glofoxRes.json() } catch { glofoxBody = null }
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: `Glofox API call failed: ${e?.message || 'network error'}`,
    }, { status: 502 })
  }

  if (!glofoxRes.ok) {
    return NextResponse.json({
      ok: false,
      glofox_status: glofoxRes.status,
      error: glofoxBody?.error || glofoxBody?.message || `Glofox returned HTTP ${glofoxRes.status}`,
      glofox_body: glofoxBody,
    }, { status: 502 })
  }

  // Glofox responses commonly wrap the entity under `data`. Try
  // both shapes so we don't fail on a vendor change.
  const member = glofoxBody?.data || glofoxBody?.member || glofoxBody

  if (dryRun) {
    // GLOFOX2.1.11 — pass creds so previewMemberSync can build the
    // Plan A context (credits + parent memberships) and detect
    // credit_member reliably.
    const preview = await previewMemberSync(db, locationId, member, { creds })
    return NextResponse.json({
      ok: true,
      dry_run: true,
      location_id: locationId,
      glofox_payload: member,
      preview,
      hint: preview.action === 'ambiguous'
        ? 'Two CRM contacts conflict. Manually merge them in the CRM, then re-run.'
        : preview.action === 'invalid'
        ? 'The Glofox payload did not contain an _id. Cannot sync.'
        : 'Preview only. Re-run with &dry_run=false to apply this change.',
    })
  }

  const applied = await applyMemberSync(db, locationId, member, { creds })
  return NextResponse.json({
    ok: applied.action !== 'ambiguous' && applied.action !== 'invalid' && !applied.error,
    dry_run: false,
    location_id: locationId,
    ...applied,
  })
}
