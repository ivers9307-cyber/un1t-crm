// AGENT-HANDS.1 — the customer agent's booking tools. Two flows:
//
//   CLASSES (verified, Glofox-linked members only): list upcoming
//   classes + book one. Booking executes via the live-probed
//   createBooking helper — Glofox enforces capacity / double-booking /
//   waitlists server-side and its message_code is relayed VERBATIM,
//   so the agent can never overbook. Mode comes from
//   settings.customer_agent.booking_mode: 'auto' (default — Richard's
//   2026-06-12 call: autonomous from day one) executes immediately;
//   'draft' queues a pending agent_membership_requests row for a
//   one-tap staff approval that executes it. EVERY booking attempt —
//   auto or draft, success or failure — writes an
//   agent_membership_requests row, so the audit trail is complete
//   regardless of mode.
//
//   CONSULTATIONS (leads — no verification needed, this is the point):
//   list available slots + book one. Reuses the public booking
//   widget's exact machinery: computeAvailableSlots (extracted from
//   the slots route) + the same bookings-table insert shape as
//   /api/public/book, so the DB trigger creates/matches the contact
//   and the standard confirmation email/SMS + sequence triggers fire.
//
// Pure helpers are unit-tested in booking-tools.test.js; the executor
// does the IO and never throws (mirrors executeAccountTool).

import { GLOFOX_BOOKING_MODEL } from '@/lib/glofox'

// ── Anthropic tool definitions ──────────────────────────────────────
export const BOOKING_TOOLS = [
  {
    name: 'list_upcoming_classes',
    description:
      "List the studio's upcoming classes over the next few days (name, time, spots left) so a " +
      'VERIFIED member can pick one to book. Only works after verify_identity has succeeded ' +
      'this conversation. Use when a member asks "what classes are on", "can I book a class", ' +
      '"what\'s available tomorrow". Full classes are marked — offer an alternative instead.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days ahead to look (1-7). Default 4.' },
      },
    },
  },
  {
    name: 'book_class',
    description:
      'Book the VERIFIED member into a class from list_upcoming_classes. CRITICAL: before ' +
      'calling this, restate the exact class name and day/time back to the customer and get a ' +
      'clear yes — never book on an ambiguous message. Pass the event_id from ' +
      'list_upcoming_classes plus the class name and time you confirmed. If the studio is set ' +
      'to review bookings first, tell the customer the team will confirm shortly; otherwise ' +
      'relay the result honestly (booked, class full, already booked).',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The 24-hex Glofox event id from list_upcoming_classes.' },
        class_name: { type: 'string', description: 'The class name you confirmed with the customer.' },
        class_time: { type: 'string', description: 'The class date/time you confirmed, as shown in the list.' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'list_consultation_slots',
    description:
      'List available consultation (intro session) slots for a given date — for NEW or ' +
      'prospective customers; no identity verification needed. Use when someone asks to come ' +
      'in, try a class, book a consultation or intro. Returns the bookable times for that ' +
      'date; if none, try the next day. Dates are YYYY-MM-DD.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'The date to check, YYYY-MM-DD.' },
      },
      required: ['date'],
    },
  },
  {
    name: 'book_consultation',
    description:
      'Book a consultation slot from list_consultation_slots for a new/prospective customer. ' +
      'FIRST collect their full name and email address (ask for a phone number too if natural) ' +
      '— the booking needs both. CRITICAL: restate the slot (date + time) and their details ' +
      'and get a clear yes before calling. They will receive a confirmation automatically.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD, from list_consultation_slots.' },
        start_time: { type: 'string', description: 'HH:MM start of the chosen slot.' },
        name: { type: 'string', description: "The customer's full name." },
        email: { type: 'string', description: "The customer's email address." },
        phone: { type: 'string', description: 'Phone number if given.' },
      },
      required: ['date', 'start_time', 'name', 'email'],
    },
  },
]

export const BOOKING_TOOL_NAMES = new Set(BOOKING_TOOLS.map(t => t.name))

// ── pure helpers ────────────────────────────────────────────────────

/** Class-booking autonomy mode from settings.customer_agent. */
export function bookingMode(settings) {
  return settings?.booking_mode === 'draft' ? 'draft' : 'auto'
}

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i

/** Server-side guards for book_class. Pure. */
export function classBookingGuard({ verifiedContactId, glofoxMemberId, eventId } = {}) {
  if (!verifiedContactId) {
    return { error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' }
  }
  if (!glofoxMemberId) {
    return { error: 'not_linked', message: 'This member is not linked to the studio booking system — hand off to the team.' }
  }
  if (!OBJECT_ID_RE.test(String(eventId || ''))) {
    return { error: 'bad_event_id', message: 'event_id must be the 24-hex id from list_upcoming_classes.' }
  }
  return { ok: true }
}

const MAX_CLASS_LIST = 20

const DUBLIN_TIME_FMT = new Intl.DateTimeFormat('en-IE', {
  timeZone: 'Europe/Dublin',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/**
 * Format a unix-seconds instant as a Dublin wall-clock label the model
 * can relay verbatim, e.g. "Sat 13 Jun, 07:00". Glofox time_start is an
 * absolute instant — the original raw .toISOString() handed the model
 * UTC, so it told customers a 7am summer class was at "6am" (live test
 * 2026-06-12). The model must never do timezone math. Pure.
 */
export function formatDublinClassTime(unixSec) {
  const parts = {}
  for (const p of DUBLIN_TIME_FMT.formatToParts(new Date(unixSec * 1000))) {
    parts[p.type] = p.value
  }
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`
}

/**
 * Shape a Glofox /2.0/events list for the agent: upcoming, public,
 * active classes with spots-left, time-sorted, capped. Pure.
 */
export function shapeClassListForAgent(events, nowMs, limit = MAX_CLASS_LIST) {
  const nowSec = Math.floor(nowMs / 1000)
  const out = []
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue
    if (e.active === false || e.private === true) continue
    const startSec = Number(e.time_start)
    if (!Number.isFinite(startSec) || startSec <= nowSec) continue
    const size = Number(e.size) || 0
    const booked = Number(e.booked) || 0
    const spotsLeft = Math.max(0, size - booked)
    out.push({
      event_id: e._id || e.id || null,
      name: e.name || 'Class',
      start_sec: startSec,
      time: formatDublinClassTime(startSec),
      spots_left: spotsLeft,
      full: size > 0 && spotsLeft === 0,
    })
  }
  // Sort on the numeric instant — the Dublin label doesn't sort lexically.
  out.sort((a, b) => a.start_sec - b.start_sec)
  return out.slice(0, limit).map(({ start_sec, ...rest }) => rest)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/

/** Input validation for book_consultation. Pure. */
export function consultationInputGuard({ name, email, date, start_time } = {}) {
  if (!String(name || '').trim()) {
    return { error: 'need_name', message: "Ask for the customer's full name first." }
  }
  if (!EMAIL_RE.test(String(email || '').trim())) {
    return { error: 'need_email', message: 'Ask for a valid email address — the confirmation goes there.' }
  }
  if (!DATE_RE.test(String(date || ''))) {
    return { error: 'bad_date', message: 'date must be YYYY-MM-DD.' }
  }
  if (!TIME_RE.test(String(start_time || ''))) {
    return { error: 'bad_time', message: 'start_time must be HH:MM from list_consultation_slots.' }
  }
  return { ok: true }
}

/** Find a slot by start time. Pure. */
export function findSlot(slots, startTime) {
  return (slots || []).find((s) => s.start === startTime) || null
}

// ── IO helpers ──────────────────────────────────────────────────────

// Resolve the location's consultation booking type: the explicit
// settings.customer_agent.consultation_event_type_id wins; otherwise
// the first active event type whose name mentions consult/intro/taster.
async function resolveConsultationEventType(db, locationId, settings) {
  const cols = 'id, name, slug, duration_minutes, buffer_minutes, availability, max_advance_days, location_id'
  if (settings?.consultation_event_type_id) {
    const { data } = await db.from('event_types')
      .select(cols)
      .eq('id', settings.consultation_event_type_id)
      .eq('active', true)
      .maybeSingle()
    if (data) return data
  }
  const { data: candidates } = await db.from('event_types')
    .select(cols)
    .eq('location_id', locationId)
    .eq('active', true)
    .or('name.ilike.%consult%,name.ilike.%intro%,name.ilike.%taster%')
    .order('created_at', { ascending: true })
    .limit(1)
  return candidates?.[0] || null
}

// Audit-trail writer — every agent booking action lands in the same
// queue/audit table the pause/cancel requests use (mig 258 extended
// kind + status). Best-effort: an audit hiccup never blocks the
// customer-facing outcome.
async function logBookingRequest(db, ctx, { kind, status, details, customerNote = null }) {
  try {
    const { data } = await db.from('agent_membership_requests').insert({
      location_id: ctx.locationId,
      contact_id: ctx.verifiedContactId || ctx.contactId || null,
      kind,
      channel: ctx.channel || null,
      conversation_id: ctx.conversationId || null,
      details,
      customer_note: customerNote,
      status,
    }).select('id').single()
    return data?.id || null
  } catch (e) {
    console.warn(`[agent][booking] audit insert failed: ${e?.message || e}`)
    return null
  }
}

// ── executor (IO) ───────────────────────────────────────────────────
// ctx: { db, conversationId, conversationsTable, contactId,
//        verifiedContactId, locationId, channel, nameHint, settings }
export async function executeBookingTool(toolName, input, ctx) {
  const { db, locationId, verifiedContactId, settings } = ctx

  if (toolName === 'list_upcoming_classes') {
    if (!verifiedContactId) {
      return { error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' }
    }
    const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, fetchUpcomingEvents } =
      await import('@/lib/glofox')
    const creds = await glofoxCredentialsForLocation(db, locationId)
    if (!creds || missingGlofoxCredentialsForLocation(creds).length) {
      return { error: 'no_booking_system', message: 'Class booking is not connected at this studio — hand off to the team.' }
    }
    const days = Math.min(7, Math.max(1, Number(input?.days) || 4))
    const start = Math.floor(Date.now() / 1000)
    const { ok, events } = await fetchUpcomingEvents(creds, { start, end: start + days * 86400, limit: 100 })
    if (!ok) return { error: 'list_failed', message: 'Could not load the timetable just now — offer to hand off.' }
    return { classes: shapeClassListForAgent(events, Date.now()) }
  }

  if (toolName === 'book_class') {
    // Re-read the verified contact's Glofox link server-side — never
    // trust the model for identity-adjacent state.
    let glofoxMemberId = null
    if (verifiedContactId) {
      const { data } = await db.from('contacts')
        .select('glofox_member_id')
        .eq('id', verifiedContactId)
        .maybeSingle()
      glofoxMemberId = data?.glofox_member_id || null
    }
    const guard = classBookingGuard({ verifiedContactId, glofoxMemberId, eventId: input?.event_id })
    if (!guard.ok) return guard

    const mode = bookingMode(settings)
    const baseDetails = {
      event_id: input.event_id,
      class_name: input.class_name || null,
      class_time: input.class_time || null,
      mode,
    }

    if (mode === 'draft') {
      await logBookingRequest(db, ctx, {
        kind: 'class_booking', status: 'pending', details: baseDetails,
      })
      return {
        requested: true,
        message: 'Queued for the team to confirm — tell the customer they will hear back shortly. Never say it is booked yet.',
      }
    }

    const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, createBooking } =
      await import('@/lib/glofox')
    const creds = await glofoxCredentialsForLocation(db, locationId)
    if (!creds || missingGlofoxCredentialsForLocation(creds).length) {
      return { error: 'no_booking_system', message: 'Class booking is not connected at this studio — hand off to the team.' }
    }
    const result = await createBooking(creds, {
      user_id: glofoxMemberId,
      model: GLOFOX_BOOKING_MODEL,
      model_id: input.event_id,
    })
    const messageCode = result?.body?.message_code || result?.body?.message || null
    await logBookingRequest(db, ctx, {
      kind: 'class_booking',
      status: result.ok ? 'actioned' : 'failed',
      details: { ...baseDetails, result: { ok: result.ok, status: result.status, message_code: messageCode } },
    })
    if (!result.ok) {
      return {
        booked: false,
        reason: messageCode || 'BOOKING_FAILED',
        message: 'The booking did not go through — relay the reason honestly and offer an alternative or a handoff.',
      }
    }
    return { booked: true, class_name: input.class_name || null, class_time: input.class_time || null }
  }

  if (toolName === 'list_consultation_slots') {
    const { computeAvailableSlots } = await import('@/lib/booking-slots')
    const eventType = await resolveConsultationEventType(db, locationId, settings)
    if (!eventType) {
      return { error: 'no_consultation_type', message: 'No consultation booking type is configured — hand off to the team.' }
    }
    if (!DATE_RE.test(String(input?.date || ''))) {
      return { error: 'bad_date', message: 'date must be YYYY-MM-DD.' }
    }
    const slots = await computeAvailableSlots(db, eventType, input.date)
    return {
      date: input.date,
      booking_type: eventType.name,
      slots: slots.map((s) => ({ start: s.start, end: s.end })),
    }
  }

  if (toolName === 'book_consultation') {
    const guard = consultationInputGuard(input || {})
    if (!guard.ok) return guard

    const { computeAvailableSlots } = await import('@/lib/booking-slots')
    const eventType = await resolveConsultationEventType(db, locationId, settings)
    if (!eventType) {
      return { error: 'no_consultation_type', message: 'No consultation booking type is configured — hand off to the team.' }
    }
    const slots = await computeAvailableSlots(db, eventType, input.date)
    const slot = findSlot(slots, input.start_time)
    if (!slot) {
      return { error: 'slot_taken', message: 'That slot is no longer available — re-run list_consultation_slots and offer the fresh times.' }
    }

    // Same insert shape as /api/public/book — the handle_new_booking
    // DB trigger creates/matches the contact + deal; location_id is
    // copied per the BOOKING.1 rule.
    const { data: booking, error } = await db.from('bookings').insert({
      event_type_id: eventType.id,
      location_id: eventType.location_id || locationId || null,
      booking_date: input.date,
      start_time: slot.start,
      end_time: slot.end,
      customer_name: String(input.name).trim(),
      customer_email: String(input.email).toLowerCase().trim(),
      customer_phone: input.phone ? String(input.phone).trim() : null,
      custom_responses: {},
      source: 'agent',
    }).select().single()
    if (error) {
      return { error: 'booking_failed', message: 'The booking could not be created — offer to hand off.' }
    }

    // Same fire-and-forget side-effects the public route runs:
    // sequences + the standard confirmation email/SMS.
    try {
      const { triggerSequencesForBooking, triggerSequencesForFirstBooking } = await import('@/lib/sequences')
      await triggerSequencesForBooking(booking.id)
      await triggerSequencesForFirstBooking(booking.id)
    } catch (e) {
      console.warn(`[agent][booking] sequence trigger error: ${e?.message || e}`)
    }
    try {
      const { sendBookingConfirmation } = await import('@/lib/booking-confirmations')
      await sendBookingConfirmation(db, booking.id)
    } catch (e) {
      console.warn(`[agent][booking] confirmation send error: ${e?.message || e}`)
    }

    await logBookingRequest(db, ctx, {
      kind: 'consultation',
      status: 'actioned',
      details: {
        booking_id: booking.id,
        booking_type: eventType.name,
        date: input.date,
        start_time: slot.start,
        customer_name: String(input.name).trim(),
        mode: 'auto',
      },
    })
    return {
      booked: true,
      booking_type: eventType.name,
      date: input.date,
      start_time: slot.start,
      note: 'A confirmation is being sent to their email/phone automatically.',
    }
  }

  return { error: 'unknown_tool', tool: toolName }
}
