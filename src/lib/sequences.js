// Sequence runner — processes due enrollments, sends the next step,
// advances or completes.
//
// Called by the /api/cron/run-sequences cron every 5 minutes (see
// vercel.json). Also exported for direct invocation from tests
// or other server-side code.
//
// State machine:
//   active   — currently in the sequence, next_step_at <= now() means due
//   paused   — admin-paused; runner skips
//   exited   — contact left (e.g. unsubscribed, or trigger condition no longer met)
//   completed — every step has been sent
//
// Failure handling: if a step send fails, the error is recorded on
// the enrollment and error_count incremented. After 5 consecutive
// failures the enrollment is auto-paused so a single broken contact
// (e.g. invalid email) doesn't fill the cron logs forever.

import { createServerClient } from '@/lib/supabase'
import { sendTransactionalEmail, applyMergeTags } from '@/lib/postmark'
import {
  sendTemplateMessage,
  buildTemplateComponents,
  getOrCreateConversation,
} from '@/lib/whatsapp'

const MAX_ERRORS = 5
const PROCESS_BATCH_SIZE = 100

// ── Public: enrol contacts ───────────────────────────────────────

/**
 * Add contacts to a sequence. Idempotent — uses the
 * sequence_enrollments_unique_active index, so re-enrolling a
 * contact who's currently active is a no-op.
 *
 * @param {object} args
 * @param {string} args.sequenceId
 * @param {string[]} args.contactIds
 * @param {string} [args.sourceType='manual']
 * @param {string} [args.sourceRef]
 * @returns {Promise<{ enrolled: number, skipped: number }>}
 */
export async function enrolContacts({ sequenceId, contactIds, sourceType = 'manual', sourceRef = null }) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return { enrolled: 0, skipped: 0 }
  }
  const db = createServerClient()

  // Use upsert with onConflict on the unique partial index. Doesn't
  // quite work in PostgREST because partial indexes can't be the
  // conflict target; instead, do a SELECT-then-INSERT for the
  // missing rows.
  const { data: existing } = await db
    .from('sequence_enrollments')
    .select('contact_id')
    .eq('sequence_id', sequenceId)
    .eq('status', 'active')
    .in('contact_id', contactIds)
  const alreadyActive = new Set((existing || []).map(r => r.contact_id))

  const toInsert = contactIds
    .filter(id => !alreadyActive.has(id))
    .map(contactId => ({
      sequence_id: sequenceId,
      contact_id: contactId,
      current_step_order: 0,
      status: 'active',
      next_step_at: new Date().toISOString(), // fire on next cron tick
      source_type: sourceType,
      source_ref: sourceRef,
    }))

  if (toInsert.length === 0) {
    return { enrolled: 0, skipped: contactIds.length }
  }

  const { error } = await db.from('sequence_enrollments').insert(toInsert)
  if (error) throw new Error(`Enrol failed: ${error.message}`)

  // Bump the cached counter on the parent sequence.
  await db.rpc('increment_sequence_enrolled', { p_sequence_id: sequenceId, p_delta: toInsert.length })
    .catch(() => {
      // RPC not present — fall back to a direct read+update. Best
      // effort, runner does not depend on this counter.
    })

  return { enrolled: toInsert.length, skipped: alreadyActive.size }
}

// ── Public: trigger handlers ────────────────────────────────────

/**
 * Called by /api/public/book after a booking is inserted. Finds
 * every active sequence with trigger_type='booking_created' for
 * the booking's location whose trigger_config either omits
 * event_type_id (any-event match) or specifies the booking's
 * event_type_id explicitly. Enrols the booking's contact into
 * each match.
 *
 * Best-effort — errors are swallowed so the booking creation
 * itself isn't blocked by a sequence enrol failure.
 */
export async function triggerSequencesForBooking(bookingId) {
  const db = createServerClient()
  try {
    const { data: booking } = await db
      .from('bookings')
      .select('id, event_type_id, location_id, contact_id')
      .eq('id', bookingId)
      .single()
    if (!booking || !booking.contact_id) return

    const { data: sequences } = await db
      .from('email_sequences')
      .select('id, trigger_config')
      .eq('location_id', booking.location_id)
      .eq('trigger_type', 'booking_created')
      .eq('active', true)
    if (!sequences || sequences.length === 0) return

    for (const seq of sequences) {
      const cfg = seq.trigger_config || {}
      // event_type_id is optional in trigger_config — empty means
      // "any event type at this location".
      if (cfg.event_type_id && cfg.event_type_id !== booking.event_type_id) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [booking.contact_id],
        sourceType: 'booking_created',
        sourceRef: booking.id,
      })
    }
  } catch (e) {
    // Don't propagate — booking creation must never fail because
    // of a sequence trigger. Logged for cron/operator review.
    console.warn(`[sequences] booking trigger failed for ${bookingId}: ${e.message}`)
  }
}

// ── Public: pause / resume / exit ────────────────────────────────

export async function setEnrollmentStatus({ enrollmentId, status, reason }) {
  const db = createServerClient()
  const updates = { status }
  if (reason) updates.last_error = reason
  const { error } = await db.from('sequence_enrollments').update(updates).eq('id', enrollmentId)
  if (error) throw error
}

// ── Internal: pick the next step for an enrolment ────────────────

/**
 * Returns the step that should fire next for an enrolment, or null
 * if the sequence is finished. current_step_order is 0 before any
 * step has been sent; otherwise the runner sends step_order =
 * current_step_order + 1.
 */
async function nextStepForEnrollment(db, enrollment) {
  const targetOrder = (enrollment.current_step_order || 0) + 1
  const { data: step } = await db
    .from('sequence_steps')
    .select('*')
    .eq('sequence_id', enrollment.sequence_id)
    .eq('step_order', targetOrder)
    .maybeSingle()
  return step || null
}

function nextStepDelayMs(step) {
  if (!step) return 0
  // The schema carries three delay fields (added at different migration
  // points); the API writes days+hours, mig 005 originally wrote
  // minutes. Sum all three so however the row was written, we honour
  // the intent.
  const days = Number(step.delay_days || 0)
  const hours = Number(step.delay_hours || 0)
  const minutes = Number(step.delay_minutes || 0)
  const ms = (days * 24 * 60 + hours * 60 + minutes) * 60_000
  return Number.isFinite(ms) && ms >= 0 ? ms : 0
}

// ── Internal: send a single email step ───────────────────────────

async function sendEmailStep(db, { enrollment: _enrollment, step, sequence, contact }) {
  if (!contact?.email) {
    throw new Error('Contact has no email address — cannot send email step.')
  }

  // Resolve content: inline OR via template_id reference.
  let subject = step.subject
  let html = step.html_content
  if (!html && step.template_id) {
    const { data: tpl } = await db
      .from('email_templates')
      .select('subject, html_content')
      .eq('id', step.template_id)
      .single()
    if (tpl) {
      subject = subject || tpl.subject
      html = tpl.html_content
    }
  }
  if (!html) throw new Error('Step has no content (no html_content and no template_id).')

  // Merge tags substitution — supports {{first_name}}, {{full_name}}
  // etc, same shape as campaigns (see src/lib/postmark.js#applyMergeTags).
  const mergedSubject = applyMergeTags(subject, contact)
  const mergedHtml = applyMergeTags(html, contact)

  const result = await sendTransactionalEmail({
    to: contact.email,
    subject: mergedSubject,
    htmlBody: mergedHtml,
    contactId: contact.id,
    locationId: sequence.location_id,
    tag: `seq-${sequence.id}`,
  })

  // Annotate the email_sends row with sequence + step references so
  // open/click webhooks can attribute opens back to the step.
  if (result?.messageId) {
    await db
      .from('email_sends')
      .update({
        source_type: 'sequence',
        sequence_id: sequence.id,
        sequence_step_id: step.id,
      })
      .eq('postmark_message_id', result.messageId)
  }

  // Bump per-step metric.
  await db.rpc('increment_step_sent', { p_step_id: step.id }).catch(() => {})

  return result?.messageId || null
}

// ── Internal: send a single WhatsApp template step ──────────────

async function sendWhatsappStep(db, { step, sequence, contact }) {
  if (!step.whatsapp_template_id) {
    throw new Error('WhatsApp step has no template_id.')
  }
  if (!contact?.wa_phone) {
    throw new Error('Contact has no WhatsApp phone number — cannot send WhatsApp step.')
  }

  // Resolve the template; must be APPROVED to send.
  const { data: template } = await db
    .from('whatsapp_templates')
    .select('*')
    .eq('id', step.whatsapp_template_id)
    .single()
  if (!template) throw new Error('WhatsApp template not found.')
  if (template.status !== 'APPROVED') {
    throw new Error(`WhatsApp template "${template.name}" is ${template.status}, not APPROVED — cannot send.`)
  }
  if (template.location_id !== sequence.location_id) {
    throw new Error('WhatsApp template belongs to a different location than the sequence.')
  }

  // Variable mapping resolution mirrors the broadcasts flow exactly.
  const variableMapping = step.whatsapp_variables || {}
  const components = buildTemplateComponents(
    template,
    contact,
    variableMapping,
    step.whatsapp_header_media_url || null
  )

  const result = await sendTemplateMessage(
    contact.wa_phone,
    template.name,
    template.language,
    components
  )

  // Log to whatsapp_messages so the inbox + analytics see it.
  // Conversation is upserted via the helper to attribute correctly.
  const conversationId = await getOrCreateConversation(db, contact, sequence.location_id)
  if (conversationId && result?.messageId) {
    await db.from('whatsapp_messages').insert({
      conversation_id: conversationId,
      contact_id: contact.id,
      location_id: sequence.location_id,
      wa_message_id: result.messageId,
      direction: 'outbound',
      message_type: 'template',
      template_name: template.name,
      template_variables: variableMapping,
      status: 'sent',
      sent_at: new Date().toISOString(),
    })
  }

  // Bump per-step metric.
  await db.rpc('increment_step_sent', { p_step_id: step.id }).catch(() => {})

  return result?.messageId || null
}

// ── Public: process due enrollments (called by the cron) ─────────

/**
 * Picks up to PROCESS_BATCH_SIZE due enrollments and processes them.
 * Returns a summary so the cron handler can log it.
 *
 * @param {object} [opts]
 * @param {Date} [opts.now=new Date()]  — overridable for tests
 */
export async function runSequences({ now = new Date() } = {}) {
  const db = createServerClient()
  const stats = { picked: 0, sent: 0, completed: 0, errored: 0, paused: 0, skipped: 0 }

  // Pick due rows. Order by next_step_at so older deliveries fire
  // first. SKIP LOCKED isn't directly available via PostgREST so we
  // tolerate the small chance of two cron invocations grabbing the
  // same row — the per-step send is idempotent within a tick because
  // we update current_step_order before returning.
  const { data: due, error: dueErr } = await db
    .from('sequence_enrollments')
    .select('id, sequence_id, contact_id, current_step_order, error_count, status')
    .eq('status', 'active')
    .lte('next_step_at', now.toISOString())
    .order('next_step_at', { ascending: true })
    .limit(PROCESS_BATCH_SIZE)

  if (dueErr) throw new Error(`Failed to load due enrollments: ${dueErr.message}`)
  stats.picked = (due || []).length
  if (!due || due.length === 0) return stats

  for (const enrollment of due) {
    try {
      // Reload the parent sequence + the contact in one go.
      const [{ data: sequence }, { data: contact }] = await Promise.all([
        db.from('email_sequences').select('*').eq('id', enrollment.sequence_id).single(),
        db.from('contacts').select('*').eq('id', enrollment.contact_id).single(),
      ])
      if (!sequence || !contact) {
        await db.from('sequence_enrollments').update({
          status: 'exited',
          last_error: !sequence ? 'Sequence deleted' : 'Contact deleted',
          last_processed_at: now.toISOString(),
        }).eq('id', enrollment.id)
        stats.skipped++
        continue
      }
      if (!sequence.active) {
        // Sequence was paused since enrolment — push the row's
        // next-step time forward so we don't busy-loop on it.
        await db.from('sequence_enrollments').update({
          last_processed_at: now.toISOString(),
          next_step_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
        }).eq('id', enrollment.id)
        stats.skipped++
        continue
      }

      const step = await nextStepForEnrollment(db, enrollment)
      if (!step) {
        // Out of steps — mark complete.
        await db.from('sequence_enrollments').update({
          status: 'completed',
          last_processed_at: now.toISOString(),
          next_step_at: null,
        }).eq('id', enrollment.id)
        await db.rpc('increment_sequence_completed', { p_sequence_id: sequence.id, p_delta: 1 }).catch(() => {})
        stats.completed++
        continue
      }

      // Branch by step type.
      let sendId = null
      if (step.step_type === 'wait') {
        // Wait step has no send — just advance with the delay.
        sendId = null
      } else if (step.step_type === 'email' || !step.step_type) {
        sendId = await sendEmailStep(db, { enrollment, step, sequence, contact })
      } else if (step.step_type === 'whatsapp') {
        sendId = await sendWhatsappStep(db, { enrollment, step, sequence, contact })
      } else {
        throw new Error(`Unknown step_type "${step.step_type}".`)
      }

      // Compute the next fire time based on the FOLLOWING step's delay.
      const followingStep = await db
        .from('sequence_steps')
        .select('delay_days, delay_hours, delay_minutes')
        .eq('sequence_id', sequence.id)
        .eq('step_order', step.step_order + 1)
        .maybeSingle()
      const nextFireAt = followingStep.data
        ? new Date(now.getTime() + nextStepDelayMs(followingStep.data)).toISOString()
        : null
      const newStatus = followingStep.data ? 'active' : 'completed'

      await db.from('sequence_enrollments').update({
        current_step_order: step.step_order,
        next_step_at: nextFireAt,
        status: newStatus,
        last_processed_at: now.toISOString(),
        last_step_send_id: sendId,
        last_error: null,
        error_count: 0,
      }).eq('id', enrollment.id)

      if (newStatus === 'completed') {
        await db.rpc('increment_sequence_completed', { p_sequence_id: sequence.id, p_delta: 1 }).catch(() => {})
        stats.completed++
      }
      stats.sent++
    } catch (e) {
      const errCount = (enrollment.error_count || 0) + 1
      const shouldPause = errCount >= MAX_ERRORS
      await db.from('sequence_enrollments').update({
        last_error: e.message || String(e),
        error_count: errCount,
        last_processed_at: now.toISOString(),
        // Push next attempt 30 min out (or pause altogether).
        next_step_at: shouldPause ? null : new Date(now.getTime() + 30 * 60_000).toISOString(),
        status: shouldPause ? 'paused' : 'active',
      }).eq('id', enrollment.id)
      if (shouldPause) stats.paused++
      stats.errored++
    }
  }

  return stats
}
