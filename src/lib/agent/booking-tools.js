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
import {
  linkedAccountsForContact, corroborated, findBookingAcrossAccounts, hasBookableMembership,
  electWriteAccount, fanUpcomingBookings, summariseBookingFan, directSiblingRows, reusableSibling, chunkIds,
} from '@/lib/person-accounts'
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
        starts_at: { type: 'string', description: 'The starts_at value for the chosen class, copied EXACTLY from list_upcoming_classes. Never invent or reformat it.' },
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
      // MIA-BOARD.2 — machine-readable instant, relayed back via book_class so
      // the approval row is guardable against past-start execution. The
      // display `time` stays what the customer sees.
      starts_at: new Date(startSec * 1000).toISOString(),
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
//
// PERSON-ACCT.7 — `contactId` overrides which contact the row is filed
// against. book_class elects ONE of a person's linked accounts for the write,
// and the approval executor re-runs the action against row.contact_id's
// account, so a row filed against the anchor while the booking was elected to
// a sibling would execute on the wrong account. Every booking-shaped row this
// module files names the contact whose account the write belongs to.
async function logBookingRequest(db, ctx, { kind, status, details, customerNote = null, contactId = null }) {
  try {
    const { data, error } = await db.from('agent_membership_requests').insert({
      location_id: ctx.locationId,
      contact_id: contactId || ctx.verifiedContactId || ctx.contactId || null,
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

// One pending approval per (PERSON, event): a retried tool call must not
// double-card staff. Best-effort — on lookup failure we'd rather risk a
// duplicate card than lose the fallback entirely.
//
// PERSON-ACCT.7 deduped against the contact the row would be FILED against
// (the elected account) rather than the anchor. PERSON-ACCT.9 widens that to
// the whole PERSON: one human holds 2-3 contacts rows, so a card already
// sitting on a sibling — filed by an earlier turn that elected a different
// account, or by the /start funnel — is a duplicate of this one even though
// no single contact_id matches. `personIds` carries the group plus the direct
// siblings the REUSE rule accepts (never a phone-only match — that may be a
// partner, see reusableSibling); the elected/anchor id is always included.
// Chunked at ≤150 per `.in()` (PostgREST URL length).
//
// ACCEPTED LIMITATION: still SELECT-then-INSERT with no DB constraint behind
// it (no unique index on (contact_id, kind, details->>event_id)), so two
// concurrent turns can both miss and both file. This shrinks the window; it
// does not close the race.
async function pendingBookingApprovalId(db, ctx, eventId, excludeId, contactId = null, personIds = null) {
  const ids = [...new Set([
    contactId || ctx.verifiedContactId || ctx.contactId,
    ...(Array.isArray(personIds) ? personIds : []),
  ].filter(Boolean))]
  if (!ids.length) return null
  try {
    for (const batch of chunkIds(ids)) {
      const { data } = await db.from('agent_membership_requests')
        .select('id')
        .in('contact_id', batch)
        .eq('kind', 'class_booking')
        .eq('status', 'pending')
        .contains('details', { event_id: eventId })
        .limit(5)
      const hit = (data || []).map((r) => r.id).find((id) => id && id !== excludeId)
      if (hit) return hit
    }
    return null
  } catch { return null }
}

// PERSON-ACCT.7 — live entitlement probe for ONE account, used both to
// verify a conflict before it costs a human's attention and to rescue a
// confirmed-empty election onto a sibling that still holds credits.
//
// The balance is the only per-account LIVE signal on this path, so it is
// paired with the CRM's membership flag: a genuine membership books with no
// credit records at all, and credits alone would demote every unlimited
// member. `readOk: false` is NOT a confident "no" — callers treat an
// unverifiable candidate as "not a live conflict" (which proceeds to a
// booking Glofox still arbitrates), never as "this account is empty".
async function probeAccountCredits(creds, account, fetchUserCreditsResult, computeCreditsRemaining) {
  try {
    const { ok, credits } = await fetchUserCreditsResult(creds, account.glofox_member_id)
    if (!ok) return { account, readOk: false, credits: null, entitled: false }
    const remaining = computeCreditsRemaining(credits)
    return {
      account,
      readOk: true,
      credits: remaining,
      entitled: remaining > 0 || hasBookableMembership(account),
    }
  } catch {
    return { account, readOk: false, credits: null, entitled: false }
  }
}

// Probe several accounts at once. allSettled, not all: one dead account must
// never lose the others' answers.
async function probeAccounts(creds, accounts, fetchUserCreditsResult, computeCreditsRemaining) {
  const settled = await Promise.allSettled(
    accounts.map((a) => probeAccountCredits(creds, a, fetchUserCreditsResult, computeCreditsRemaining)),
  )
  return settled.map((r, i) => (
    r.status === 'fulfilled' ? r.value : { account: accounts[i], readOk: false, credits: null, entitled: false }
  ))
}

/**
 * PERSON-ACCT.7 — the elected account is confirmed empty. Before anyone is
 * told "no credits", check the REST of this person's accounts LIVE:
 * contacts.trial_credits_remaining is a sync artefact, so a sibling can hold
 * credits the CRM-ranked election could not see.
 *
 * Eligibility mirrors electWriteAccount's rule 1 deliberately — corroborated
 * with the anchor (never a stranger's account), never classpass_payg (those
 * bookings are governed by ClassPass's own ledger). The id sort makes the
 * rescue a pure function of the account SET, not of fetch order.
 */
async function reelectSiblingWithCredits({
  creds, accounts, anchorRow, excludeMemberId, fetchUserCreditsResult, computeCreditsRemaining,
}) {
  const siblings = accounts
    .filter((a) => a && a.glofox_member_id && a.glofox_member_id !== excludeMemberId)
    .filter((a) => a.glofox_membership_status !== 'classpass_payg')
    .filter((a) => corroborated(anchorRow, a))
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
  if (!siblings.length) return null
  const probes = await probeAccounts(creds, siblings, fetchUserCreditsResult, computeCreditsRemaining)
  return probes.find((p) => p.entitled)?.account || null
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
    let membershipRow = null
    if (verifiedContactId) {
      const { data } = await db.from('contacts')
        .select('glofox_member_id, glofox_membership_status, glofox_membership_state')
        .eq('id', verifiedContactId)
        .maybeSingle()
      glofoxMemberId = data?.glofox_member_id || null
      membershipRow = data || null
    }
    const guard = classBookingGuard({ verifiedContactId, glofoxMemberId, eventId: input?.event_id })
    if (!guard.ok) return guard

    const mode = bookingMode(settings)
    // MIA-BOARD.2 — normalise the relayed instant; stamp only when it parses.
    // The list emits it and the schema says copy-exactly, so a missing or
    // junk value degrades to the legacy unguarded shape, never to a wrong
    // expiry.
    const relayedStartMs = Date.parse(input?.starts_at || '')

    const {
      glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation,
      fetchUserBookingsResult, fetchUserCreditsResult, createBooking, interpretBookingResult,
    } = await import('@/lib/glofox')
    const { computeCreditsRemaining } = await import('@/lib/glofox-sync')
    const creds = await glofoxCredentialsForLocation(db, locationId)
    // Resolved here rather than returned on: draft mode has never needed
    // Glofox credentials and must keep drafting without them (the auto lane
    // below still answers no_booking_system).
    const credsUsable = !!creds && missingGlofoxCredentialsForLocation(creds).length === 0

    // PERSON-ACCT.7 — one person routinely holds 2-3 contacts rows, each
    // linked to a DIFFERENT Glofox account, and the conversation is attached
    // to whichever one the inbound number matched. Booking that one is how a
    // real member's booking lands on an empty account. Read the whole person,
    // then elect ONE account for the write. readFailed is never "this person
    // has no accounts": it falls back to the single account this conversation
    // is attached to, i.e. the pre-election behaviour.
    const linked = verifiedContactId
      ? await linkedAccountsForContact(db, verifiedContactId)
      : { readFailed: true, contacts: [], accounts: [] }
    const accounts = linked.readFailed ? [] : linked.accounts
    const anchorRow = linked.contacts.find((c) => c && c.id === verifiedContactId) || null

    // PERSON-ACCT.9 — every contact id that is THIS PERSON, for the approval
    // dedupe below: the person group, plus the rows a direct phone/email
    // search finds that the REUSE rule accepts (a contact created by a public
    // form minutes ago is in no group yet — the group only forms when
    // detection runs). Election inputs are deliberately unchanged: this widens
    // what counts as an existing card, not what may receive a booking.
    //
    // reusableSibling, NOT corroborated: a phone-only match may be the
    // customer's partner, and couples train together, so same-number +
    // same-class is exactly the collision. Suppressing this customer's card
    // because their partner already has one leaves a real request with no card
    // at all — a silent loss, against a duplicate card staff can dismiss.
    const direct = anchorRow ? await directSiblingRows(db, { anchorRow, locationId }) : { rows: [] }
    const personIds = [...new Set([
      verifiedContactId,
      ...linked.contacts.map((c) => c && c.id),
      ...direct.rows.filter((r) => reusableSibling(anchorRow, r)).map((r) => r.id),
    ].filter(Boolean))]

    let concernsMemberIds = []
    if (credsUsable && accounts.length) {
      const fan = summariseBookingFan(
        await fanUpcomingBookings(creds, accounts, fetchUserBookingsResult),
        input.event_id,
      )
      concernsMemberIds = fan.concernsMemberIds
      if (fan.alreadyBookedOn) {
        // Glofox dedupes per member id, so its own already-booked guard
        // CANNOT see a booking sitting on this person's other account: the
        // customer ends up in the class twice, paying twice on a credits
        // account. Answer exactly as interpretBookingResult's alreadyBooked
        // path already does — the member IS in the class. No audit row is
        // written on purpose: nothing was attempted, so there is no attempt
        // to record (the existing booking has its own history).
        //
        // An UNREADABLE account is not proof of absence, but it is not
        // grounds to refuse the booking either: proceeding leaves Glofox to
        // arbitrate the elected account, which is what happened before this
        // backstop existed.
        return { booked: true, class_name: input.class_name || null, class_time: input.class_time || null }
      }
    }

    const election = electWriteAccount({ accounts, anchorContactId: verifiedContactId, concernsMemberIds, locationId })
    // 'none' — no account is readable, or every one is classpass/
    // uncorroborated — keeps the pre-election lanes exactly as they were:
    // the contact this conversation is attached to (already guarded above for
    // not_linked, and still subject to the no_credits pre-flight below).
    const elected = election.outcome === 'elected' ? election.account : null
    let electedMemberId = elected?.glofox_member_id || glofoxMemberId
    let electedContactId = elected?.id || null
    let electedRow = elected || membershipRow

    const bookingDetails = (extra = {}) => ({
      event_id: input.event_id,
      class_name: input.class_name || null,
      class_time: input.class_time || null,
      ...(Number.isFinite(relayedStartMs) ? { starts_at: new Date(relayedStartMs).toISOString() } : {}),
      mode,
      // PERSON-ACCT.7 — every booking-shaped row names the account the write
      // ran (or will run) against. The approval executor refuses to execute a
      // row whose contact no longer carries this id (ACCOUNT_MISMATCH)
      // instead of booking a class on an account nobody chose.
      elected_glofox_member_id: electedMemberId,
      ...extra,
    })

    if (election.outcome === 'conflict') {
      // PERSON-ACCT.7 — two accounts tie at the top on what the CRM knows.
      // A CRM tie is not evidence of a LIVE tie (trial_credits_remaining is a
      // sync artefact and an account can have been closed in Glofox since),
      // and a card staff cannot act on is worse than no card. Verify against
      // Glofox first: only a tie that survives live verification is worth a
      // human's attention; anything less resolves itself here.
      const candidates = election.candidates
      const probes = await probeAccounts(creds, candidates, fetchUserCreditsResult, computeCreditsRemaining)
      const live = probes.filter((p) => p.entitled)

      if (live.length >= 2) {
        const top = candidates[0]
        electedMemberId = top.glofox_member_id
        electedContactId = top.id
        electedRow = top
        // The ambiguity is STRUCTURED data, never free text stuffed into
        // details.reason (which is a machine code on class_booking rows and
        // is read as one by whyFlagged and the approval cards).
        const candidateDetails = probes.map((p) => ({
          contact_id: p.account.id,
          glofox_member_id: p.account.glofox_member_id,
          name: p.account.name || null,
          membership_status: p.account.glofox_membership_status || null,
          // null = we could not read it. NEVER rendered as zero.
          credits: p.credits,
        }))
        const summary = [input.class_name, input.class_time, 'two live accounts — Mia would not guess']
          .filter(Boolean).join(' · ')
        let approvalId = await pendingBookingApprovalId(db, ctx, input.event_id, null, top.id, personIds)
        if (!approvalId) {
          approvalId = await logBookingRequest(db, ctx, {
            kind: 'class_booking', status: 'pending', contactId: top.id,
            details: bookingDetails({ reason: 'account_conflict', candidates: candidateDetails }),
          })
          if (approvalId) {
            await notifyAgentApprovalRequest(db, {
              requestId: approvalId, locationId, kind: 'class_booking', customerName: ctx.nameHint, summary,
            })
          }
        }
        return {
          booked: false,
          account_conflict: true,
          message: 'This customer has more than one account that could hold this booking, so nothing was booked. The team has been alerted and is taking over this conversation now — your reply will not be sent, so do not compose one.',
        }
      }

      // Fewer than two verified: elect the live one, or (nothing verified at
      // all — every read down) the top-ranked candidate. A broken pre-check
      // must never block a booking that would have worked.
      const fallback = live.length === 1 ? live[0].account : candidates[0]
      electedMemberId = fallback.glofox_member_id
      electedContactId = fallback.id
      electedRow = fallback
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
    // PERSON-ACCT.7 — run against THE ELECTED ACCOUNT, not the anchor.
    {
      let credits = null
      let readFailed = false
      if (!credsUsable) {
        readFailed = true // no Glofox here — the execute path answers no_booking_system
      } else {
        try {
          // ok-aware read: a Glofox blip must NOT escalate every booking to
          // a human — only a confirmed-empty balance does.
          const { ok, credits: rows } = await fetchUserCreditsResult(creds, electedMemberId)
          if (!ok) readFailed = true
          else credits = computeCreditsRemaining(rows)
        } catch { readFailed = true }
      }
      // hasBookableMembership, NOT status === 'active' — that string never
      // occurs in contacts.glofox_membership_status (see person-accounts.js);
      // this exact check was dead code until PERSON-ACCT.3 fixed it here.
      const activeMembership = hasBookableMembership(electedRow)
      if (!readFailed && !(credits > 0) && !activeMembership) {
        // PERSON-ACCT.7 — the elected account has nothing, but this person
        // may have credits sitting on a sibling the CRM ranking could not
        // see. Re-elect to it rather than escalating a customer who is, in
        // fact, entitled to book.
        const rescue = credsUsable
          ? await reelectSiblingWithCredits({
            creds, accounts, anchorRow, excludeMemberId: electedMemberId,
            fetchUserCreditsResult, computeCreditsRemaining,
          })
          : null
        if (rescue) {
          electedMemberId = rescue.glofox_member_id
          electedContactId = rescue.id
          electedRow = rescue
        } else {
          // File the booking intent as a pending approval (deduped per
          // contact+event) so staff keep the one-tap grant-then-book flow the
          // approvals queue provides; the auto-reply loop sees no_credits on
          // this result and hands the THREAD off deterministically (script +
          // park + manager push) — the customer is never left with silence.
          let approvalId = await pendingBookingApprovalId(db, ctx, input.event_id, null, electedContactId, personIds)
          if (!approvalId) {
            approvalId = await logBookingRequest(db, ctx, {
              kind: 'class_booking', status: 'pending', contactId: electedContactId,
              details: bookingDetails({ reason: 'no_credits' }),
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
    }

    if (mode === 'draft') {
      const draftId = await logBookingRequest(db, ctx, {
        kind: 'class_booking', status: 'pending', contactId: electedContactId, details: bookingDetails(),
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

    if (!credsUsable) {
      return { error: 'no_booking_system', message: 'Class booking is not connected at this studio — hand off to the team.' }
    }
    // Intent BEFORE the side effect (see logBookingRequest).
    const auditId = await logBookingRequest(db, ctx, {
      kind: 'class_booking', status: 'pending', contactId: electedContactId,
      details: bookingDetails({ stage: 'executing' }),
    })
    const result = await createBooking(creds, {
      user_id: electedMemberId,
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
        details: bookingDetails({ result: resultDetails }),
      })
      return { booked: true, class_name: input.class_name || null, class_time: input.class_time || null }
    }
    if (bookingRejectionRoute(messageCode) === 'reply') {
      await finalizeBookingRequest(db, ctx, auditId, {
        kind: 'class_booking', status: 'failed',
        details: bookingDetails({ result: resultDetails }),
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
    const dupId = await pendingBookingApprovalId(db, ctx, input.event_id, auditId, electedContactId, personIds)
    const summary = `Glofox rejected this booking (${messageCode || `status_${result.status}`}). Fix the member's account (credits/membership), then Approve to retry the booking.`
    await finalizeBookingRequest(db, ctx, auditId, {
      kind: 'class_booking',
      status: dupId ? 'failed' : 'pending',
      details: bookingDetails({
        reason: dupId ? 'superseded_duplicate' : 'booking_rejected',
        ...(dupId ? { duplicate_of: dupId } : { summary }),
        result: resultDetails,
      }),
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
    // PERSON-ACCT.2 — one person routinely holds 2-3 `contacts` rows, each
    // linked to a DIFFERENT Glofox account, and the conversation is attached
    // to whichever one the inbound number matched. Reading that one account
    // is how Mia told a real member "you have no upcoming bookings" while the
    // booking sat on a sibling account. Read the whole person instead.
    const linked = await linkedAccountsForContact(db, verifiedContactId)
    const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, fetchUserBookingsResult } =
      await import('@/lib/glofox')

    let accounts
    if (linked.readFailed) {
      // Could not resolve the person at all — fall back to the one account
      // this conversation is attached to. Behaviourally identical to the
      // pre-PERSON-ACCT.2 lane (same row shape, same sort, same cap); it
      // just runs through the shared merge below. readFailed is never
      // "this person has no accounts".
      const { data: contact } = await db.from('contacts')
        .select('glofox_member_id')
        .eq('id', verifiedContactId)
        .maybeSingle()
      if (!contact?.glofox_member_id) {
        return { error: 'not_linked', message: 'This member is not linked to the studio booking system — hand off to the team.' }
      }
      accounts = [{ id: verifiedContactId, glofox_member_id: contact.glofox_member_id }]
    } else if (linked.accounts.length) {
      accounts = linked.accounts
    } else if (linked.contacts.length) {
      // Rows read fine and not one of them carries a Glofox link: the
      // existing not_linked lane is the honest answer.
      return { error: 'not_linked', message: 'This member is not linked to the studio booking system — hand off to the team.' }
    } else {
      // No error, but no rows either — nothing here justifies telling the
      // customer they are not linked, so answer with the honest uncertainty.
      return { error: 'list_failed', message: 'Could not load their bookings just now — offer to hand off.' }
    }

    const creds = await glofoxCredentialsForLocation(db, locationId)
    if (!creds || missingGlofoxCredentialsForLocation(creds).length) {
      return { error: 'no_booking_system', message: 'Class booking is not connected at this studio — hand off to the team.' }
    }
    // PERSON-ACCT.7 — the shared fan-out (windowDays:0 → upcoming only;
    // allSettled, so one dead account never loses the others' rows). book_class
    // and cancel_class_booking read the same helper, so the window, the cap and
    // what counts as an unreadable account cannot drift between them.
    const reads = await fanUpcomingBookings(creds, accounts, fetchUserBookingsResult)

    const nowMs = Date.now()
    // Shape ONE raw row at a time: same helper, same filtering (still-BOOKED,
    // still in the future, same Dublin labels), but each shaped row keeps the
    // numeric start it came from — the shaper drops it, since it is not part
    // of the model's view, and the Dublin label does not sort.
    //
    // The rows handed back carry NOTHING about which account they came from.
    // The whole tool result is JSON-stringified into the model's context, so
    // a per-row glofox_member_id would put internal account ids in front of
    // the model on every list turn for no gain: cancel_class_booking
    // re-locates ownership server-side (findBookingAcrossAccounts) and never
    // trusts the model for it.
    const merged = []
    let failedReads = 0
    reads.forEach((res) => {
      if (!res.ok) {
        failedReads += 1
        return
      }
      for (const raw of res.bookings) {
        const [shaped] = shapeMemberBookingsForAgent([raw], nowMs)
        if (!shaped) continue
        // No `|| 0` fallback: the shaper only emits a row whose time_start is
        // finite and in the future, so an unparseable start cannot reach here
        // — and a NaN sort key surfacing loudly beats one silently sorting a
        // junk row to the top of the customer's list.
        merged.push({ row: shaped, start: Number(raw.time_start) })
      }
    })

    // Stable sort on equal starts keeps account order, so the copy kept for a
    // booking visible on two accounts is the first one reported.
    merged.sort((a, b) => a.start - b.start)
    const seen = new Set()
    const bookings = []
    for (const { row } of merged) {
      if (row.booking_id) {
        if (seen.has(row.booking_id)) continue
        seen.add(row.booking_id)
      }
      bookings.push(row)
      if (bookings.length >= MAX_MEMBER_BOOKINGS) break
    }

    // An unreadable account must NEVER surface as "you have nothing booked" —
    // that false negative is the whole reason this task exists. With nothing
    // to show and a read we could not complete, answer the honest
    // could-not-load instead (byte-for-byte the pre-existing lane). This one
    // clause covers the all-failed case too: `accounts` is never empty here
    // (the zero-account lanes returned above), so every read failing implies
    // no rows.
    if (failedReads > 0 && bookings.length === 0) {
      return { error: 'list_failed', message: 'Could not load their bookings just now — offer to hand off.' }
    }
    if (failedReads > 0) {
      return {
        bookings,
        incomplete: true,
        message: 'One of this member\'s linked accounts could not be read, so this list may be missing bookings. Relay the ones shown, say you may not be seeing everything, and offer to check with the team.',
      }
    }
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

    const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, cancelBooking, fetchUserBookingsResult } =
      await import('@/lib/glofox')
    const creds = await glofoxCredentialsForLocation(db, locationId)
    // Resolved here rather than returned on, because draft mode has never
    // needed Glofox credentials and must keep drafting without them.
    const credsUsable = !!creds && missingGlofoxCredentialsForLocation(creds).length === 0

    // PERSON-ACCT.2 — the booking the customer is talking about often lives
    // on a SIBLING contact's Glofox account (list_my_upcoming_bookings now
    // shows all of them), and cancelling it against the acting contact's
    // account simply fails. Find the account that actually holds it, BEFORE
    // the draft branch: the class_cancellation approval executor cancels
    // against row.contact_id's account, so until it honours an
    // executing_contact_id override (PR2) a sibling-owned draft would
    // execute against the wrong account just as surely as an auto cancel.
    let executingMemberId = glofoxMemberId
    let ownerDetails = {}
    const linked = credsUsable ? await linkedAccountsForContact(db, verifiedContactId) : { readFailed: true, contacts: [], accounts: [] }
    if (!linked.readFailed && linked.accounts.length) {
      const { owner, unreadable } = await findBookingAcrossAccounts(
        creds, linked.accounts, input.booking_id, fetchUserBookingsResult,
      )
      if (!owner && unreadable.length) {
        // An account we could not read is not evidence of absence. Never let
        // it become "that booking does not exist".
        return {
          cancelled: false,
          reason: 'CANCELLATION_UNCERTAIN',
          message: 'The system could not check all of this member\'s linked accounts just now, so nothing was cancelled. Do NOT say the booking does not exist — say you cannot check it right now and offer to hand off to the team.',
        }
      }
      if (owner && owner.glofox_member_id !== glofoxMemberId) {
        // Acting on another contact's account is only safe when this really
        // is the same person (shared phone or email) AND that account is one
        // we control — a ClassPass PAYG booking is managed by ClassPass, so
        // staff handle it out of band. In DRAFT mode no sibling qualifies at
        // all, corroborated or not: the executor would run it against the
        // wrong account (see above), so staff take it by hand.
        //
        // None of these lanes file an approval row on purpose: an
        // approvals-queue class_cancellation re-runs the cancel against the
        // ACTING contact's account, which is precisely the wrong account
        // here. The handoff the message asks for is the right escalation
        // (it pages managers and parks the thread).
        const anchorRow = linked.contacts.find((c) => c && c.id === verifiedContactId) || null
        const classpass = owner.glofox_membership_status === 'classpass_payg'
        if (mode === 'draft' || classpass || !corroborated(anchorRow, owner)) {
          return {
            cancelled: false,
            needs_staff: true,
            message: 'This booking is managed outside the direct account (or on a linked account we could not confirm). Tell the customer the team will sort the cancellation now, and hand off.',
          }
        }
        executingMemberId = owner.glofox_member_id
        ownerDetails = { executing_contact_id: owner.id, executing_glofox_member_id: owner.glofox_member_id }
      }
      // owner === null with every account readable falls through on purpose:
      // Glofox arbitrates, exactly as it did before this task. The lookup
      // window is upcoming-only, so "not in the list" is not proof of
      // absence (a class that started minutes ago is already out of it) and
      // Glofox's own reason — usually a late-cancellation rule — is the
      // honest answer.
    }

    // The booking is on the acting contact's own account (or ownership could
    // not be resolved at all) — draft exactly as before.
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

    if (!credsUsable) {
      return { error: 'no_booking_system', message: 'Class booking is not connected at this studio — hand off to the team.' }
    }

    const details = { ...baseDetails, ...ownerDetails }
    // Intent BEFORE the side effect (see logBookingRequest).
    const auditId = await logBookingRequest(db, ctx, {
      kind: 'class_cancellation', status: 'pending', details: { ...details, stage: 'executing' },
    })
    const result = await cancelBooking(creds, input.booking_id, executingMemberId)
    const messageCode = result?.body?.message_code || result?.body?.message || null
    await finalizeBookingRequest(db, ctx, auditId, {
      kind: 'class_cancellation',
      status: result.ok ? 'actioned' : 'failed',
      details: { ...details, result: { ok: result.ok, status: result.status, message_code: messageCode } },
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
