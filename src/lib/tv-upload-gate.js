// TVUPLOAD.1 (C93) — the TV image upload gate, shared by the signed-upload
// routes (…/upload/sign, …/upload/finalise). It is the multipart route's
// (POST /api/admin/tv-displays/upload, ROLESWEEP.1c) exactly: the web OR the
// mobile tv_displays permission somewhere (coarse), membership of the TV's
// studio, then web OR mobile tv_displays AT that studio. Same statuses and
// words, so tests/role-sweep/contact-messaging.test.js runs all three routes
// on one case table.

import { NextResponse } from 'next/server'
import { assertLocationAccess } from '@/lib/auth'
import {
  hasPermissionAtAnyLocation, hasPermissionForLocation,
  hasMobilePermissionAtAnyLocation, hasMobilePermissionForLocation,
} from '@/lib/permissions'

const NOT_AUTHORISED = () =>
  NextResponse.json({ success: false, error: 'Not authorised for TV displays' }, { status: 403 })

/** Coarse pre-check, before the body is read. */
export function tvUploadAnywhereGate(user) {
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'tv_displays') && !hasMobilePermissionAtAnyLocation(user, 'tv_displays')) return NOT_AUTHORISED()
  return null
}

/** The decision at the TV's studio. */
export function tvUploadLocationGate(user, locationId) {
  if (!locationId) return NextResponse.json({ success: false, error: 'No location.' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'tv_displays') && !hasMobilePermissionForLocation(user, locationId, 'tv_displays')) return NOT_AUTHORISED()
  return null
}
