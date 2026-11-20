// GET /api/locations/[id]/glofox-memberships
//
// Returns the membership catalog (Membership + plans[]) at this
// location's Glofox studio. Powers the LocationForm trial-
// membership picker (GLOFOX3.1) so the operator can choose which
// membership + plan to attach to freshly-created Glofox accounts.
//
// Auth (TRAINERSROLE.1): master, or owner/manager AT THIS LOCATION
// (ADMIN_ROLES). Membership first (404), then the role judged at the PATH id
// with hasRoleAtLocation, never `user.role` (the ACTIVE studio's role). Same
// gate as /glofox-trainers and /unifi-users. withAuth's 'param' mode runs the
// same two checks in the same order with the same texts (404 'Not found', then
// ADMIN_ROLES at the path id, 403 'forbidden'); a signed-out call is its 401.

import { NextResponse } from 'next/server'
import { GLOFOX_SETTINGS_UNREADABLE, GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'
import { withAuth } from '@/lib/with-auth'
import { logWarn } from '@/lib/log'
import { ADMIN_ROLES } from '@/lib/schemas'
import { glofoxCredentialsForLocation, listGlofoxMemberships } from '@/lib/glofox'
import { learnedPrivateMemberships } from '@/lib/glofox-catalog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth({ permission: null, location: 'param', roles: ADMIN_ROLES, forbiddenMessage: 'forbidden' }, async ({ db, locationId }) => {
  const creds = await glofoxCredentialsForLocation(db, locationId)
  // REGISTRYREAD.1b: a failed settings read is not "not configured".
  if (creds.readError) {
    return NextResponse.json({ success: false, error: GLOFOX_SETTINGS_UNREADABLE, message: GLOFOX_SETTINGS_UNREADABLE_MESSAGE }, { status: 503 })
  }
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json({
      success: false, error: 'glofox_not_configured',
      message: 'Set Glofox host + api_key + api_token on this location first.',
    }, { status: 400 })
  }

  const result = await listGlofoxMemberships(creds)
  if (!result.ok) {
    logWarn('glofox-memberships', 'membership list failed', { locationId, err: result.error })
    return NextResponse.json({
      success: false, error: 'glofox_request_failed',
      message: 'Could not load the memberships from Glofox. Try again.',
    }, { status: 502 })
  }
  // GLOFOXPRIVATE.1 — Glofox's list returns only public memberships; the ones
  // the sync learned by id (mig 796, private) are appended, minus any the list
  // now returns. A failed read of the learned rows still answers the live list
  // and says so (private_unread), so the picker never looks complete when it
  // is not.
  const live = result.memberships.map(m => ({ ...m, private: false }))
  const learned = await learnedPrivateMemberships(db, locationId, new Set(live.map(m => m._id)))
  const memberships = [...live, ...learned.rows]
  return NextResponse.json({
    success: true,
    memberships,
    count: memberships.length,
    ...(learned.error ? { private_unread: true } : {}),
  })
})
