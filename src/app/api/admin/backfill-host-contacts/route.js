// POST /api/admin/backfill-host-contacts
//
// HOST-EMAIL.1 — one-shot population of host_contacts from EXISTING host
// events' confirmed registrations. The confirm-time hooks (race-payments free
// + webhook paths, the operator manual-add) keep the list fresh going forward;
// this fills it for registrations confirmed before the feature shipped.
// Master/owner only. Idempotent — the underlying upsert ignores duplicates,
// so re-running is always safe. Returns per-event counts.
//
// TENANTSCOPE.1 — an owner back-fills THEIR organisation's hosts only: the
// ACTIVE studio's organisation, where the gate below judged them owner
// (whether an owner elsewhere in the organisation also qualifies is C18
// ORGROLE.1's question). A master keeps the estate-wide one-shot this was
// written as. The response names every event it touched, so an unscoped
// run also handed one tenant's owner another tenant's event names.

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

  // null = every host (a master's run); otherwise the active organisation's.
  let hostIds = null
  if (!user.isMaster) {
    const organizationId = user.activeOrganization?.id || null
    if (!organizationId) {
      return NextResponse.json({ success: false, error: 'No active organisation' }, { status: 400 })
    }
    // Hosts per organisation are a handful (1 on prod), far under one page.
    const { data: hosts, error: hostErr } = await db
      .from('event_hosts')
      .select('id')
      .eq('organization_id', organizationId)
      .order('id', { ascending: true })
      .range(0, PAGE - 1)
    if (hostErr) {
      return NextResponse.json({ success: false, error: hostErr.message }, { status: 500 })
    }
    hostIds = (hosts || []).map((h) => h.id)
    if (hostIds.length === 0) {
      return NextResponse.json({ success: true, data: { events: [], total: 0 } })
    }
  }

  // The hosted events in scope, range-paginated past the 1k cap.
  const events = []
  for (let from = 0; ; from += PAGE) {
    let query = db
      .from('race_events')
      .select('id, name, host_id')
      .not('host_id', 'is', null)
    if (hostIds) query = query.in('host_id', hostIds)
    const { data, error } = await query
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
