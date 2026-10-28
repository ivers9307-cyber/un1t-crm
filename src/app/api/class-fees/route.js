// FEES.1 — GET the class fees of one studio for the review page.
// ?location_id=&tab=due|outstanding|undecided|history
// Session auth + the class_fees permission at that studio.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { canUseClassFees } from '@/lib/class-fees-access'
import { readClassFeeContext, contactNames, FEE_COLUMNS } from '@/lib/class-fees-run'
import { dateKeyIn, addDaysIn, dayStartMsIn } from '@/lib/location-time'
import { uuidLike } from '@/lib/schemas'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

const TAB_STATUSES = Object.freeze({
  // FEES.3 — a dry-run preview and an appealed (held) fee sit with the due ones.
  due: ['preview', 'pending', 'charging', 'appealed'],
  outstanding: ['retry_scheduled', 'outstanding'],
  history: ['charged', 'waived', 'recorded'],
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id
  const tab = url.searchParams.get('tab') || 'due'
  if (!uuidLike.safeParse(locationId).success) return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  if (tab !== 'undecided' && !Object.hasOwn(TAB_STATUSES, tab)) return NextResponse.json({ success: false, error: 'Unknown tab' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canUseClassFees(user, locationId)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const db = createServerClient()
  try {
    const ctx = await readClassFeeContext(db, locationId)
    if (ctx.location.membershipSource !== 'un1t_online') {
      return NextResponse.json({ success: true, data: { rows: [], settings: ctx.settings, zone: ctx.zone, notUn1t: true } })
    }
    let rows
    if (tab === 'undecided') {
      rows = await readUndecided(db, locationId, ctx.zone)
    } else {
      const { data, error } = await db
        .from('class_fees')
        .select(FEE_COLUMNS)
        .eq('location_id', locationId)
        .in('status', TAB_STATUSES[tab])
        .order('starts_at', { ascending: false })
        .limit(tab === 'history' ? 200 : 500)
      if (error) throw error
      rows = data || []
    }
    const names = await contactNames(db, locationId, rows.map((r) => r.contact_id))
    rows = rows.map((r) => ({ ...r, member_name: names.get(r.contact_id) ?? null }))
    return NextResponse.json({ success: true, data: { rows, settings: ctx.settings, zone: ctx.zone } })
  } catch (err) {
    logError('class-fees', 'list failed', { locationId, tab, code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not load class fees just now.' }, { status: 500 })
  }
}

// Bookings still `booked` after their class (last 7 days): never charged
// while undecided; staff mark them in un1t.online.
async function readUndecided(db, locationId, zone) {
  const nowMs = Date.now()
  const fromMs = dayStartMsIn(addDaysIn(dateKeyIn(nowMs, zone), -6, zone), zone)
  const { data: events, error } = await db
    .from('un1t_events')
    .select('un1t_id, title, starts_at, status')
    .eq('location_id', locationId)
    .gte('starts_at', new Date(fromMs).toISOString())
    .lte('starts_at', new Date(nowMs).toISOString())
    .order('starts_at', { ascending: false })
    .limit(500)
  if (error) throw error
  const live = (events || []).filter((e) => !/^cancel/i.test(String(e.status ?? '')))
  if (!live.length) return []
  const byId = new Map(live.map((e) => [e.un1t_id, e]))
  const out = []
  for (let i = 0; i < live.length; i += 100) {
    const { data, error: bErr } = await db
      .from('un1t_bookings')
      .select('un1t_id, contact_id, event_id, status')
      .eq('location_id', locationId)
      .eq('status', 'booked')
      .in('event_id', live.slice(i, i + 100).map((e) => e.un1t_id))
      .order('un1t_id')
      .limit(500)
    if (bErr) throw bErr
    for (const b of data || []) {
      const e = byId.get(b.event_id)
      out.push({ id: b.un1t_id, contact_id: b.contact_id, class_title: e?.title ?? null, starts_at: e?.starts_at ?? null, status: 'undecided' })
    }
  }
  return out.sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)))
}
