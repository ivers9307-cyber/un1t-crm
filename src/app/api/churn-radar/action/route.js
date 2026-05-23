// POST /api/churn-radar/action
//
// CHURN-RADAR.1 — per-member radar actions. Body:
//   { contact_id, action, note?, message?, snooze_days? }
//
// action ∈ contacted | task_assigned | winback_sent | outreach_sent | snoozed
//   contacted     — log only ("I've reached out").
//   task_assigned — create a follow-up Task (activities, kind='task')
//                   assigned to the caller, due in 2 days.
//   winback_sent  — send a free-text WhatsApp to the member, then log it.
//   outreach_sent — RADAR-OUTREACH.1: send an operator-selected
//                   WhatsApp UTILITY template, then log it (with the
//                   template name). Unlike winback_sent's free text, a
//                   template delivers outside the 24h window — which is
//                   the whole point, since the radar's population has
//                   gone quiet.
//   snoozed       — hide the member from the radar for snooze_days
//                   (default 14).
//
// Every action also writes a churn_radar_actions audit row.
//
// Win-back caveat: WhatsApp free-text (winback_sent) only delivers
// inside an open 24h customer-service window. Members who haven't
// messaged recently won't have one — prefer outreach_sent (template).
//
// Access: churn_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sendTextMessage } from '@/lib/whatsapp'
import { sendRadarOutreach } from '@/lib/radar-outreach'
import { invalidateRadar } from '@/lib/radar-cache'
import { logWarn, logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RADAR_ACTIONS = ['contacted', 'task_assigned', 'winback_sent', 'outreach_sent', 'snoozed']
const SNOOZE_DEFAULT_DAYS = 14
const TASK_DUE_DAYS = 2

function isoDatePlus(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'churn_radar')) {
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
    .select('id, name, first_name, location_id, wa_phone, phone')
    .eq('id', contactId)
    .maybeSingle()
  if (!contact || contact.location_id !== locationId) {
    return NextResponse.json({ success: false, error: 'Contact not in your active location' }, { status: 404 })
  }

  const logRow = { contact_id: contactId, location_id: locationId, action, note, actor_id: user.id }

  // ── task_assigned — create a follow-up Task ─────────────────────
  if (action === 'task_assigned') {
    const { error: taskErr } = await db.from('activities').insert({
      contact_id: contactId,
      location_id: locationId,
      kind: 'task',
      subject: `Win-back follow-up: ${contact.name || 'member'}`,
      note: note || 'Flagged by the churn radar — check in with this member.',
      due_date: isoDatePlus(TASK_DUE_DAYS),
      assignee_id: user.id,
    })
    if (taskErr) {
      logWarn('churn-radar', 'task create failed', { err: taskErr, contactId })
      return NextResponse.json({ success: false, error: taskErr.message }, { status: 500 })
    }
  }

  // ── winback_sent — send a WhatsApp, only log on success ─────────
  if (action === 'winback_sent') {
    const to = contact.wa_phone || contact.phone
    if (!to) {
      return NextResponse.json({ success: false, error: 'This member has no phone number on file.' }, { status: 400 })
    }
    const firstName = contact.first_name || (contact.name || '').split(' ')[0] || 'there'
    const message = body?.message
      ? String(body.message).slice(0, 1000)
      : `Hi ${firstName}, it's the team at UN1T — we've noticed you've not been in for a bit and wanted to check in. ` +
        'Anything we can do to help you get back to it? We\'d love to see you in class soon.'
    try {
      await sendTextMessage(to, message, { locationId })
    } catch (e) {
      logWarn('churn-radar', 'winback whatsapp failed', { err: e, contactId })
      return NextResponse.json({
        success: false,
        error: 'Couldn\'t send the WhatsApp — the member has no open message window. Reach out manually.',
      }, { status: 502 })
    }
  }

  // ── outreach_sent — send a selected WhatsApp utility template ───
  if (action === 'outreach_sent') {
    const templateName = body?.template_name ? String(body.template_name).trim() : ''
    if (!templateName) {
      return NextResponse.json({ success: false, error: 'Pick a template to send.' }, { status: 400 })
    }
    try {
      await sendRadarOutreach({ db, contact, templateName, locationId })
    } catch (e) {
      logWarn('churn-radar', 'outreach send failed', { err: e, contactId })
      return NextResponse.json({
        success: false,
        error: e.message || 'Could not send the WhatsApp template.',
      }, { status: 502 })
    }
    logRow.template_name = templateName
  }

  // ── snoozed — record the until-date ─────────────────────────────
  if (action === 'snoozed') {
    const days = Number.isFinite(Number(body?.snooze_days)) && Number(body.snooze_days) > 0
      ? Math.min(Math.round(Number(body.snooze_days)), 90)
      : SNOOZE_DEFAULT_DAYS
    logRow.snooze_until = new Date(Date.now() + days * 86_400_000).toISOString()
  }

  const { error: logErr } = await db.from('churn_radar_actions').insert(logRow)
  if (logErr) {
    logWarn('churn-radar', 'action log insert failed', { err: logErr, contactId, action })
    return NextResponse.json({ success: false, error: logErr.message }, { status: 500 })
  }

  // The action (contacted / task / winback / snooze) changes the
  // radar — drop the cached surfaces so the next read + badge poll
  // reflect it immediately rather than after the TTL.
  invalidateRadar('churn', locationId)

  logInfo('churn-radar', 'radar action', { contactId, action, actor: user.id })
  return NextResponse.json({ success: true, data: { action } })
}
