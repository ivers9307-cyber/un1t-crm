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
//   agent_membership_requests row BEFORE the Glofox call and finalises
//   it after, so a crash mid-call leaves a visible 'pending' intent row
//   rather than an untracked booking (MIA-REVIEW.3).
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
import { DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT } from './notify'
import { notifyAgentApprovalRequest } from './approval-notify'
import { formatDublinClassTime } from './dublin-format'

// ── Anthropic tool definitions ──────────────────────────────────────
export const BOOKING_TOOLS = [
  {
    name: 'list_upcoming_classes',
    description:
      "List the studio's upcoming classes over the next few days (name and time) so a " +
      'VERIFIED member can pick one to book. Only works after verify_identity has succeeded ' +
      'this conversation. Use when a member asks "what classes are on", "can I book a class", ' +
      '"what\'s available tomorrow". Classes carry full and limited flags, never a count — ' +
      'never tell the customer how many spaces are left. Offer an alternative to a full class.',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description:
            'How many days ahead to look (1-7). Default 7 — the full visible week. NEVER ask ' +
            'the customer how far ahead to look; infer it from their request (a named day like ' +
            '"Friday" is always within 7).',
        },
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
      'Book a consultation slot from list_consultation_slots. If the studio already has this ' +
      "person's name and email on file (Context says their identity is known, or you already " +
      'know it from earlier in the chat), do NOT ask again — leave name/email out and the ' +
      'booking uses the details on file. Only ask a brand-new person we know nothing about for ' +
      'their name and email (a phone number too if it flows naturally). CRITICAL either way: ' +
      'restate the slot (date + time) and get a clear yes before calling. They will receive a ' +
      'confirmation automatically.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD, from list_consultation_slots.' },
        start_time: { type: 'string', description: 'HH:MM start of the chosen slot.' },
        name: { type: 'string', description: "The customer's full name. Omit if already on file — do not re-ask a known person." },
        email: { type: 'string', description: "The customer's email address. Omit if already on file — do not re-ask a known person." },
        phone: { type: 'string', description: 'Phone number if given.' },
      },
      required: ['date', 'start_time'],
    },
  },
  {
    name: 'list_my_upcoming_bookings',
    description:
      "List the VERIFIED member's own upcoming class bookings (class, day/time, booking id) " +
      'straight from the booking system. Use when a member asks what they are booked into, or ' +
      'before cancelling/rescheduling so you have the booking_id. Only works after identity is ' +
      'verified.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_class_booking',
    description:
      "Cancel one of the VERIFIED member's upcoming bookings from list_my_upcoming_bookings. " +
      'CRITICAL: restate the exact class and day/time and get a clear yes before calling — ' +
      'never cancel on an ambiguous message. The studio may have a no-late-cancellation rule; ' +
      'if the system refuses, relay its reason honestly. For a RESCHEDULE: confirm BOTH the ' +
      'cancellation and the new class with the customer first, then cancel and book the new one.',
    input_schema: {
      type: 'object',
      properties: {
        booking_id: { type: 'string', description: 'The 24-hex booking id from list_my_upcoming_bookings.' },
        class_name: { type: 'string', description: 'The class name you confirmed with the customer.' },
        class_time: { type: 'string', description: 'The class date/time you confirmed, as shown in the list.' },
      },
      required: ['booking_id'],
    },
  },
  {
    name: 'save_lead_details',
    description:
      "Save what you've learned about the person you're talking to — their name, email, and " +
      'what they want from the studio (goal, preferred times, interest). Works for anyone, no ' +
      'verification needed. Call it once you naturally learn something new — never interrogate ' +
      'people for details. Existing contact details are never overwritten.',
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string', description: 'First name, if they gave it.' },
        last_name: { type: 'string', description: 'Last name, if they gave it.' },
        email: { type: 'string', description: 'Email address, if they gave it.' },
        interest: { type: 'string', description: "What they're after — goal, classes of interest, timing. One or two sentences." },
      },
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

// 60, not 20: the list is time-sorted, so a low cap silently truncates the
// FAR days — at ~8 classes/day a 20-row cap ends ~2.5 days out, which is how
// Mia told a customer "the schedule only goes up to Thursday" on a Monday
// (Dean, 2026-06-30). 60 rows covers 7 days of a full timetable.
const MAX_CLASS_LIST = 60

// MIA-REVIEW.3 — the formatter moved to ./dublin-format so account-tools
// (which can't import this module: it statically pulls @/lib/glofox) shares
// the exact same Dublin labelling. Re-exported so the public surface of
// booking-tools is unchanged.
export { formatDublinClassTime }

// CAPACITY-SECRECY.1 — a class with this many spaces or fewer is "limited".
// Coarse on purpose: it lets Mia create honest urgency without ever handing
// the model a number it could relay.
const LIMITED_SPOTS_THRESHOLD = 3

/**
 * Shape a Glofox /2.0/events list for the agent: upcoming, public,
 * active classes, time-sorted, capped. Pure.
 *
 * CAPACITY-SECRECY.1 — availability is exposed as the `full` / `limited`
 * booleans ONLY. Customers must never be told how many spaces are left, and
 * the surest way to guarantee that is to never put the count in the model's
 * context (the prompt rule is the second line of defence). Operator surfaces
 * that legitimately need counts read Glofox directly, not through here.
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
    const full = size > 0 && spotsLeft === 0
    out.push({
      event_id: e._id || e.id || null,
      name: e.name || 'Class',
      start_sec: startSec,
      time: formatDublinClassTime(startSec),
      full,
      ...(!full && size > 0 && spotsLeft <= LIMITED_SPOTS_THRESHOLD ? { limited: true } : {}),
    })
  }
  // Sort on the numeric instant — the Dublin label doesn't sort lexically.
  out.sort((a, b) => a.start_sec - b.start_sec)
  return out.slice(0, limit).map(({ start_sec: _omitted, ...rest }) => rest)
}

const MAX_MEMBER_BOOKINGS = 10

/**
 * Shape a member's Glofox /2.0/bookings rows for the agent: future,
 * still-BOOKED rows with the booking id the cancel call needs, Dublin
 * labels, time-sorted, capped. Pure.
 */
export function shapeMemberBookingsForAgent(bookings, nowMs, limit = MAX_MEMBER_BOOKINGS) {
  const nowSec = Math.floor(nowMs / 1000)
  const out = []
  for (const b of Array.isArray(bookings) ? bookings : []) {
    if (!b || typeof b !== 'object') continue
    const status = typeof b.status === 'string' ? b.status.toUpperCase() : null
    if (status && status !== 'BOOKED') continue
    const startSec = Number(b.time_start)
    if (!Number.isFinite(startSec) || startSec <= nowSec) continue
    out.push({
      booking_id: b._id || null,
      class_name: b.event_name || b.model_name || 'Class',
      start_sec: startSec,
      time: formatDublinClassTime(startSec),
    })
  }
  out.sort((a, b) => a.start_sec - b.start_sec)
  return out.slice(0, limit).map(({ start_sec: _omitted, ...rest }) => rest)
}

/** Server-side guards for cancel_class_booking. Pure. */
export function cancelBookingGuard({ verifiedContactId, glofoxMemberId, bookingId } = {}) {
  if (!verifiedContactId) {
    return { error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' }
  }
  if (!glofoxMemberId) {
    return { error: 'not_linked', message: 'This member is not linked to the studio booking system — hand off to the team.' }
  }
  if (!OBJECT_ID_RE.test(String(bookingId || ''))) {
    return { error: 'bad_booking_id', message: 'booking_id must be the 24-hex id from list_my_upcoming_bookings.' }
  }
  return { ok: true }
}

const MAX_NOTE_LEN = 500

/**
 * AGENT-LEADCAP.1 — fill-empty-only contact enrichment. Returns the
 * fields safe to write (never overwrites a non-empty value, validates
 * the email) plus the timeline note for the interest text. Pure.
 */
export function leadDetailsPatch(existing = {}, input = {}) {
  const patch = {}
  const empty = (v) => v == null || String(v).trim() === ''
  for (const field of ['first_name', 'last_name']) {
    const v = String(input?.[field] || '').trim()
    if (v && empty(existing?.[field])) patch[field] = v.slice(0, 80)
  }
  const emailIn = String(input?.email || '').trim().toLowerCase()
  if (emailIn && EMAIL_RE.test(emailIn) && empty(existing?.email)) patch.email = emailIn
  const interest = String(input?.interest || '').trim()
  const note = interest ? `[Mia] ${interest}`.slice(0, MAX_NOTE_LEN) : null
  return { patch, note }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/

/**
 * Resolve the consultation booker's identity: prefer what the model passed,
 * fall back to the details already on the linked contact, then the channel
 * name hint. Lets Mia book a KNOWN person without re-interrogating them for a
 * name/email the studio already holds (Edel Crehan, 2026-07-06 — verified
 * contact asked to re-type her own on-file email, then handed to a human).
 * Only a genuinely-new person with nothing on file still gets asked. Pure.
 */
export function resolveConsultationIdentity({ input = {}, contact = {}, nameHint = null } = {}) {
  const clean = (v) => String(v ?? '').trim()
  const inName = clean(input.name)
  const contactName = [clean(contact.first_name), clean(contact.last_name)].filter(Boolean).join(' ')
  const name = inName || contactName || clean(nameHint)
  const email = (clean(input.email) || clean(contact.email)).toLowerCase()
  const phone = clean(input.phone) || clean(contact.phone)
  return { name, email, phone: phone || null }
}

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
//
// MIA-REVIEW.3 — auto mode now writes the INTENT row (status 'pending',
// details.stage 'executing') BEFORE the Glofox call and finalises it after,
// the way the draft path already did. Writing only afterwards meant a crash
// or timeout between the Glofox call and the log left a real booking /
// cancellation with no audit row at all, so the trail could never be treated
// as complete for reconciliation. A row left behind by a crash stays
// 'pending' and surfaces in the approvals queue, where approving it re-runs
// the action (Glofox is the arbiter of double-booking).
async function logBookingRequest(db, ctx, { kind, status, details, customerNote = null }) {
  try {
    const { data, error } = await db.from('agent_membership_requests').insert({
      location_id: ctx.locationId,
      contact_id: ctx.verifiedContactId || ctx.contactId || null,
      kind,
      channel: ctx.channel || null,
      conversation_id: ctx.conversationId || null,
      details,
      customer_note: customerNote,
      status,
    }).select('id').single()
    // supabase-js resolves PostgREST errors instead of throwing — without
    // this check a rejected insert is a silent no-row (MIA-BOOK.1).
    if (error) console.error(`[agent][booking] audit insert failed (${kind}): ${error.message}`)
    return data?.id || null
  } catch (e) {
    console.warn(`[agent][booking] audit insert failed: ${e?.message || e}`)
    return null
  }
}

// Close out the intent row written before the side effect. Falls back to a
// fresh insert when the pre-write failed (or returned no id), so the outcome
// is always recorded somewhere. Best-effort, same as the writer above — but
// a failure here is now LOUD, because it means a real Glofox action has no
// complete audit row.
async function finalizeBookingRequest(db, ctx, requestId, { kind, status, details }) {
  if (!requestId) {
    await logBookingRequest(db, ctx, { kind, status, details })
    return
  }
  try {
    const { error } = await db.from('agent_membership_requests')
      .update({ status, details, updated_at: new Date().toISOString() })
      .eq('id', requestId)
    if (error) {
      console.error(`[agent][booking] audit finalise failed (${kind} ${requestId}): ${error.message}`)
    }
  } catch (e) {
    console.error(`[agent][booking] audit finalise threw (${kind} ${requestId}): ${e?.message || e}`)
  }
}

// MIA-BOOK.1 — routing for a rejected booking. Codes staff cannot fix (the
// class itself is gone or full) stay in-chat as an honest reply + an
// alternative; everything else — credits, membership, UNKNOWN codes —
// becomes a pending approval a human resolves (fail safe: a spurious card
// beats a false "you're booked"). Grow this set as real codes appear in
// agent_membership_requests.details.result.message_code.
const CUSTOMER_ANSWERABLE_CODES = new Set(['EVENT_HAS_BEEN_CANCELLED', 'EVENT_FULL'])
export function bookingRejectionRoute(messageCode) {
  return CUSTOMER_ANSWERABLE_CODES.has(messageCode) ? 'reply' : 'approval'
}

// One pending approval per (contact, event): a retried tool call must not
// double-card staff. Best-effort — on lookup failure we'd rather risk a
// duplicate card than lose the fallback entirely.
async function pendingBookingApprovalId(db, ctx, eventId, excludeId) {
  try {
    const { data } = await db.from('agent_membership_requests')
      .select('id')
      .eq('contact_id', ctx.verifiedContactId || ctx.contactId)
      .eq('kind', 'class_booking')
      .eq('status', 'pending')
      .contains('details', { event_id: eventId })
      .limit(5)
    return (data || []).map((r) => r.id).find((id) => id && id !== excludeId) || null
  } catch { return null }
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
    const days = Math.min(7, Math.max(1, Number(input?.days) || 7))
    const start = Math.floor(Date.now() / 1000)
    const { ok, events } = await fetchUpcomingEvents(creds, { start, end: start + days * 86400, limit: 100 })
    if (!ok) return { error: 'list_failed', message: 'Could not load the timetable just now — offer to hand off.' }
    return { classes: shapeClassListForAgent(events, Date.now()) }
  }

  if (toolName === 'book_class') {
    // Re-read the verified contact's Glofox link server-side — never
    // trust the model for identity-adjacent state.
    let glofoxMemberId = null
    let membershipStatus = null
    if (verifiedContactId) {
      const { data } = await db.from('contacts')
        .select('glofox_member_id, glofox_membership_status')
        .eq('id', verifiedContactId)
        .maybeSingle()
      glofoxMemberId = data?.glofox_member_id || null
      membershipStatus = data?.glofox_membership_status || null
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

    // MIA-CREDITS.1 — pre-flight the balance BEFORE drafting or executing.
    // Every historical agent booking failure was Glofox's
    // YOU_HAVE_NO_CREDITS_LEFT discovered at execute time; check first and,
    // when the account has nothing to book with, escalate to a human while
    // the customer is still in the conversation (Richard 2026-08-25: "I
    // want to avoid an opportunity of a potential customer being dropped").
    // Same gate as the funnel pipeline (AGENT-FUNNEL-CREDITS.1): credits > 0
    // or a CRM-synced active membership proceeds; an UNREADABLE balance also
    // proceeds — a broken pre-check must never block a booking that would
    // have worked (Glofox still arbitrates at execute time).
    {
      let credits = null
      let readFailed = false
      try {
        const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, fetchUserCreditsResult } = await import('@/lib/glofox')
        const { computeCreditsRemaining } = await import('@/lib/glofox-sync')
        const creds = await glofoxCredentialsForLocation(db, locationId)
        if (!creds || missingGlofoxCredentialsForLocation(creds).length) {
          readFailed = true // no Glofox here — the execute path answers no_booking_system
        } else {
          // ok-aware read: a Glofox blip must NOT escalate every booking to
          // a human — only a confirmed-empty balance does.
          const { ok, credits: rows } = await fetchUserCreditsResult(creds, glofoxMemberId)
          if (!ok) readFailed = true
          else credits = computeCreditsRemaining(rows)
        }
      } catch { readFailed = true }
      const activeMembership = membershipStatus === 'active'
      if (!readFailed && !(credits > 0) && !activeMembership) {
        // File the booking intent as a pending approval (deduped per
        // contact+event) so staff keep the one-tap grant-then-book flow the
        // approvals queue provides; the auto-reply loop sees no_credits on
        // this result and hands the THREAD off deterministically (script +
        // park + manager push) — the customer is never left with silence.
        let approvalId = await pendingBookingApprovalId(db, ctx, input.event_id, null)
        if (!approvalId) {
          approvalId = await logBookingRequest(db, ctx, {
            kind: 'class_booking', status: 'pending',
            details: { ...baseDetails, reason: 'no_credits' },
          })
          if (approvalId) {
            await notifyAgentApprovalRequest(db, {
              requestId: approvalId, locationId, kind: 'class_booking', customerName: ctx.nameHint,
              summary: [input.class_name, input.class_time, 'no credits — Mia escalated'].filter(Boolean).join(' · '),
            })
          }
        }
        return {
          booked: false,
          no_credits: true,
          message: 'The customer has no class credits and no active membership, so this booking cannot proceed. The team has been alerted and is taking over this conversation now — your reply will not be sent, so do not compose one.',
        }
      }
    }

    if (mode === 'draft') {
      const draftId = await logBookingRequest(db, ctx, {
        kind: 'class_booking', status: 'pending', details: baseDetails,
      })
      await notifyAgentApprovalRequest(db, {
        requestId: draftId, locationId, kind: 'class_booking', customerName: ctx.nameHint,
        summary: [input.class_name, input.class_time].filter(Boolean).join(' · ') || 'class booking to confirm',
      })
      return {
        requested: true,
        message: 'Queued for the team to confirm — tell the customer they will hear back shortly. Never say it is booked yet.',
      }
    }

    const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, createBooking, interpretBookingResult } =
      await import('@/lib/glofox')
    const creds = await glofoxCredentialsForLocation(db, locationId)
    if (!creds || missingGlofoxCredentialsForLocation(creds).length) {
      return { error: 'no_booking_system', message: 'Class booking is not connected at this studio — hand off to the team.' }
    }
    // Intent BEFORE the side effect (see logBookingRequest).
    const auditId = await logBookingRequest(db, ctx, {
      kind: 'class_booking', status: 'pending', details: { ...baseDetails, stage: 'executing' },
    })
    const result = await createBooking(creds, {
      user_id: glofoxMemberId,
      model: GLOFOX_BOOKING_MODEL,
      model_id: input.event_id,
    })
    // Glofox can 200 with a failure body (YOU_HAVE_NO_CREDITS_LEFT) —
    // success needs the created booking id, not just HTTP ok. alreadyBooked
    // counts as success: the member IS in the class (e.g. staff booked them
    // manually before approving a fallback card).
    const { booked, bookingId, messageCode, alreadyBooked } = interpretBookingResult(result)
    const success = booked || alreadyBooked
    const resultDetails = { ok: success, status: result.status, message_code: messageCode, glofox_booking_id: bookingId }
    if (success) {
      await finalizeBookingRequest(db, ctx, auditId, {
        kind: 'class_booking', status: 'actioned',
        details: { ...baseDetails, result: resultDetails },
      })
      return { booked: true, class_name: input.class_name || null, class_time: input.class_time || null }
    }
    if (bookingRejectionRoute(messageCode) === 'reply') {
      await finalizeBookingRequest(db, ctx, auditId, {
        kind: 'class_booking', status: 'failed',
        details: { ...baseDetails, result: resultDetails },
      })
      return {
        booked: false,
        reason: messageCode || 'BOOKING_FAILED',
        message: 'The booking did not go through — relay the reason honestly and offer an alternative or a handoff.',
      }
    }
    // MIA-BOOK.1 — account-shaped (or unknown) rejection: hand to a human.
    // The intent row becomes the approval card; approving re-runs the booking
    // after staff fix the account. Never tell the customer it's booked.
    const dupId = await pendingBookingApprovalId(db, ctx, input.event_id, auditId)
    const summary = `Glofox rejected this booking (${messageCode || `status_${result.status}`}). Fix the member's account (credits/membership), then Approve to retry the booking.`
    await finalizeBookingRequest(db, ctx, auditId, {
      kind: 'class_booking',
      status: dupId ? 'failed' : 'pending',
      details: {
        ...baseDetails,
        reason: dupId ? 'superseded_duplicate' : 'booking_rejected',
        ...(dupId ? { duplicate_of: dupId } : { summary }),
        result: resultDetails,
      },
    })
    if (!dupId) {
      await notifyAgentApprovalRequest(db, {
        requestId: auditId, locationId, kind: 'class_booking', customerName: ctx.nameHint,
        summary,
      })
    }
    const handoffText = String(settings?.booking_issue_handoff_text || '').trim() || DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT
    return {
      requested: true,
      booked: false,
      reason: messageCode || 'BOOKING_FAILED',
      message: `There is an account issue the team has been asked to fix before this booking can go through. Tell the customer, staying close to this wording: "${handoffText}". Never say the booking is confirmed.`,
    }
  }

  if (toolName === 'list_my_upcoming_bookings') {
    if (!verifiedContactId) {
      return { error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' }
    }
    const { data: contact } = await db.from('contacts')
      .select('glofox_member_id')
      .eq('id', verifiedContactId)
      .maybeSingle()
    if (!contact?.glofox_member_id) {
      return { error: 'not_linked', message: 'This member is not linked to the studio booking system — hand off to the team.' }
    }
    const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, fetchUserBookingsResult } =
      await import('@/lib/glofox')
    const creds = await glofoxCredentialsForLocation(db, locationId)
    if (!creds || missingGlofoxCredentialsForLocation(creds).length) {
      return { error: 'no_booking_system', message: 'Class booking is not connected at this studio — hand off to the team.' }
    }
    // windowDays:0 → time_start cutoff = now → upcoming bookings only.
    const res = await fetchUserBookingsResult(creds, contact.glofox_member_id, { windowDays: 0, limit: 100 })
    if (!res.ok) return { error: 'list_failed', message: 'Could not load their bookings just now — offer to hand off.' }
    const bookings = shapeMemberBookingsForAgent(res.bookings, Date.now())
    return bookings.length
      ? { bookings }
      : { bookings: [], message: 'No upcoming bookings found for this member.' }
  }

  if (toolName === 'cancel_class_booking') {
    let glofoxMemberId = null
    if (verifiedContactId) {
      const { data } = await db.from('contacts')
        .select('glofox_member_id')
        .eq('id', verifiedContactId)
        .maybeSingle()
      glofoxMemberId = data?.glofox_member_id || null
    }
    const guard = cancelBookingGuard({ verifiedContactId, glofoxMemberId, bookingId: input?.booking_id })
    if (!guard.ok) return guard

    const mode = bookingMode(settings)
    const baseDetails = {
      booking_id: input.booking_id,
      class_name: input.class_name || null,
      class_time: input.class_time || null,
      mode,
    }

    if (mode === 'draft') {
      const draftId = await logBookingRequest(db, ctx, {
        kind: 'class_cancellation', status: 'pending', details: baseDetails,
      })
      await notifyAgentApprovalRequest(db, {
        requestId: draftId, locationId, kind: 'class_cancellation', customerName: ctx.nameHint,
        summary: [input.class_name, input.class_time].filter(Boolean).join(' · ') || 'class cancellation to confirm',
      })
      return {
        requested: true,
        message: 'Queued for the team to confirm — tell the customer the cancellation will be confirmed shortly. Never say it is cancelled yet.',
      }
    }

    const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, cancelBooking } =
      await import('@/lib/glofox')
    const creds = await glofoxCredentialsForLocation(db, locationId)
    if (!creds || missingGlofoxCredentialsForLocation(creds).length) {
      return { error: 'no_booking_system', message: 'Class booking is not connected at this studio — hand off to the team.' }
    }
    // Intent BEFORE the side effect (see logBookingRequest).
    const auditId = await logBookingRequest(db, ctx, {
      kind: 'class_cancellation', status: 'pending', details: { ...baseDetails, stage: 'executing' },
    })
    const result = await cancelBooking(creds, input.booking_id, glofoxMemberId)
    const messageCode = result?.body?.message_code || result?.body?.message || null
    await finalizeBookingRequest(db, ctx, auditId, {
      kind: 'class_cancellation',
      status: result.ok ? 'actioned' : 'failed',
      details: { ...baseDetails, result: { ok: result.ok, status: result.status, message_code: messageCode } },
    })
    if (!result.ok) {
      return {
        cancelled: false,
        reason: messageCode || 'CANCELLATION_FAILED',
        message: 'The cancellation did not go through — relay the reason honestly (studios often block late cancellations) and offer a handoff.',
      }
    }
    return { cancelled: true, class_name: input.class_name || null, class_time: input.class_time || null }
  }

  if (toolName === 'save_lead_details') {
    const targetContactId = verifiedContactId || ctx.contactId || null
    if (!targetContactId) {
      return { error: 'no_contact', message: 'No contact linked to this conversation yet — carry on without saving.' }
    }
    const { data: existing } = await db.from('contacts')
      .select('first_name, last_name, email')
      .eq('id', targetContactId)
      .maybeSingle()
    const { patch, note } = leadDetailsPatch(existing || {}, input || {})
    const saved = []
    if (Object.keys(patch).length > 0) {
      const { error } = await db.from('contacts').update(patch).eq('id', targetContactId)
      if (!error) saved.push(...Object.keys(patch))
    }
    let noteAdded = false
    if (note) {
      const { error } = await db.from('notes').insert({ contact_id: targetContactId, content: note })
      noteAdded = !error
    }
    return { saved: true, updated_fields: saved, note_added: noteAdded }
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
    // Pre-fill from the linked contact so a KNOWN person (returning lead or
    // verified member) is never re-asked for a name/email already on file —
    // the model only needs to supply what's genuinely missing. Best-effort:
    // if there's no contact yet, resolution falls back to the model's input.
    const consultContactId = verifiedContactId || ctx.contactId || null
    let consultContact = {}
    if (consultContactId) {
      const { data } = await db.from('contacts')
        .select('first_name, last_name, email, phone')
        .eq('id', consultContactId)
        .maybeSingle()
      consultContact = data || {}
    }
    const identity = resolveConsultationIdentity({ input: input || {}, contact: consultContact, nameHint: ctx.nameHint })
    const guard = consultationInputGuard({ ...(input || {}), name: identity.name, email: identity.email })
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
      customer_name: identity.name,
      customer_email: identity.email,
      customer_phone: identity.phone,
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
        customer_name: identity.name,
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
