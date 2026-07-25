// POST /api/lead-radar/action
//
// LEAD-RADAR.1 — per-contact funnel actions. Body:
//   { contact_id, action, note?, snooze_days? }
//
// action ∈ contacted | outreach_sent | snoozed
//   contacted     — log only ("I've reached out").
//   outreach_sent — RADAR-OUTREACH.1: send an operator-selected
//                   WhatsApp UTILITY template to the lead, then log it
//                   (with the template name). A template delivers
//                   outside the 24h window, so it reaches leads who've
//                   never messaged the gym.
//   snoozed       — hide the contact from the funnel for snooze_days
//                   (default 30).
//
// Every action writes a lead_radar_actions audit row.
//
// Access: lead_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sendRadarOutreach } from '@/lib/radar-outreach'
import { invalidateRadar } from '@/lib/radar-cache'
import { logWarn, logInfo } from '@/lib/log'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RADAR_ACTIONS = ['contacted', 'outreach_sent', 'snoozed']
const SNOOZE_DEFAULT_DAYS = 30

const LeadRadarActionSchema = z.object({
  contact_id: z.string().min(1),
  action: z.string().min(1),
  note: z.string().max(500).optional(),
  snooze_days: z.number().optional(),
  template_name: z.string().optional(),
})

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

  const validation = await validateBody(request, LeadRadarActionSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const contactId = String(body.contact_id).trim()
  const action = String(body.action).trim()
  const note = body.note ? String(body.note).slice(0, 500) : null
  if (!contactId || !RADAR_ACTIONS.includes(action)) {
    return NextResponse.json({
      success: false,
      error: `contact_id and a valid action (${RADAR_ACTIONS.join(', ')}) are required`,
    }, { status: 400 })
  }

  const db = createServerClient()

  // Scope the contact to the caller's active location. The name /
  // phone columns are needed when action === 'outreach_sent'.
  const { data: contact } = await db
    .from('contacts')
    .select('id, location_id, name, first_name, wa_phone, phone')
    .eq('id', contactId)
    .maybeSingle()
  if (!contact || contact.location_id !== locationId) {
    return NextResponse.json({ success: false, error: 'Contact not in your active location' }, { status: 404 })
  }

  const logRow = { contact_id: contactId, location_id: locationId, action, note, actor_id: user.id }

  // ── outreach_sent — send a selected WhatsApp utility template ───
  if (action === 'outreach_sent') {
    const templateName = body?.template_name ? String(body.template_name).trim() : ''
    if (!templateName) {
      return NextResponse.json({ success: false, error: 'Pick a template to send.' }, { status: 400 })
    }
    try {
      await sendRadarOutreach({ db, contact, templateName, locationId, sentBy: user.id })
    } catch (e) {
      logWarn('lead-radar', 'outreach send failed', { err: e, contactId })
      return NextResponse.json({
        success: false,
        error: e.message || 'Could not send the WhatsApp template.',
      }, { status: 502 })
    }
    logRow.template_name = templateName
  }

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

  // The action (contacted / snoozed) changes the funnel — drop the
  // cached radar surfaces so the next read + badge poll reflect it.
  invalidateRadar('lead', locationId)

  logInfo('lead-radar', 'radar action', { contactId, action, actor: user.id })
  return NextResponse.json({ success: true, data: { action } })
}
