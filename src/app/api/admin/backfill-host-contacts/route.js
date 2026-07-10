// POST /api/admin/backfill-host-contacts
//
// HOST-EMAIL.1 — one-shot population of host_contacts from EXISTING host
// events' confirmed registrations. The confirm-time hooks (race-payments free
// + webhook paths, the operator manual-add) keep the list fresh going forward;
// this fills it for registrations confirmed before the feature shipped.
// Master/owner only. Idempotent — the underlying upsert ignores duplicates,
// so re-running is always safe. Returns per-event counts.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { addEventAttendeesToHostList } from '@/lib/host-contact-list'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PAGE = 1000

export async function POST() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!['master', 'owner'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()

  // Every hosted event (host_id NOT NULL), range-paginated past the 1k cap.
  const events = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('race_events')
      .select('id, name, host_id')
      .not('host_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
    events.push(...(data || []))
    if (!data || data.length < PAGE) break
  }

  const results = []
  let total = 0
  for (const ev of events) {
    try {
      const contacts = await addEventAttendeesToHostList(db, ev.id)
      total += contacts
      results.push({ event_id: ev.id, name: ev.name, host_id: ev.host_id, contacts })
    } catch (e) {
      results.push({ event_id: ev.id, name: ev.name, host_id: ev.host_id, error: e.message })
    }
  }

  return NextResponse.json({ success: true, data: { events: results, total } })
}
