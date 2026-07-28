// GET /api/host/emails/audiences — the audience options for the host email
// composer (HOST-EMAIL.4): the whole contact list, plus one option per host
// event that has confirmed attendees (count = DISTINCT linked contacts, the
// same population the send-time resolver targets — before the per-contact
// consent/suppression gates, which only apply at send).
// Tenancy: getCurrentHost(); events .eq('host_id', session.host.id).

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PAGE = 1000 // supabase-js select cap — paginate the registrations scan

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()

  const { count: allCount } = await db
    .from('host_contacts')
    .select('*', { count: 'exact', head: true })
    .eq('host_id', session.host.id)

  const { data: events, error } = await db
    .from('race_events')
    .select('id, name, race_date')
    .eq('host_id', session.host.id)
    .order('race_date', { ascending: false })
    .limit(100)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const eventOptions = []
  for (const ev of events || []) {
    const contactIds = new Set()
    for (let from = 0; ; from += PAGE) {
      const { data, error: regErr } = await db
        .from('race_registrations')
        .select('id, teams:team_id ( team_members ( contact_id ) )')
        .eq('race_event_id', ev.id)
        .eq('status', 'confirmed')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (regErr) break
      for (const reg of data || []) {
        const members = Array.isArray(reg?.teams?.team_members) ? reg.teams.team_members : []
        for (const m of members) {
          if (m?.contact_id) contactIds.add(m.contact_id)
        }
      }
      if (!data || data.length < PAGE) break
    }
    // Every event lists — including brand-new ones with no confirmed
    // attendees yet (count 0), so the host can see the option exists; the
    // send gate still 409s a zero-recipient send.
    eventOptions.push({ id: ev.id, name: ev.name, race_date: ev.race_date, count: contactIds.size })
  }

  return NextResponse.json({
    success: true,
    data: { all_count: allCount || 0, events: eventOptions },
  })
}
