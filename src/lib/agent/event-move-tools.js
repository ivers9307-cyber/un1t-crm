// EVENT-MOVE.7 — the customer agent's event-move tools. Registered by
// event-tools.js (EVENT_TOOLS spreads EVENT_MOVE_TOOLS; executeEventTool
// hands these two names to executeMoveTool).
//
//   list_event_move_options  read only: the dates and times this entry may
//     move to, customer-safe (no capacity, spots or counts of any kind), with
//     the price difference as a sentence.
//   move_event_entry         NEVER moves. Files an agent_membership_requests
//     row (kind event_move, pending) for staff to approve; approving it runs
//     moveRegistration (PATCH /api/agent/membership-requests/[id]).
//
// AUTH — the same gate as cancel_event_registration / reschedule_event_wave
// (event-tools.js header): a verified sender, the entry at this studio, owned
// by someone in the verified person's group, confirmed (an unpaid entry pays
// first) and for an event that has not happened yet.
//
// This module must not import event-tools.js (that file imports this one).
// Spec: docs/superpowers/specs/2026-10-08-event-entry-move-design.md.

import { linkedAccountsForContact } from '@/lib/person-accounts'
import { formatMoneyMinor } from '@/lib/money-format'
import { UUID_SHAPE } from '@/lib/uuid-shape'
import { dateLabel, dublinToday } from './event-date-label'
import { publicMoveOptions } from '@/lib/registration-move-public'
import { moveLocationIds } from '@/lib/move-locations'

export const EVENT_MOVE_TOOLS = [
  // Moving an entry to another event goes through staff approval: list the
  // options, then file the request. Never cancel + rebook.
  {
    name: 'list_event_move_options',
    description:
      'Use when a VERIFIED customer asks to change the date of an event entry they already have, ' +
      'or to move it to a different event (e.g. from the 18 Oct Hyrox sim to the 25 Oct one). ' +
      'Shows the dates and times their entry can move to, with the price difference as a sentence. ' +
      'Identity must be verified first; get the registration_id from get_my_event_registrations. ' +
      'Offer only what this lists, and never say how many places are left. Do not promise the move: ' +
      'it needs staff approval, and only move_event_entry asks for it. A different time on the SAME ' +
      'event is reschedule_event_wave instead. Never cancel and rebook to change the event.',
    input_schema: {
      type: 'object',
      properties: {
        registration_id: { type: 'string', description: 'The registration_id from get_my_event_registrations.' },
      },
      required: ['registration_id'],
    },
  },
  {
    name: 'move_event_entry',
    description:
      "Ask the team to move the VERIFIED customer's event entry to one of the dates from " +
      'list_event_move_options. It files a request for staff approval and NEVER moves the entry ' +
      'itself. CRITICAL: restate the new event, date and time (and the price difference when there ' +
      'is one) and get a clear yes before calling. This is the only way to change the event of an ' +
      'entry: never cancel and rebook instead. Afterwards, say the request is with the team and they ' +
      'will confirm; never say it is moved.',
    input_schema: {
      type: 'object',
      properties: {
        registration_id: { type: 'string', description: 'The registration_id from get_my_event_registrations.' },
        target_event_id: { type: 'string', description: 'The event_id of the chosen option from list_event_move_options.' },
        target_wave_id: { type: 'string', description: 'The wave_id of the chosen time (required when the option lists times).' },
        note: { type: 'string', description: "The customer's reason, in a few words, if they gave one." },
      },
      required: ['registration_id', 'target_event_id'],
    },
  },
]

export const EVENT_MOVE_TOOL_NAMES = new Set(EVENT_MOVE_TOOLS.map((t) => t.name))

// ── pure helpers ────────────────────────────────────────────────────

function money(cents, currency) {
  return formatMoneyMinor(Math.abs(Number(cents) || 0), currency || 'EUR')
}

/**
 * The price difference of a move as one sentence for the customer. Pure.
 * A team's gap is for the whole entry: members and non-members can pay
 * different prices, so a per-person split could be wrong. A lower price is
 * never refunded (a move never moves money).
 */
export function priceDifferenceSentence(gapCents, headcount = 1, currency = 'EUR') {
  const gap = Number(gapCents) || 0
  if (gap === 0) return 'Same price.'
  const team = (Number(headcount) || 1) > 1
  const amount = money(gap, currency)
  if (gap > 0) return team ? `${amount} more in total for the entry.` : `${amount} more.`
  return team ? `${amount} less in total for the entry, not refunded.` : `${amount} less, not refunded.`
}

function waveTimeLabel(t) {
  const time = String(t?.start_time || '').slice(0, 5)
  if (time && t?.label) return `${time} (${t.label})`
  return time || t?.label || 'Time to be confirmed'
}

/**
 * listMoveTargets' targets (staff-shaped, with spots_left) → what Mia may see:
 * name, date, the times this entry fits, and the price difference as a
 * sentence. NO capacity, spots or counts of any kind (never surface capacity
 * to a customer). The filtering (which times this entry fits, which events
 * drop out) is publicMoveOptions, the ONE mapper the customer's own entry
 * page uses too (EVENT-MOVE.6); this only re-words its output for Mia. Pure.
 */
export function shapeMoveOptionsForAgent(targets, { headcount = 1 } = {}) {
  return publicMoveOptions(targets, headcount).map((o) => ({
    event_id: o.event_id,
    name: o.name || 'Event',
    date_label: dateLabel(String(o.race_date)),
    times: o.times.map((t) => ({ wave_id: t.wave_id, label: waveTimeLabel(t) })),
    price_difference_sentence: priceDifferenceSentence(o.price_difference_cents, headcount, o.currency),
  }))
}

// ── IO ──────────────────────────────────────────────────────────────

const NOT_FOUND = { error: 'not_found', message: 'That registration was not found. Re-check get_my_event_registrations.' }

/**
 * The gate (see the file header). Returns { reg } or { refusal } (a tool
 * result for Mia). A registration_id that is not UUID-shaped cannot name a
 * row, so it is not_found before any read.
 */
async function ownedConfirmedRegistration(db, ctx, registrationId) {
  const { locationId, contactId, verifiedContactId } = ctx
  if (!verifiedContactId) {
    return {
      refusal: contactId
        ? { error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first, then retry.' }
        : { error: 'no_contact', message: 'No contact linked to this conversation. Hand off to the team.' },
    }
  }
  if (!UUID_SHAPE.test(String(registrationId || ''))) return { refusal: NOT_FOUND }
  const { data: reg, error } = await db.from('race_registrations')
    .select('id, status, contact_id, wave_id, race_events!inner(id, name, race_date, location_id)')
    .eq('id', String(registrationId))
    .eq('race_events.location_id', locationId)
    .maybeSingle()
  if (error) {
    console.warn(`[agent][events] move: registration read failed: ${error.message}`)
    return { refusal: { error: 'load_failed', message: 'The entry could not be read just now. Say so and offer the team.' } }
  }
  if (!reg) return { refusal: NOT_FOUND }

  // PERSON-ACCT.4 — ownership spans the person group (see event-tools.js).
  const linked = await linkedAccountsForContact(db, verifiedContactId)
  const ownerIds = linked.readFailed ? [verifiedContactId] : linked.contacts.map((c) => c?.id).filter(Boolean)
  if (!ownerIds.includes(reg.contact_id)) {
    return { refusal: { error: 'not_yours', message: 'That registration belongs to someone else. Hand off to the team.' } }
  }
  if (reg.status === 'pending_payment') {
    return { refusal: { error: 'not_paid', message: 'This entry is not paid yet, so it cannot be moved. Tell the customer, low-key, that it can be moved once the payment is complete, and offer the team if they are stuck.' } }
  }
  if (reg.status !== 'confirmed') {
    return { refusal: { error: 'not_active', message: 'This entry is not active (cancelled or already used), so there is nothing to move.' } }
  }
  const eventDate = String(reg.race_events?.race_date || '')
  if (!eventDate || eventDate < dublinToday(Date.now())) {
    return { refusal: { error: 'not_active', message: 'That event has already happened, so the entry cannot be moved.' } }
  }
  return { reg }
}

// moveLocationIds (the organisation fence) lives in src/lib/move-locations.js,
// shared with the public entry routes (EVENT-MOVE.6).

/** listMoveTargets for this entry, plus the customer-safe options. */
async function moveOptionsFor(db, ctx, reg) {
  const allowedLocationIds = await moveLocationIds(db, ctx.locationId)
  if (!allowedLocationIds) {
    return { refusal: { error: 'load_failed', message: 'The dates could not be loaded just now. Say so and offer the team.' } }
  }
  const { listMoveTargets } = await import('@/lib/registration-move')
  const listed = await listMoveTargets(db, { registrationId: reg.id, allowedLocationIds })
  if (!listed?.ok) {
    return { refusal: { error: listed?.error || 'load_failed', message: 'The dates could not be loaded just now. Say so and offer the team.' } }
  }
  const headcount = listed.entry?.headcount || 1
  return { listed, headcount, options: shapeMoveOptionsForAgent(listed.targets, { headcount }) }
}

/** Insert the pending request. Its id, or null when the insert failed. */
async function insertMoveRequest(db, ctx, details) {
  try {
    const { data, error } = await db.from('agent_membership_requests').insert({
      location_id: ctx.locationId,
      contact_id: ctx.verifiedContactId || ctx.contactId || null,
      kind: 'event_move',
      channel: ctx.channel || null,
      conversation_id: ctx.conversationId || null,
      details,
      status: 'pending',
    }).select('id').single()
    if (error) console.warn(`[agent][events] move request insert failed: ${error.message}`)
    return data?.id || null
  } catch (e) {
    console.warn(`[agent][events] move request insert failed: ${e?.message || e}`)
    return null
  }
}

/**
 * The customer changed their mind while a request waited: the old one is
 * closed as declined, pointing at its replacement. Guarded on still
 * pending, so a request staff decided meanwhile is never overwritten. No
 * customer message (the route's decline notice only runs on a PATCH).
 */
async function supersedeMoveRequest(db, oldRow, newRequestId) {
  const nowIso = new Date().toISOString()
  const { data, error } = await db.from('agent_membership_requests')
    .update({
      status: 'declined',
      decided_at: nowIso,
      updated_at: nowIso,
      decision_note: 'Superseded: the customer asked for a different date.',
      details: { ...(oldRow.details || {}), superseded_by_request_id: newRequestId, superseded_reason: 'customer_changed_target' },
    })
    .eq('id', oldRow.id)
    .eq('status', 'pending')
    .select('id')
  if (error || !Array.isArray(data) || data.length === 0) {
    console.warn(`[agent][events] move: superseding request ${oldRow.id} did not land: ${error?.message || 'no longer pending'}`)
  }
}

export async function executeMoveTool(toolName, input, ctx) {
  const { db } = ctx
  const gate = await ownedConfirmedRegistration(db, ctx, input?.registration_id)
  if (gate.refusal) return gate.refusal
  const { reg } = gate
  const found = await moveOptionsFor(db, ctx, reg)
  if (found.refusal) return found.refusal
  const { listed, headcount, options } = found
  const sourceDate = reg.race_events?.race_date ? dateLabel(String(reg.race_events.race_date)) : null

  if (toolName === 'list_event_move_options') {
    const entry = { registration_id: reg.id, event_name: reg.race_events?.name || 'Event', date_label: sourceDate }
    if (options.length === 0) {
      return { entry, options: [], message: 'There is no other date this entry can move to right now. Say so plainly and offer the team.' }
    }
    return {
      entry,
      options,
      message: 'Offer these dates and times only. Mention the price difference only when there is one. Once they pick, restate it and get a clear yes, then call move_event_entry. It needs staff approval, so do not promise it.',
    }
  }

  // move_event_entry: the target must be one of the options, re-checked now.
  const option = options.find((o) => o.event_id === String(input?.target_event_id || ''))
  if (!option) {
    return { error: 'not_an_option', message: 'That date is not one this entry can move to. Run list_event_move_options again and offer only what it lists.' }
  }
  const waveId = input?.target_wave_id ? String(input.target_wave_id) : null
  let time = null
  if (option.times.length > 0) {
    if (!waveId) return { error: 'pick_a_time', message: 'That date has set times. Ask which time they want, then call again with its wave_id.' }
    time = option.times.find((t) => t.wave_id === waveId) || null
    if (!time) return { error: 'not_an_option', message: 'That time is not one this entry can move to. Run list_event_move_options again and offer only what it lists.' }
  } else if (waveId) {
    return { error: 'not_an_option', message: 'That date has no times to pick. Run list_event_move_options again and offer only what it lists.' }
  }

  // One pending move per entry. The same target again is the same request;
  // a different one supersedes it (after the new one is filed).
  const { data: pending, error: pendingErr } = await db.from('agent_membership_requests')
    .select('id, details')
    .eq('kind', 'event_move')
    .eq('status', 'pending')
    .eq('details->>registration_id', reg.id)
    .limit(1)
    .maybeSingle()
  if (pendingErr) console.warn(`[agent][events] move: pending-request check failed: ${pendingErr.message}`)
  const sameTarget = pending?.id
    && pending.details?.target_event_id === option.event_id
    && (pending.details?.target_wave_id || null) === (time?.wave_id || null)
  if (sameTarget) {
    return { requested: true, already_requested: true, message: 'A move for this entry is already with the team. Tell the customer it is in hand and they will hear back once it is done. Never say it is moved.' }
  }

  const target = listed.targets.find((t) => t.id === option.event_id) || {}
  const priceGapCents = Number(target.price_gap_cents) || 0
  const currency = target.currency || 'EUR'
  const note = String(input?.note || '').trim().slice(0, 500) || null
  const details = {
    registration_id: reg.id,
    entry_label: listed.entry?.label || 'Entry',
    headcount,
    source_event_id: listed.source?.event_id || reg.race_events?.id || null,
    source_event_name: listed.source?.event_name || reg.race_events?.name || '',
    source_event_date: listed.source?.race_date || reg.race_events?.race_date || null,
    target_event_id: option.event_id,
    target_event_name: option.name,
    target_event_date: target.race_date || null,
    target_date_label: option.date_label,
    target_wave_id: time?.wave_id || null,
    target_wave_label: time?.label || null,
    price_gap_cents: priceGapCents,
    currency,
    note,
  }
  const requestId = await insertMoveRequest(db, ctx, details)
  if (!requestId) {
    return { requested: false, error: 'not_filed', message: 'The request could not be passed to the team. Do not say it is in hand; hand off to the team instead.' }
  }
  if (pending?.id) await supersedeMoveRequest(db, pending, requestId)
  const { notifyAgentApprovalRequest } = await import('./approval-notify')
  const when = [option.date_label, time?.label].filter(Boolean).join(', ')
  await notifyAgentApprovalRequest(db, {
    requestId, locationId: ctx.locationId, kind: 'event_move', customerName: ctx.nameHint,
    summary: `Move ${details.entry_label} from ${details.source_event_name}${sourceDate ? ` (${sourceDate})` : ''} to ${option.name} (${when})`,
  })
  const difference = priceGapCents > 0
    ? ` The new date costs ${money(priceGapCents, currency)} more${headcount > 1 ? ' in total for the entry' : ''}: say the team will send them a link for the difference.`
    : ''
  return {
    requested: true,
    new_event: option.name,
    new_date: option.date_label,
    ...(time ? { new_time: time.label } : {}),
    message: `Request filed. Tell the customer, low-key, that moving their entry to ${option.name} on ${when} is with the team to confirm and they will hear back once it is done. Never say it is moved yet.${difference}`,
  }
}
