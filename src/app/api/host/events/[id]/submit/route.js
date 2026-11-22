// Host publishes their own draft event. (HOST-PORTAL.3)
//
// HOSTAUTOPUB.1 — no staff approval step: a draft (or a row left 'rejected' or
// 'pending_review' from before HOSTAUTOPUB.1) goes straight to 'published'.
// It is public at once when it is also active (eventIsPublic); staff take an
// event down with its active switch. The org's admins are TOLD, not asked
// (notifyAdminsEventPublished: a push and an email, nothing to decide).
//
// The UN1T-only levers stay forced off: they are written at create
// (hostEventDefaults) and no host route accepts them (HostEventSchema is
// strict), and this route writes only the status fields.
import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { notifyAdminsEventPublished } from '@/lib/host-notifications'
import { logError } from '@/lib/log'
import { HOST_PUBLISHABLE_STATUSES } from '@/lib/host-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: event } = await db.from('race_events').select('id, host_id, status, name, slug, location_id').eq('id', params.id).maybeSingle()
  if (!event || event.host_id !== session.host.id) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!HOST_PUBLISHABLE_STATUSES.includes(event.status)) {
    return NextResponse.json({ success: false, error: `Cannot publish an event that is ${event.status}.` }, { status: 409 })
  }

  const submittedAt = new Date().toISOString()
  // CAS on the status read above, so a racing unpublish or a staff decision
  // on a leftover pending_review row cannot be overwritten. 0 rows = 409.
  const { data: updated, error } = await db.from('race_events').update({
    status: 'published',
    submitted_at: submittedAt,
    rejected_reason: null,
  }).eq('id', event.id).eq('status', event.status).select('id')
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!updated || updated.length === 0) {
    return NextResponse.json({ success: false, error: 'The event changed while you were publishing it. Reload and try again.' }, { status: 409 })
  }
  // Carried into the notify so the push dedupe key is per-PUBLISH (an event
  // taken off sale and published again tells staff again).
  event.submitted_at = submittedAt

  // Fire-and-forget: tell the org's admins a host event went live.
  // Never changes the response — the publish already succeeded.
  try {
    const { data: host } = await db
      .from('event_hosts')
      .select('id, name, email, organization_id')
      .eq('id', event.host_id)
      .single()
    if (host) {
      await notifyAdminsEventPublished({ db, event, host, orgId: host.organization_id })
    }
  } catch (e) { logError('host-event-submit', 'notify admins failed', { err: e }) }

  return NextResponse.json({ success: true, data: { id: event.id, status: 'published' } })
}
