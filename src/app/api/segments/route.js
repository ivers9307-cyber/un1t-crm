// GET /api/segments
//
// The tag vocabulary the audience builder offers, with a live count per tag.
//
// FILTER-A.3 — this used to return ONLY the six behavioural TAG_RULES. The
// platform itself writes 32 (PLATFORM_TAGS) and sequences write arbitrary
// operator strings with no whitelist at all, so 26+ tags were untargetable
// from any UI — including the ones with real reach (glofox_first_booking 129,
// glofox_trial_credits_low 125, glofox_trial_engaged 59). The vocabulary is
// now the UNION of all three sources:
//
//   TAG_RULES ∪ PLATFORM_TAGS ∪ (distinct live tag in contact_tags)
//
// The third arm is what makes an operator's own sequence tag targetable, and
// it is the reason the counts are computed from ONE scan rather than a
// head-count per known tag: the set of tags is not known up front.
//
// FILTER-A.3 / finding #15 — counts follow the EDITOR'S location. The old
// route scoped to the operator's ACTIVE location, so composing a send for
// another gym showed tag counts describing a different one. Callers pass
// ?location_id; it falls back to the active location and is access-checked
// either way.
//
// Returns:
//   { success, data: [{ tag, description, count, inUse }] }
//
// Manager+ only.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { buildTagVocabulary, studioTagCounts } from '@/lib/studio-tag-vocabulary'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const requested = new URL(request.url).searchParams.get('location_id')
  if (requested) {
    const guard = assertLocationAccess(user, requested)
    if (guard) return guard
  }
  const locationId = requested || user.activeLocation?.id || null
  // ROLESWEEP.1a — the role is judged at the location whose tags are counted.
  if (locationId && !hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  // The union and its order live in studio-tag-vocabulary.js (shared with the
  // pipeline builder's entry-rule picker, PIPEBUILD.5f).
  const build = buildTagVocabulary

  // A master with no active location and no explicit one cannot scope the
  // counts. Return the vocabulary at zero rather than aggregating every
  // tenant's tags into one dropdown (mirrors /api/communications/events).
  if (!locationId) return NextResponse.json({ success: true, data: build(new Map()) })

  const db = createServerClient()
  // ONE scan, paginated (studioTagCounts): contact_tags at a busy location is
  // well over the PostgREST 1000-row cap and a truncated scan would UNDERCOUNT
  // silently.
  let counts
  try {
    counts = await studioTagCounts(db, locationId)
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || 'Could not read tags' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: build(counts) })
}
