// GET /api/mobile/contacts/search?q=<term>&limit=<n>
//
// ORGCONTACTS.5 (final review I4) — the phone directory's search, served from
// public.studio_contacts (mig 765: contacts joined to their contact_studios
// rows) at the active studio, on the service role. The phone used to read
// `contacts` through RLS with `location_id = L OR id IN (<crossover ids>)`,
// and the ids came capped at 100 because they travel in a GET URL; decision 2
// widened "the studio's contacts" to every relationship, which put the
// crossover count past that cap on day one (≥102 at Stillorgan, ~230 at Hatch
// Street, 25 Oct 2026), so a named person could be missing from the phone
// directory with only a server log as the signal. This route has no cap to
// hit: ONE equality filter on the studio, the same list the web page reads.
//
// The phone (mobile/lib/contacts-api.js searchContacts) falls back to its own
// RLS read with the capped ids when this route fails or refuses, so a bad
// deploy of this file degrades to the old behaviour, never to an empty list.
//
// Gated on the caller's MOBILE contacts permission at the active studio (the
// same key the directory screen checks). Returns the phone's directory columns
// (its CONTACT_SELECT) plus the stage AT this studio and the crossover flag;
// the detail screen still reads the contact row itself through RLS.
//
// Auth: Supabase JWT in the Authorization header (getCurrentUser's Bearer
// fallback) + the x-active-location header — same contract as /api/mobile/me.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasMobilePermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const MOBILE_CONTACT_SEARCH_COLUMNS =
  'id, name, first_name, last_name, email, phone, wa_phone, pipeline_stage_slug, studio_stage_slug, lead_source, tags, created_at, location_id, studio_is_crossover'
export const MOBILE_CONTACT_SEARCH_DEFAULT = 40
export const MOBILE_CONTACT_SEARCH_MAX = 100

// Commas, parentheses and % are PostgREST or()/ilike control characters.
const clean = (s) => String(s || '').replace(/[,%()]/g, '').trim()

function parseLimit(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return MOBILE_CONTACT_SEARCH_DEFAULT
  return Math.min(n, MOBILE_CONTACT_SEARCH_MAX)
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  if (!hasMobilePermission(user, 'contacts')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const url = new URL(request.url)
  const term = clean(url.searchParams.get('q'))
  const limit = parseLimit(url.searchParams.get('limit'))

  const db = createServerClient()
  // CONTACT-DEDUP (mig 334): one profile per linked person (the group primary).
  let q = db
    .from('studio_contacts')
    .select(MOBILE_CONTACT_SEARCH_COLUMNS)
    .eq('studio_location_id', locationId)
    .eq('is_primary_contact', true)
  if (term) {
    // Each token must match on its own (the web search route's rule, SEARCH.1):
    // "smith dean" finds "Dean Smith"; a token with ≥4 digits also matches the
    // phone columns.
    for (const token of term.split(/\s+/).filter(Boolean)) {
      const ors = [`name.ilike.%${token}%`, `email.ilike.%${token}%`, `first_name.ilike.%${token}%`, `last_name.ilike.%${token}%`]
      const digits = token.replace(/\D/g, '')
      if (digits.length >= 4) ors.push(`phone.ilike.%${digits}%`, `wa_phone.ilike.%${digits}%`)
      q = q.or(ors.join(','))
    }
    q = q.order('name', { ascending: true })
  } else {
    q = q.order('created_at', { ascending: false })
  }
  const { data, error } = await q.limit(limit)
  if (error) {
    logWarn('mobile-contact-search', 'studio_contacts read failed; the phone falls back to its own read', { locationId, code: error.code, message: error.message })
    return NextResponse.json({ success: false, error: 'Could not search contacts' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { contacts: data || [] } })
}
