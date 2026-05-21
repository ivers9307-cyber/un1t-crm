// POST /api/lead-radar/action
//
// LEAD-RADAR.1 — per-contact funnel actions. Body:
//   { contact_id, action, note?, snooze_days? }
//
// action ∈ contacted | snoozed
//   contacted — log only ("I've reached out").
//   snoozed   — hide the contact from the funnel for snooze_days
//               (default 30).
//
// Every action writes a lead_radar_actions audit row.
//
// Access: lead_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { logWarn, logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RADAR_ACTIONS = ['contacted', 'snoozed']
const SNOOZE_DEFAULT_DAYS = 30

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'lead_radar')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  let body
  try { body = await request.json() } catch { body = {} }
  const contactId = String(body?.contact_id || '').trim()
  const action = String(body?.action || '').trim()
  const note = body?.note ? String(body.note).slice(0, 500) : null
  if (!contactId || !RADAR_ACTIONS.includes(action)) {
    return NextResponse.json({
      success: false,
      error: `contact_id and a valid action (${RADAR_ACTIONS.join(', ')}) are required`,
    }, { status: 400 })
  }

  const db = createServerClient()

  // Scope the contact to the caller's active location.
  const { data: contact } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', contactId)
    .maybeSingle()
  if (!contact || contact.location_id !== locationId) {
    return NextResponse.json({ success: false, error: 'Contact not in your active location' }, { status: 404 })
  }

  const logRow = { contact_id: contactId, location_id: locationId, action, note, actor_id: user.id }

  if (action === 'snoozed') {
    const days = Number.isFinite(Number(body?.snooze_days)) && Number(body.snooze_days) > 0
      ? Math.min(Math.round(Number(body.snooze_days)), 90)
      : SNOOZE_DEFAULT_DAYS
    logRow.snooze_until = new Date(Date.now() + days * 86_400_000).toISOString()
  }

  const { error: logErr } = await db.from('lead_radar_actions').insert(logRow)
  if (logErr) {
    logWarn('lead-radar', 'action log insert failed', { err: logErr, contactId, action })
    return NextResponse.json({ success: false, error: logErr.message }, { status: 500 })
  }

  logInfo('lead-radar', 'radar action', { contactId, action, actor: user.id })
  return NextResponse.json({ success: true, data: { action } })
}
