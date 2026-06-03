// POST /api/churn-radar/action
//
// CHURN-RADAR.1 — per-member radar actions. Body:
//   { contact_id, action, note?, message?, snooze_days? }
//
// action ∈ contacted | task_assigned | winback_sent | outreach_sent |
//          payment_reminder | snoozed
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
//   payment_reminder — RADAR-PAY.1: enrol a payment-slipping (early) or
//                   locked (Overdue) member into the location's
//                   designated dunning sequence. Re-derives that the
//                   member is actually behind before enrolling;
//                   idempotent (a member already mid-sequence is a
//                   no-op). The dunning sequence is set in churn-radar
//                   settings (locations.dunning_sequence_id).
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
import { enrolContacts } from '@/lib/sequences'
import { paymentTroubleKind } from '@/lib/churn-radar'
import { invalidateRadar } from '@/lib/radar-cache'
import { logWarn, logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RADAR_ACTIONS = ['contacted', 'task_assigned', 'winback_sent', 'outreach_sent', 'payment_reminder', 'snoozed']

// Membership columns paymentTroubleKind() needs to re-derive that a
// member is genuinely behind before any dunning enrol.
const TROUBLE_COLUMNS =
  'glofox_membership_status, glofox_membership_type, glofox_membership_state, ' +
  'glofox_billing_interval, last_payment_at, last_attended_at, last_booked_at, ' +
  'trial_credits_remaining, glofox_membership_expiry'
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

  // ── payment_reminder — enrol into the dunning sequence ──────────
  // RADAR-PAY.1: one-click dunning for both payment-slipping (early,
  // still active) and locked (Overdue) members. Resolves the location's
  // designated dunning sequence, re-derives that the member is actually
  // behind (a reminder must never reach a paying member), then enrols
  // them. enrolContacts is idempotent — a re-click on a member already
  // mid-sequence is a no-op, not a double-send.
  if (action === 'payment_reminder') {
    const { data: loc } = await db
      .from('locations')
      .select('dunning_sequence_id')
      .eq('id', locationId)
      .maybeSingle()
    const seqId = loc?.dunning_sequence_id
    if (!seqId) {
      return NextResponse.json({
        success: false,
        error: 'No dunning sequence is set up yet — pick one in the churn-radar settings first.',
      }, { status: 400 })
    }

    // Re-derive the trouble state server-side; never trust the client
    // that this member is behind.
    const { data: full } = await db
      .from('contacts')
      .select(TROUBLE_COLUMNS)
      .eq('id', contactId)
      .maybeSingle()
    const kind = paymentTroubleKind(full || {})
    if (!kind) {
      return NextResponse.json({
        success: false,
        error: "This member isn't behind on payment, so no reminder was sent.",
      }, { status: 409 })
    }

    // The configured sequence must still be a live manual sequence at
    // this location — a paused or deleted one can't actually send.
    const { data: seq } = await db
      .from('email_sequences')
      .select('id, name, active, location_id, trigger_type')
      .eq('id', seqId)
      .maybeSingle()
    if (!seq || seq.location_id !== locationId) {
      return NextResponse.json({
        success: false,
        error: 'The configured dunning sequence is no longer available — re-pick it in settings.',
      }, { status: 400 })
    }
    if (!seq.active) {
      return NextResponse.json({
        success: false,
        error: `Your dunning sequence "${seq.name}" is paused — activate it before sending reminders.`,
      }, { status: 400 })
    }

    let enrolled
    try {
      const res = await enrolContacts({
        sequenceId: seqId,
        contactIds: [contactId],
        sourceType: 'churn_radar',
        sourceRef: `payment_${kind}`,
      })
      enrolled = res?.enrolled || 0
    } catch (e) {
      logWarn('churn-radar', 'dunning enrol failed', { err: e, contactId })
      return NextResponse.json({
        success: false,
        error: e.message || 'Could not start the dunning sequence.',
      }, { status: 502 })
    }

    // Already mid-sequence — idempotent no-op, no new audit row.
    if (enrolled === 0) {
      invalidateRadar('churn', locationId)
      return NextResponse.json({ success: true, data: { action, already_enrolled: true } })
    }
    logRow.note = note || `Dunning (${kind}) → ${seq.name}`
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
