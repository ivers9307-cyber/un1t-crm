// PUT /api/locations/[id]/membership-source
//
// W1.M2 — the only DIRECT writer of locations.membership_source (mig 717:
// 'none' | 'glofox' | 'un1t'; SELECT granted to authenticated, UPDATE
// withheld, so a browser or phone cannot write it). The other writer is the
// Glofox connect/disconnect flip in src/app/api/locations/[id]/integrations/
// [provider]/route.js, which moves the column through the locations update
// it already makes — owner/master only there too (a manager's credential
// save never moves it), so the gate below is the gate for the column.
//
// Gate (Style B, the send-quiet-hours / branding order): membership FIRST
// via assertLocationAccessOr404 — a detail route never confirms an id to a
// caller who is not at the studio — then owner-or-master AT THE TARGET
// (guardMasterOrOwner judges rolesByLocation[params.id], never `user.role`,
// which resolves at the caller's ACTIVE studio). A manager is refused: the
// setting decides what every membership surface at the studio shows and
// which crons and Mia tools act on it.
//
// THE REGISTRY, NOT THE CHECK, DECIDES WHAT MAY BE SELECTED. The Zod enum
// admits every CHECK value so the error for a stranger value is a plain 400,
// but a key with no registered provider (today 'un1t': admitted by mig 717
// so its module lands with no schema change) answers 400 not_available_yet
// and writes nothing. When src/lib/membership/sources/un1t.js registers in
// MEMBERSHIP_SOURCES this route accepts it with no change here.
//
// Switching to 'none' NEVER deletes a credential: the Glofox slice and its
// channel_connections row stay exactly as they are (Disconnect in the
// Integrations hub is the explicit path). The response carries
// warning: 'glofox_credentials_kept' when an active glofox registry row
// exists, so the card can say so.
//
// Every real change writes an audit_events row (fire-and-forget) naming the
// actor, the studio, from and to, and drops this instance's cached
// membershipStateForPage entry (W1.M3a). Selecting the value already set is
// a no-op 200: nothing written, nothing logged, the cache left alone.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MEMBERSHIP_SOURCES, MEMBERSHIP_SOURCE_KEYS, membershipSourceState } from '@/lib/membership/source'
import { GLOFOX_CREDENTIALS_KEPT } from '@/lib/membership/choices'
import { logMembershipSourceChange } from '@/lib/membership/audit'
import { resetMembershipStateCache } from '@/lib/membership/state-for-page'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MembershipSourceSchema = z.object({
  membership_source: z.enum(MEMBERSHIP_SOURCE_KEYS),
})

// Does an ACTIVE glofox registry row exist for this studio? A failed count
// is "unknown" and answers false here: the warning is advisory copy, and
// the switch itself never touches the row either way.
async function hasActiveGlofoxConnection(db, locationId) {
  const { count, error } = await db
    .from('channel_connections')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .eq('platform', 'glofox')
    .eq('is_active', true)
  if (error) {
    logError('membership-source', 'channel_connections count failed; warning suppressed', { locationId, err: error })
    return false
  }
  return (count || 0) > 0
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = params.id
  // Membership first (404, never a role complaint that confirms the id),
  // then the role AT THE TARGET. Both precede validation so a refused caller
  // learns nothing about the schema.
  const access = assertLocationAccessOr404(user, locationId)
  if (access) return access
  const role = guardMasterOrOwner(user, locationId)
  if (role) {
    return NextResponse.json({
      success: false,
      error: 'Only owners and masters can change the membership source.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, MembershipSourceSchema)
  if (!validation.ok) return validation.response
  const next = validation.data.membership_source

  // The registry is the gate: a CHECK value with no provider module is not
  // selectable, by Richard's decision, until that module lands.
  if (!MEMBERSHIP_SOURCES[next]) {
    return NextResponse.json({
      success: false,
      code: 'not_available_yet',
      error: `'${next}' is not available yet: its membership module has not landed. Choose another source for now.`,
    }, { status: 400 })
  }

  const db = createServerClient()
  // `id` is the primary key, so maybeSingle() is structural; null = gone
  // between the gate and now (the gate judged the user object, not the row).
  const { data: location, error: readErr } = await db
    .from('locations')
    .select('id, name, membership_source')
    .eq('id', locationId)
    .maybeSingle()
  if (readErr) {
    logError('membership-source', 'location read failed', { locationId, err: readErr })
    return NextResponse.json({ success: false, error: 'Could not read the location.' }, { status: 500 })
  }
  if (!location) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const previous = location.membership_source ?? 'none'

  if (previous !== next) {
    const { error: upErr } = await db
      .from('locations')
      .update({ membership_source: next, updated_at: new Date().toISOString() })
      .eq('id', locationId)
    if (upErr) {
      logError('membership-source', 'locations.membership_source update failed', { locationId, next, err: upErr })
      return NextResponse.json({ success: false, error: upErr.message }, { status: 400 })
    }
    // W1.M3a caches membershipStateForPage 60 s per location, per lambda
    // instance: drop this instance's entry so the gated pages it serves see
    // the new source at once. Other instances age out within the TTL.
    resetMembershipStateCache(locationId)
    await logMembershipSourceChange({ user, location, from: previous, to: next, via: 'membership-source', request })
  }

  const state = await membershipSourceState(db, locationId)
  const body = { success: true, data: { ...state, previous } }
  if (next === 'none' && await hasActiveGlofoxConnection(db, locationId)) {
    body.warning = GLOFOX_CREDENTIALS_KEPT
  }
  return NextResponse.json(body)
}
