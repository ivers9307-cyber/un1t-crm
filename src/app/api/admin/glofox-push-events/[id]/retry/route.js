// POST /api/admin/glofox-push-events/[id]/retry  (GLOFOX3.6)
//
// Operator-triggered retry of a failed/needs_review push event.
// Re-fetches the contact, re-fires findOrCreateGlofoxMember in the
// same mode as the original push (createIfMissing+attachTrial match
// the original source), and stamps reviewed_at on the OLD event
// so the Review tab clears it whether or not the retry succeeds
// (the retry itself writes a fresh audit row via the orchestrator).
//
// Master only.
//
// The 'dup_check' source is search-only (createIfMissing=false). The
// 'booking_form' / 'event_registration' / 'manual_button' / 'cron'
// sources are create-with-trial. We mirror the original source's
// intent rather than always upgrading to create — a 'dup_check' that
// failed (e.g., network blip during search) should retry as search-
// only too.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CREATE_SOURCES = new Set(['booking_form', 'event_registration', 'manual_button', 'cron'])

export async function POST(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const { id } = await params
  if (!id) return NextResponse.json({ success: false, error: 'missing event id' }, { status: 400 })

  const db = createServerClient()
  const { data: ev, error: evErr } = await db
    .from('glofox_push_events')
    .select('id, contact_id, location_id, source, status, reviewed_at')
    .eq('id', id)
    .single()
  if (evErr || !ev) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }
  if (!ev.contact_id || !ev.location_id) {
    return NextResponse.json({
      success: false,
      error: 'Event has no contact_id / location_id — cannot retry',
    }, { status: 400 })
  }

  const { data: contact, error: cErr } = await db
    .from('contacts')
    .select('id, name, email, first_name, last_name, phone, dob, location_id, glofox_member_id')
    .eq('id', ev.contact_id)
    .single()
  if (cErr || !contact) {
    return NextResponse.json({
      success: false,
      error: 'Contact for this event no longer exists',
    }, { status: 404 })
  }

  // Same name-derivation fallback as the booking + event-registration
  // flows. Glofox /2.0/register requires first_name + last_name.
  let first_name = contact.first_name
  let last_name = contact.last_name
  if ((!first_name || !last_name) && contact.name) {
    const full = contact.name.trim().split(/\s+/)
    first_name = first_name || full[0] || ''
    last_name = last_name || (full.slice(1).join(' ') || '—')
  }

  const wantsCreate = CREATE_SOURCES.has(ev.source)
  const result = await findOrCreateGlofoxMember({
    db,
    locationId: contact.location_id,
    contact: { ...contact, first_name, last_name },
    source: ev.source, // preserve audit trail of where this originated
    createIfMissing: wantsCreate,
    attachTrial: wantsCreate,
  })

  // Stamp the original event as reviewed regardless of retry outcome
  // — the retry wrote its own fresh audit row, so the old one has
  // served its purpose. If THE RETRY landed in needs_review/failed
  // it'll surface on the Review tab via its own row.
  await db
    .from('glofox_push_events')
    .update({ reviewed_at: new Date().toISOString(), reviewed_by: user.id })
    .eq('id', id)

  return NextResponse.json({
    success: result.status !== 'failed',
    retried_event_id: id,
    result,
  })
}
