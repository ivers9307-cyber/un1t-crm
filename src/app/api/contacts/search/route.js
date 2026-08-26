import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, orgScopeLocationIds } from '@/lib/api-auth'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { applyAudienceFilterAsync, InvalidAudienceFilterError } from '@/lib/audience-filter'
import { audienceFilterSchema } from '@/lib/schemas'
import { crossoverContactIds, fetchCrossoverContext, fetchListMembershipFlags } from '@/lib/contact-crossovers'
import { attachLinkedCounts } from '@/lib/person-links'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PostgREST .or() filter syntax uses commas as separators and
// parens for grouping. A search token containing those characters
// would break parsing. Strip them out — they have no business in
// a name / email / phone substring search anyway.
function escapePostgrestOr(s) {
  return String(s || '').replace(/[(),]/g, '')
}

// GET /api/contacts/search?term=email@example.com&fields=email
// Replaces Pipedrive GET /v1/persons/search
export async function GET(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(request.url)
  const term = searchParams.get('term') || ''
  const fields = searchParams.get('fields') || 'email'
  const limit = parseInt(searchParams.get('limit') || '10')
  const db = createServerClient()

  let query = db.from('contacts').select('*')

  const locationId = searchParams.get('location_id')
  if (locationId) query = query.eq('location_id', locationId)
  // APIKEYS.3 — per-org key: restrict to the org's locations.
  const orgLocs = await orgScopeLocationIds(db, auth.orgId)
  if (orgLocs) query = query.in('location_id', orgLocs)

  if (fields === 'email') {
    query = query.ilike('email', `%${term}%`)
  } else {
    query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`)
  }

  const { data, error } = await query.limit(limit)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Match Pipedrive's response shape so n8n code nodes need minimal changes
  return NextResponse.json({
    success: true,
    data: {
      items: (data || []).map(item => ({ item }))
    }
  })
}

// POST /api/contacts/search
//
// Cookie-auth richer search used by the /contacts page advanced
// filter UI. Body: { filter, search, limit, offset, location_id }.
// Reuses applyAudienceFilter so the same field/op allowlist + safety
// guarantees apply that campaigns / broadcasts get.
//
// Returns the page slice + total matched count so the table can
// render and the operator can see how many rows the criteria match.
const SearchBody = z.object({
  filter: audienceFilterSchema,
  search: z.string().max(200).optional(),
  // Loose validation: any string or null. We DON'T constrain to
  // UUID format here because:
  //   1. zod v4's deprecated z.string().uuid() chain was returning
  //      "Invalid input" as the error message — operator-confusing.
  //   2. locationId always comes from user.activeLocation.id which
  //      is itself a UUID from the locations table.
  //   3. assertLocationAccess() further down enforces auth + bad-
  //      string Supabase queries fail with their own clear errors.
  // So the only thing this schema needs to do is accept the keys
  // without choking on shape.
  location_id: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
  // Opt-in: fold in "crossover" deal-holders (contacts owned by another
  // studio that have a deal at this one). Only the /contacts list wants
  // them — the unified-send people-picker (ContactMultiSelect) shares
  // this route and must stay strictly owned-only, so the union is OFF by
  // default and the list opts in explicitly. Send safety doesn't depend
  // on this (the send path re-scopes by location_id) — this just keeps
  // crossovers from appearing in the picker's type-ahead.
  include_crossovers: z.boolean().optional(),
  // CONTACT-DEDUP (mig 334): lookup callers (the /contacts list) set this to
  // fold each linked person down to ONE row (the group primary). Reach callers
  // (the send people-picker) omit it so every account/channel stays visible.
  primary_only: z.boolean().optional(),
})

export async function POST(request) {
  try {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const validation = await validateBody(request, SearchBody, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const parsed = { data: validation.data }

  const locationId = parsed.data.location_id || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const limit = parsed.data.limit ?? 100
  const offset = parsed.data.offset ?? 0

  const db = createServerClient()
  // Two queries — one for the page slice, one for the total count.
  // The count uses head:true so Postgres returns the count without
  // shipping rows back. Both share the same WHERE so the count
  // reflects what the operator actually sees.
  //
  // CHAIN-ORDER NOTE: Supabase JS v2 has separate builder types —
  // PostgrestFilterBuilder (returned from .select/.eq/.or — has
  // .eq, .gt, .ilike, etc.) and PostgrestTransformBuilder (returned
  // from .order/.range — drops the filter methods). Once .order or
  // .range is in the chain, calling .eq on the result throws
  // "TypeError: e.eq is not a function". So we apply filters FIRST,
  // then layer the modifiers at the end. Earlier version of this
  // route built .order().range() up front and crashed any time an
  // audience filter was set.
  // PERF.2 — narrowed from select('*') to the same explicit field
  // set that /contacts page.js uses for the no-filter path, so
  // ContactsView gets a stable shape whichever code path it took.
  // Keep this list in lock-step with `CONTACT_LIST_FIELDS` in
  // src/app/contacts/page.js.
  const CONTACT_LIST_FIELDS = 'id, name, email, phone, lead_source, pipeline_stage_slug, trial_credits_remaining, created_at, location_id, glofox_membership_status, person_group_id'
  // Crossovers are opt-in (see schema) — default OFF so shared callers
  // such as the send people-picker stay owned-only.
  const wantCrossovers = parsed.data.include_crossovers === true
  const crossIds = wantCrossovers ? await crossoverContactIds(db, locationId) : []
  const applyLoc = (q) => crossIds.length > 0
    ? q.or(`location_id.eq.${locationId},id.in.(${crossIds.join(',')})`)
    : q.eq('location_id', locationId)
  let listQuery = applyLoc(db.from('contacts').select(CONTACT_LIST_FIELDS))
  let countQuery = applyLoc(db.from('contacts').select('id', { count: 'exact', head: true }))

  // CONTACT-DEDUP — lookup callers fold each linked person to one row (the
  // group primary). Applied before order/range so the filter methods remain
  // available. Reach callers leave primary_only unset → every account shown.
  if (parsed.data.primary_only === true) {
    listQuery = listQuery.eq('is_primary_contact', true)
    countQuery = countQuery.eq('is_primary_contact', true)
  }

  // Free-text search applies on top of the audience filter — separate
  // substring match, not part of the filter schema. Both queries get it.
  //
  // SEARCH.1 (2026-05-13): widened from name/email-only to include
  // first_name, last_name, phone. Each whitespace-separated token in
  // the search string must match at least one of the columns
  // independently, so "smith dean" matches "Dean Smith" (different
  // word order). Phone search digit-normalises both sides so
  // "0871234567" matches a stored "+353 87 123 4567".
  if (parsed.data.search?.trim()) {
    const raw = parsed.data.search.trim()
    const tokens = raw.split(/\s+/).filter(Boolean)
    for (const token of tokens) {
      const orClauses = [
        `name.ilike.%${escapePostgrestOr(token)}%`,
        `email.ilike.%${escapePostgrestOr(token)}%`,
        `first_name.ilike.%${escapePostgrestOr(token)}%`,
        `last_name.ilike.%${escapePostgrestOr(token)}%`,
      ]
      // Phone match: only fire when the token has digits. Strip
      // non-digits from both the token and the comparison side via a
      // raw regexp_replace expression — neat trick that lets a stored
      // "+353 87 123 4567" match a typed "0871234567" or "871234567".
      const digits = token.replace(/\D/g, '')
      if (digits.length >= 4) {
        // PostgREST .or() uses commas as separators and parentheses
        // for grouping. Inject a custom raw filter via the lower-level
        // `phone.ilike.*digits*` — cheaper than a full regex eval and
        // matches the common formatting variations.
        orClauses.push(`phone.ilike.%${digits}%`)
      }
      const orStr = orClauses.join(',')
      listQuery = listQuery.or(orStr)
      countQuery = countQuery.or(orStr)
    }
  }

  try {
    // Async path supports the new `tag` field (Phase 3 — mig 085).
    // Destructure the wrapped { query } return — see resolveTagFilters
    // header in audience-filter.js for the thenable-unwrap reason.
    ;({ query: listQuery } = await applyAudienceFilterAsync({ db, query: listQuery, filter: parsed.data.filter, locationId }))
    ;({ query: countQuery } = await applyAudienceFilterAsync({ db, query: countQuery, filter: parsed.data.filter, locationId }))
  } catch (e) {
    if (e instanceof InvalidAudienceFilterError) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 })
    }
    throw e
  }

  // Modifiers (order + range) go LAST so the filter-builder methods
  // remained available throughout the chain above. Only listQuery
  // pages — countQuery uses head:true and doesn't need either.
  listQuery = listQuery
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  const [listRes, countRes] = await Promise.all([listQuery, countQuery])

  if (listRes.error) {
    return NextResponse.json({ success: false, error: listRes.error.message }, { status: 500 })
  }
  if (countRes.error) {
    return NextResponse.json({ success: false, error: countRes.error.message }, { status: 500 })
  }

  // Annotate the deduped lookup rows with their folded-account counts (for
  // the "Linked +N" chip). Only when primary_only — reach callers don't need
  // it and shouldn't pay the extra query.
  const contacts = parsed.data.primary_only === true
    ? await attachLinkedCounts(db, listRes.data || [])
    : (listRes.data || [])

  const crossoverContext = wantCrossovers
    ? await fetchCrossoverContext(db, contacts, locationId)
    : {}
  // LISTFLAG.1 — gated on the same flag as the crossover context: the two
  // decorate the contacts LIST, and the other callers of this route (the send
  // people-picker) neither ask for them nor should pay for the queries.
  // ContactsView swaps to this route the moment the operator searches or
  // filters, so omitting it here would make the pills flicker out mid-typing.
  const listFlags = wantCrossovers
    ? await fetchListMembershipFlags(db, contacts, locationId)
    : {}
  return NextResponse.json({
    success: true,
    contacts,
    crossoverContext,
    listFlags,
    count: countRes.count ?? 0,
    limit,
    offset,
  })
  } catch (e) {
    // Surface the full stack to Vercel logs AND return a usable
    // JSON error to the client. Without this top-level catch, any
    // throw bubbles up to Next.js which returns an empty 500 body
    // — operator sees "Unexpected end of JSON input" instead of the
    // actual problem.
    console.error('[contacts.search] uncaught', e?.stack || e)
    return NextResponse.json({
      success: false,
      error: e?.message || 'Internal server error',
    }, { status: 500 })
  }
}
