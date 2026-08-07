// GET /api/launcher/search?q= — multi-entity ⌘K launcher search
// (FEAT-LAUNCH.2). Searches contacts, staff, and events in one round-trip.
//
// Security posture (service-role route — no RLS):
//   - session-guarded (getCurrentUser);
//   - scoped to the caller's ACTIVE location only — the location is taken
//     from the session, never from the client, so there's no IDOR vector;
//   - each entity is gated on the same permission that gates its page, so a
//     staff member without `settings` never sees staff, etc.
//
// Returns { success, results: [{ type, key, label, sublabel, href }] } —
// already shaped for the palette via the shared entityResult() mapper.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sanitizeSearchTerm, MIN_CONTACT_SEARCH_LEN, LAUNCHER_RESULT_CAP, entityResult } from '@/lib/command-palette'
import { formatShortDate } from '@/lib/dates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const term = sanitizeSearchTerm(new URL(request.url).searchParams.get('q'))
  if (term.length < MIN_CONTACT_SEARCH_LEN) return NextResponse.json({ success: true, results: [] })

  const db = createServerClient()
  const like = `%${term}%`
  const results = []
  const tasks = []

  // Contacts — one unified profile per person (is_primary_contact).
  if (hasPermission(user, 'contacts')) {
    tasks.push((async () => {
      const { data } = await db
        .from('contacts')
        .select('id, name, email, phone')
        .eq('location_id', locationId)
        .eq('is_primary_contact', true)
        .or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like}`)
        .limit(LAUNCHER_RESULT_CAP)
      for (const row of data || []) {
        const r = entityResult('contact', row)
        if (r) results.push(r)
      }
    })())
  }

  // Staff — profiles scoped to the active location via profile_locations
  // (inner join), active only. profiles has no `authenticated` grant, so this
  // has to run server-side (service role) — the whole reason for the endpoint.
  if (hasPermission(user, 'settings')) {
    tasks.push((async () => {
      const { data } = await db
        .from('profiles')
        .select('id, full_name, email, profile_locations!inner(location_id)')
        .eq('profile_locations.location_id', locationId)
        .eq('active', true)
        .or(`full_name.ilike.${like},email.ilike.${like}`)
        .limit(LAUNCHER_RESULT_CAP)
      for (const row of data || []) {
        const r = entityResult('staff', row)
        if (r) results.push(r)
      }
    })())
  }

  // Events — race_events at this location, most recent first.
  if (hasPermission(user, 'races')) {
    tasks.push((async () => {
      const { data } = await db
        .from('race_events')
        .select('id, name, race_date')
        .eq('location_id', locationId)
        // Deliberate substring search: `like` is `%${term}%` and
        // sanitizeSearchTerm() has already stripped , ( ) % * _ — so the term
        // carries neither LIKE wildcards nor the PostgREST filter separators
        // that the .or() forms above interpolate raw.
        // eslint-disable-next-line guardrails/no-unescaped-ilike-pattern -- pre-sanitised substring search, see above
        .ilike('name', like)
        .order('race_date', { ascending: false })
        .limit(LAUNCHER_RESULT_CAP)
      for (const row of data || []) {
        const r = entityResult('event', { ...row, sublabel: row.race_date ? formatShortDate(row.race_date) : '' })
        if (r) results.push(r)
      }
    })())
  }

  await Promise.all(tasks)
  return NextResponse.json({ success: true, results })
}
