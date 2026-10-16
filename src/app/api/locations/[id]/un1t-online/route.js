// GET / PUT / DELETE /api/locations/[id]/un1t-online
//
// UN1TSYNC.7 — connect, inspect and disconnect Hatch Street's un1t.online
// token. The token is a per-studio bearer the operator creates at un1t.online
// (Settings > API tokens); it lives in the active channel_connections row
// (platform 'un1t_online') beside the studio it was issued for. The sync
// (src/lib/un1t-online-sync.js) and the membership-source provider read it from
// there.
//
// Gate on EVERY method, the membership-source route's order: getCurrentUser
// (401) -> assertLocationAccessOr404 (a detail route never confirms an id to a
// caller who is not at the studio) -> guardMasterOrOwner AT THE TARGET (a
// manager gets 403; it judges rolesByLocation[params.id], never `user.role`).
//
// PUT validates the token's SHAPE, then asks un1t.online who it is
// (GET /api-token): a refusal is 400 token_rejected, a token with allowed
// origins is a browser token that has no business in a server config (400
// browser_token), anything else upstream is 502 un1t_unreachable. Nothing is
// written on any of those. On success the active row is updated in place (or
// inserted), status reset to connected, and a studio still on membership_source
// 'none' moves to 'un1t_online' (audited, cache dropped) exactly as the Glofox
// connect does; a studio on any other source is left alone.
//
// DELETE deactivates the row and blanks the token. It never touches
// membership_source: that is the Membership source card's job.
//
// NO RESPONSE CONTAINS THE TOKEN (presentUn1tConnection picks fields; it never
// copies access_token). The `write_permissions` warning rides a connect whose
// token can change data on un1t.online: the CRM only reads, so a read-only
// token is safer.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { Un1tOnlineConnectSchema } from '@/lib/schemas'
import { createUn1tClient, Un1tAuthError } from '@/lib/un1t-online'
import { readConnection, normalizeConnectionRow } from '@/lib/connection-registry'
import { presentUn1tConnection, hasWritePermissions } from '@/lib/un1t-online-status'
import { logMembershipSourceChange } from '@/lib/membership/audit'
import { resetMembershipStateCache } from '@/lib/membership/state-for-page'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PLATFORM = 'un1t_online'
const SOURCE_KEY = 'un1t_online'
const LOG = 'un1t-online-connect'

// 401 / 404 / 403, in that order, or null when the caller may act on this studio.
async function gate(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return { refusal: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  const locationId = params.id
  const access = assertLocationAccessOr404(user, locationId)
  if (access) return { refusal: access }
  const role = guardMasterOrOwner(user, locationId)
  if (role) {
    return { refusal: NextResponse.json({ success: false, error: 'Only owners and masters can manage the un1t.online connection.' }, { status: 403 }) }
  }
  return { user, locationId }
}

export async function GET(request, props) {
  const g = await gate(props)
  if (g.refusal) return g.refusal
  const db = createServerClient()

  const { conn, error } = await readConnection(db, g.locationId, PLATFORM)
  if (error || !conn) {
    logError(LOG, 'connection read failed', { locationId: g.locationId, err: error })
    return NextResponse.json({ success: false, error: 'Could not read the connection.' }, { status: 500 })
  }

  const { data: runs, error: runErr } = await db
    .from('un1t_sync_runs')
    .select('id, started_at, finished_at, duration_ms, status, counts, first_error')
    .eq('location_id', g.locationId)
    .order('started_at', { ascending: false })
    .limit(1)
  if (runErr) {
    // The run summary is advisory: the connection itself answered.
    logError(LOG, 'last run read failed', { locationId: g.locationId, err: runErr })
  }
  const lastRun = Array.isArray(runs) ? runs[0] ?? null : null

  return NextResponse.json({ success: true, data: presentUn1tConnection(conn, lastRun) })
}

export async function PUT(request, props) {
  const g = await gate(props)
  if (g.refusal) return g.refusal
  const { user, locationId } = g

  const validation = await validateBody(request, Un1tOnlineConnectSchema)
  if (!validation.ok) return validation.response
  const { token } = validation.data

  // Who does un1t.online say this token is? Nothing is written until it answers.
  let self
  try {
    self = await createUn1tClient({ token }).getSelf()
  } catch (err) {
    if (err instanceof Un1tAuthError) {
      return NextResponse.json({
        success: false,
        code: 'token_rejected',
        error: 'un1t.online rejected that token. Check it was copied whole and has not been revoked or expired.',
      }, { status: 400 })
    }
    logError(LOG, 'un1t.online token check failed', { locationId, errName: err?.name, status: err?.status ?? null })
    return NextResponse.json({
      success: false,
      code: 'un1t_unreachable',
      error: 'Could not reach un1t.online to check that token. Try again in a minute.',
    }, { status: 502 })
  }

  if (!self?.studio?.id) {
    logError(LOG, 'un1t.online answered with no studio', { locationId })
    return NextResponse.json({
      success: false,
      code: 'un1t_unreachable',
      error: 'un1t.online did not say which studio that token belongs to.',
    }, { status: 502 })
  }
  if (Array.isArray(self.allowed_origins) && self.allowed_origins.length > 0) {
    return NextResponse.json({
      success: false,
      code: 'browser_token',
      error: 'That token is restricted to browser origins, so a server cannot use it. Create a server token with no allowed origins and paste that.',
    }, { status: 400 })
  }

  const db = createServerClient()

  // `id` is the primary key; null = gone between the gate and now.
  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, name, membership_source')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr) {
    logError(LOG, 'location read failed', { locationId, err: locErr })
    return NextResponse.json({ success: false, error: 'Could not read the location.' }, { status: 500 })
  }
  if (!location) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const permissions = Array.isArray(self.permissions) ? self.permissions : []
  const fields = {
    access_token: token,
    external_account_id: String(self.studio.id),
    display_name: self.studio.title ?? null,
    token_expires_at: self.expires_at ?? null,
    status: 'connected',
    last_error: null,
    config: {
      token_id: self.id ?? null,
      token_name: self.name ?? null,
      studio_title: self.studio.title ?? null,
      permissions,
    },
    updated_at: new Date().toISOString(),
  }

  // Select-then-write (the one-active guarantee is a PARTIAL unique index,
  // which PostgREST upsert cannot target; syncConnectionFromLegacy does the same).
  const { data: existing, error: readErr } = await db
    .from('channel_connections')
    .select('id')
    .eq('location_id', locationId)
    .eq('platform', PLATFORM)
    .eq('is_active', true)
    .maybeSingle()
  if (readErr) {
    logError(LOG, 'registry read failed', { locationId, err: readErr })
    return NextResponse.json({ success: false, error: 'Could not read the connection.' }, { status: 500 })
  }

  if (existing) {
    const { data, error } = await db
      .from('channel_connections')
      .update(fields)
      .eq('id', existing.id)
      .select('id')
    if (error || !Array.isArray(data) || data.length === 0) {
      logError(LOG, 'registry update failed', { locationId, err: error || 'no row updated' })
      return NextResponse.json({ success: false, error: 'Could not save the connection.' }, { status: 500 })
    }
  } else {
    const { data, error } = await db
      .from('channel_connections')
      .insert({ location_id: locationId, platform: PLATFORM, is_active: true, ...fields })
      .select('id')
    if (error || !Array.isArray(data) || data.length === 0) {
      logError(LOG, 'registry insert failed', { locationId, err: error || 'no row inserted' })
      return NextResponse.json({ success: false, error: 'Could not save the connection.' }, { status: 500 })
    }
  }

  // membership_source follows the connection, only off 'none' (a studio on
  // glofox, or already here, is left alone). The credential is saved either
  // way, so a failed flip is logged and reported, never a failed connect.
  let flipped = false
  const previous = location.membership_source ?? 'none'
  if (previous === 'none') {
    const { error: flipErr } = await db
      .from('locations')
      .update({ membership_source: SOURCE_KEY, updated_at: new Date().toISOString() })
      .eq('id', locationId)
    if (flipErr) {
      logError(LOG, 'locations.membership_source update failed', { locationId, err: flipErr })
    } else {
      flipped = true
      resetMembershipStateCache(locationId)
      await logMembershipSourceChange({ user, location, from: previous, to: SOURCE_KEY, via: 'integrations/un1t-online', request })
    }
  }

  const body = {
    success: true,
    data: {
      ...presentUn1tConnection(normalizeConnectionRow({
        platform: PLATFORM,
        location_id: locationId,
        is_active: true,
        ...fields,
      })),
      membership_source_set: flipped,
    },
  }
  if (hasWritePermissions(permissions)) body.warning = 'write_permissions'
  return NextResponse.json(body)
}

export async function DELETE(request, props) {
  const g = await gate(props)
  if (g.refusal) return g.refusal
  const db = createServerClient()

  const { error } = await db
    .from('channel_connections')
    .update({ is_active: false, access_token: null, status: 'not_connected', updated_at: new Date().toISOString() })
    .eq('location_id', g.locationId)
    .eq('platform', PLATFORM)
    .eq('is_active', true)
    .select('id')
  if (error) {
    logError(LOG, 'disconnect failed', { locationId: g.locationId, err: error })
    return NextResponse.json({ success: false, error: 'Could not disconnect.' }, { status: 500 })
  }
  // Zero rows is fine: already disconnected. membership_source is deliberately
  // untouched (the Membership source card owns it); the page's membership
  // state may read "unconfigured" now, so drop the cached answer.
  resetMembershipStateCache(g.locationId)
  return NextResponse.json({ success: true, data: { disconnected: true } })
}
