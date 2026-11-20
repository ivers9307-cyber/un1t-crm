// POST /api/contacts/duplicates/detect
//
// Runs the duplicate-contact detection pipeline for a location.
// Dry-run by default; pass ?commit=true to actually upsert suggestions
// and auto-link high-confidence pairs.
//
// PERSON-LINK.2 — detection runner route.
//
// Authorization: session auth + contact_linking permission.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertLocationAccess } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { runDetection } from '@/lib/person-detect'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

const DetectBody = z.object({
  location_id: uuidLike.optional(),
})

export const runtime = 'nodejs'

// ============================================================
// POST /api/contacts/duplicates/detect
// ============================================================
// Signed in (401), then ROLESWEEP.1c's coarse pre-check (`contact_linking`
// somewhere, the same 'Forbidden' 403); judged at the body's location below.
export const POST = withAuth({
  permission: null, location: false,
  allow: (user) => hasPermissionAtAnyLocation(user, 'contact_linking'), forbiddenMessage: 'Forbidden',
}, async ({ request, user, db }) => {

  // Parse body (optional) + query string for commit flag
  const validation = await validateBody(request, DetectBody, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const body = validation.data

  const url = new URL(request.url)
  const commit = url.searchParams.get('commit') === 'true'

  // locationId: body takes precedence, fall back to active location
  const locationId = body.location_id ?? user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json(
      { success: false, error: 'location_id is required' },
      { status: 400 }
    )
  }

  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  // ROLESWEEP.1c — `contact_linking` judged at the location being scanned.
  if (!hasPermissionForLocation(user, locationId, 'contact_linking')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  let result
  try {
    result = await runDetection(db, { locationId, commit, actorId: user.id })
  } catch (e) {
    logError('person-detect', 'detection failed', { locationId, commit, err: e })
    return NextResponse.json({ success: false, error: 'Detection failed' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: result })
})
