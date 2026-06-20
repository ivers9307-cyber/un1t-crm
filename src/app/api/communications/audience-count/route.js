// PILLAR2 Phase 1 — live "how many contacts match" count for the unified send
// surface. Single-table count on contacts (the campaigns count pattern —
// head:true returns the TRUE count, uncapped). Deliberately channel-agnostic:
// it counts contacts matching the audience filter at the location; the actual
// per-channel consent + reachability gates apply at send time (the send result
// reports the real recipient count). Avoids the brittle embedded-resource
// count-under-inner-join (see CLAUDE.md PostgREST lesson).
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { applyAudienceFilterAsync } from '@/lib/audience-filter'

export const runtime = 'nodejs'

const Schema = z.object({
  location_id: uuidLike,
  audience_filter: z.unknown().optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { location_id, audience_filter } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  const db = createServerClient()
  try {
    // Count on the FIRST .select() (postgrest-js only reads head/count there).
    const baseQuery = db.from('contacts').select('id', { count: 'exact', head: true }).eq('location_id', location_id)
    // Async path resolves virtual fields (event_registration + tag) into the
    // contacts.id constraint before counting — the sync filter silently skips them.
    const { query } = await applyAudienceFilterAsync({
      db,
      query: baseQuery,
      filter: audience_filter || { logic: 'and', filters: [] },
      locationId: location_id,
    })
    const { count, error } = await query
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    return NextResponse.json({ success: true, count: count || 0 })
  } catch (e) {
    // applyAudienceFilter throws InvalidAudienceFilterError on a non-whitelisted
    // (field, op) — surface it as a 400 rather than a 500.
    return NextResponse.json({ success: false, error: e?.message || 'Could not count audience' }, { status: 400 })
  }
}
