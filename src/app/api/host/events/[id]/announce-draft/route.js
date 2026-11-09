// POST /api/host/events/[id]/announce-draft — HOSTPORTAL.4. A DRAFT email
// about one of the host's own events, for the host's whole list, opened in the
// composer by the browser. Sends nothing: every send gate stays where it is.
// 404 for another host's event, 409 when the event is not on sale or has
// already taken place (announceBlockedReason). A second call for the same
// unchanged draft answers the first draft's id instead of piling up copies.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostEvent, loadHostToday } from '@/lib/host-portal'
import { hostEventPublicUrl } from '@/lib/host-event-url'
import { announceDraft, announceBlockedReason } from '@/lib/host-announce-draft'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const COLUMNS = 'id, host_id, name, slug, status, active, race_date, venue_name, race_waves ( start_time, label, display_order )'

export async function POST(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const event = await loadHostEvent(db, session.host.id, params.id, COLUMNS)
  if (!event) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const { today } = await loadHostToday(db, session.host)
  const blocked = announceBlockedReason(event, today)
  if (blocked) return NextResponse.json({ success: false, error: blocked }, { status: 409 })

  // The public link, built as the Promote page builds it.
  let eventUrl
  try {
    eventUrl = await hostEventPublicUrl(db, session.host.id, event.slug)
  } catch (e) {
    logWarn('host-announce-draft', 'event link unavailable', { err: e, eventId: event.id })
    return NextResponse.json({ success: false, error: 'Could not build the link to your event. Try again.' }, { status: 500 })
  }

  const sessions = [...(event.race_waves || [])]
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
    .map((w) => ({ time: String(w.start_time || '').slice(0, 5), label: String(w.label || '').trim() }))
    .filter((s) => s.time)

  const { subject, body_html } = announceDraft({ event, sessions, eventUrl })

  // Clicking twice must not pile up identical drafts: an untouched draft with
  // the same subject and body is handed back. A failed lookup falls through to
  // the insert (a duplicate draft is harmless; refusing is not).
  const { data: existing, error: lookupErr } = await db
    .from('host_campaigns')
    .select('id')
    .eq('host_id', session.host.id)
    .eq('status', 'draft')
    .eq('subject', subject)
    .eq('body_html', body_html)
    .limit(1)
  if (lookupErr) logWarn('host-announce-draft', 'duplicate-draft lookup failed', { err: lookupErr, eventId: event.id })
  else if (existing?.[0]?.id) return NextResponse.json({ success: true, data: { id: existing[0].id } }, { status: 200 })

  const { data: row, error: insertErr } = await db
    .from('host_campaigns')
    .insert({
      host_id: session.host.id,
      subject,
      body_html,
      audience_kind: 'all',
      audience_event_id: null,
      audience_campaign_id: null,
      email_type: 'marketing',
      status: 'draft',
    })
    .select('id')
    .single()
  if (insertErr) return NextResponse.json({ success: false, error: insertErr.message }, { status: 500 })
  return NextResponse.json({ success: true, data: { id: row.id } }, { status: 201 })
}
