// AGENT-EVENTS.1 — the customer agent's race/events tools (read-only
// phase). Events are OUR platform (race_events + race_waves +
// race_registrations, migs 082-084/122) so listings come straight
// from the DB — always fresh, no knowledge import. Kinds: race,
// workshop, seminar, open_day, masterclass.
//
// Payment NEVER happens in chat — paid events get their public
// signup link (/race/[slug]) where the Revolut widget owns card
// entry. Phase 2 adds direct booking for events that are free for
// the person asking; phase 3 adds cancel/reschedule.
//
// AUTH MODEL (MIA-REVIEW.3) — who may act on what:
//   list_upcoming_events        public listing, no identity needed.
//   get_my_event_registrations  reads the registrations of the contact
//     this conversation is bound to (verified contact preferred). Read
//     only, event name/date/wave only — no account or billing data.
//   book_event                  a brand-new person entering a FREE event
//     with their name + email needs NO verification (same call as
//     consultations: demanding a quiz mid-signup kills the entry). But
//     acting on an EXISTING MEMBER's account — a contact linked to the
//     studio's booking system — requires verify_identity, exactly like
//     the class tools.
//   cancel_event_registration /
//   reschedule_event_wave       ALWAYS require verify_identity, like
//     cancel_class_booking. These change something the customer already
//     has; the previous `verifiedContactId || contactId` gate let an
//     unverified sender on a thread bound to a contact (a duplicate /
//     shared WhatsApp number, where auto-verify deliberately bails) cancel
//     that contact's race entry on channel possession alone.
//
// Pure helpers tested in event-tools.test.js; executor does the IO
// and never throws (mirrors executeBookingTool).
//
// PERSON-ACCT.4 — one person routinely holds 2-3 `contacts` rows (linked via
// person_groups/person_group_members), each a different account. Before this
// task get_my_event_registrations / cancel_event_registration /
// reschedule_event_wave / book_event's member gate all read the single acting
// contact row, so a customer whose registration or Glofox membership sits on
// a sibling row got told they had no registration (live incident, "Julie
// Cross") or was charged/refused as a non-member despite a real membership on
// a sibling account. `linkedAccountsForContact`/`hasBookableMembership` are
// the shared PERSON-ACCT.1/.3 helpers — see person-accounts.js; NOT modified
// here.

import { linkedAccountsForContact, hasBookableMembership } from '@/lib/person-accounts'

export const EVENT_TOOLS = [
  {
    name: 'list_upcoming_events',
    description:
      "List the studio's upcoming special events — races (e.g. Hyrox sims), workshops, " +
      'seminars, open days, masterclasses — with dates, start waves, pricing and ' +
      'the signup link. Waves carry full and limited flags, never a count: never tell the ' +
      'customer how many spaces are left. No verification needed. Use when someone asks about races/events, or ' +
      'AFTER answering their question when an event is genuinely relevant to their interests. ' +
      'For paid events, share the signup link — payment happens securely on that page.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_event_registrations',
    description:
      "The customer's own upcoming event registrations (event, date, wave, status). Works for " +
      'the person this conversation belongs to. Use when they ask "am I signed up for the ' +
      'race?", "what wave am I in?".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'book_event',
    description:
      'Register the customer (solo entry) for an upcoming event from list_upcoming_events — ' +
      'ONLY when the event is free for them (the tool refuses paid entries and tells you to ' +
      'share the signup link instead; team entries also go via the link). CRITICAL: restate ' +
      'the exact event, date and wave time and get a clear yes before calling. For someone ' +
      'new, collect their full name and email first — the confirmation goes there. For an ' +
      'existing member, identity must be verified first (the tool says so if it is not).',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The event_id from list_upcoming_events.' },
        wave_id: { type: 'string', description: 'The wave_id they chose (required when the event has multiple waves).' },
        event_name: { type: 'string', description: 'The event name you confirmed with the customer.' },
        event_date: { type: 'string', description: 'The date you confirmed, as shown in the list.' },
        name: { type: 'string', description: "Full name, if they're new or not on file." },
        email: { type: 'string', description: 'Email address, if not on file — confirmations go there.' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'cancel_event_registration',
    description:
      "Cancel one of the VERIFIED customer's own upcoming event registrations from " +
      'get_my_event_registrations (identity must be verified first, same as cancelling a ' +
      'class). CRITICAL: restate the exact event and date and get a clear ' +
      'yes before calling. FREE entries cancel immediately. PAID entries are passed to the ' +
      'team to confirm (they also handle any refund question) — tell the customer the team ' +
      "will confirm shortly and NEVER promise a refund yourself.",
    input_schema: {
      type: 'object',
      properties: {
        registration_id: { type: 'string', description: 'The registration_id from get_my_event_registrations.' },
        event_name: { type: 'string', description: 'The event name you confirmed with the customer.' },
        event_date: { type: 'string', description: 'The date you confirmed.' },
      },
      required: ['registration_id'],
    },
  },
  {
    name: 'reschedule_event_wave',
    description:
      "Move the VERIFIED customer's registration to a DIFFERENT START WAVE of the SAME event " +
      '(e.g. from the 9am wave to the 10:30 wave), capacity permitting, once their identity ' +
      'is verified. Get the wave_id from ' +
      'list_upcoming_events and confirm the new time with them first. Moving to a different ' +
      'EVENT is a cancel + a new booking — handle those separately with their own confirmations.',
    input_schema: {
      type: 'object',
      properties: {
        registration_id: { type: 'string', description: 'The registration_id from get_my_event_registrations.' },
        new_wave_id: { type: 'string', description: 'The target wave_id from list_upcoming_events.' },
        new_wave_time: { type: 'string', description: 'The new wave time you confirmed with the customer.' },
      },
      required: ['registration_id', 'new_wave_id'],
    },
  },
]

export const EVENT_TOOL_NAMES = new Set(EVENT_TOOLS.map(t => t.name))

// ── pure helpers ────────────────────────────────────────────────────

function euro(cents) {
  const n = (Number(cents) || 0) / 100
  return `€${Number.isInteger(n) ? n : n.toFixed(2)}`
}

/** Human pricing summary from the mig-084 fee columns. Pure. */
export function formatEventPrice({
  member_pricing_enabled,
  member_fee_cents,
  non_member_fee_cents,
  members_only,
} = {}) {
  if (member_pricing_enabled) {
    const memberPart = member_fee_cents == null ? 'Free for members' : `${euro(member_fee_cents)} members`
    if (members_only) return `${memberPart} (members only)`
    const nonMemberPart = non_member_fee_cents == null ? 'free for non-members' : `${euro(non_member_fee_cents)} non-members`
    return `${memberPart} / ${nonMemberPart}`
  }
  if (non_member_fee_cents == null) {
    return members_only ? 'Free (members only)' : 'Free'
  }
  return `${euro(non_member_fee_cents)} per person${members_only ? ' (members only)' : ''}`
}

/** Is this event open for registration right now? Pure. */
export function eventOpenForRegistration(race, nowMs) {
  if (!race || race.active === false) return { open: false, reason: 'inactive' }
  if (!race.race_date || String(race.race_date) < dublinToday(nowMs)) return { open: false, reason: 'past' }
  if (race.registration_opens_at && nowMs < Date.parse(race.registration_opens_at)) {
    return { open: false, reason: 'not_open_yet' }
  }
  if (race.registration_closes_at && nowMs > Date.parse(race.registration_closes_at)) {
    return { open: false, reason: 'closed' }
  }
  return { open: true }
}

/** Remaining capacity for a wave (null = unlimited). Pure. */
export function waveSpotsLeft(wave, taken) {
  if (wave?.capacity == null) return null
  return Math.max(0, wave.capacity - (Number(taken) || 0))
}

/**
 * AGENT-EVENTS.3 — how a cancellation request routes. Free entries
 * cancel directly; paid entries go to human approval (refunds are
 * decided per case by the team — Richard, 2026-06-12). Pure.
 */
export function classifyEventCancellation({ isOwner, status, eventDate, paidCents, nowMs } = {}) {
  if (!isOwner) return { action: null, reason: 'not_yours' }
  if (status === 'cancelled' || status === 'no_show') return { action: null, reason: 'already_cancelled' }
  if (!eventDate || String(eventDate) < dublinToday(nowMs)) return { action: null, reason: 'event_past' }
  return (Number(paidCents) || 0) > 0 ? { action: 'draft' } : { action: 'direct' }
}

const DUBLIN_DATE_FMT = new Intl.DateTimeFormat('en-IE', {
  timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short',
})

// race_date is a DATE (Dublin wall-clock by convention) — anchor on
// noon UTC so the label never shifts a day in any timezone (the
// booking-confirmations lesson).
function dateLabel(dateStr) {
  const parts = {}
  for (const p of DUBLIN_DATE_FMT.formatToParts(new Date(`${dateStr}T12:00:00Z`))) {
    parts[p.type] = p.value
  }
  return `${parts.weekday} ${parts.day} ${parts.month}`
}

function dublinToday(nowMs) {
  // en-CA gives YYYY-MM-DD, comparable to the DATE column as a string.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(nowMs))
}

const MAX_EVENTS = 8
const MAX_DESCRIPTION = 200

// CAPACITY-SECRECY.1 — a wave with this many places or fewer is "limited".
// Same coarse signal as the class list: urgency without a number.
const LIMITED_SPOTS_THRESHOLD = 3

/**
 * Shape race_events rows (waves embedded) for the agent: open-for-
 * registration future events with per-wave availability, pricing and
 * the public signup link. Pure.
 *
 * CAPACITY-SECRECY.1 — per-wave availability is the `full` / `limited`
 * booleans ONLY (matching the public signup widget's is_full, CHANGELOG #94).
 * The model is never handed a count, so it can never relay one — and the
 * counts here were wrong for customers anyway (a TEAM count on team events).
 *
 * @param {Array} events    race_events rows with `waves` embedded
 * @param {Object} takenByWave  wave_id → non-cancelled registration count
 * @param {number} nowMs
 * @param {string} appUrl   origin for the signup link
 */
export function shapeEventsForAgent(events, takenByWave, nowMs, appUrl) {
  const today = dublinToday(nowMs)
  const out = []
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.active === false) continue
    if (!e.race_date || String(e.race_date) < today) continue
    if (e.registration_opens_at && nowMs < Date.parse(e.registration_opens_at)) continue
    if (e.registration_closes_at && nowMs > Date.parse(e.registration_closes_at)) continue
    const waves = (e.waves || [])
      .slice()
      .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))
      .map((w) => {
        const taken = Number(takenByWave?.[w.id]) || 0
        const spotsLeft = w.capacity == null ? null : Math.max(0, w.capacity - taken)
        return {
          wave_id: w.id,
          time: String(w.start_time || '').slice(0, 5),
          ...(w.label ? { label: w.label } : {}),
          ...(spotsLeft === 0 ? { full: true } : {}),
          ...(spotsLeft != null && spotsLeft > 0 && spotsLeft <= LIMITED_SPOTS_THRESHOLD
            ? { limited: true }
            : {}),
        }
      })
    out.push({
      event_id: e.id,
      name: e.name,
      kind: e.kind || 'race',
      date: dateLabel(String(e.race_date)),
      race_date: String(e.race_date),
      price: formatEventPrice(e),
      ...(e.description ? { description: String(e.description).replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION) } : {}),
      waves,
      signup_url: `${appUrl}/race/${e.slug}`,
    })
  }
  out.sort((a, b) => a.race_date.localeCompare(b.race_date))
  return out.slice(0, MAX_EVENTS).map(({ race_date: _omitted, ...rest }) => rest)
}

/** The customer's live future registrations. Pure. */
export function shapeMyRegistrationsForAgent(rows, nowMs) {
  const today = dublinToday(nowMs)
  const out = []
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.status === 'cancelled' || r.status === 'no_show') continue
    const ev = r.race_events || {}
    if (!ev.race_date || String(ev.race_date) < today) continue
    out.push({
      registration_id: r.id,
      event_name: ev.name || 'Event',
      kind: ev.kind || 'race',
      date: dateLabel(String(ev.race_date)),
      ...(r.race_waves?.start_time ? { wave_time: String(r.race_waves.start_time).slice(0, 5) } : {}),
      status: r.status,
    })
  }
  return out
}

// PERSON-ACCT.4 — chunk any `.in()` at ≤150 ids (house rule / PostgREST
// URL-length limit, BUG-FIX #538). Person groups are 2-6 rows in practice so
// this loop almost always runs once; the cap is house law regardless.
const ID_CHUNK_SIZE = 150
function chunkIds(ids, size = ID_CHUNK_SIZE) {
  const out = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

// Fetch this person's group's live future registrations, chunked. Throws on
// the first Postgrest error so the caller's try/catch can fall back to the
// single-contact read — an unreadable group must never present as "no
// registrations".
async function fetchRegistrationsForContactIds(db, ids, locationId, today) {
  const rows = []
  for (const batch of chunkIds(ids)) {
    const { data, error } = await db.from('race_registrations')
      .select('id, status, race_events!inner(name, kind, race_date, location_id), race_waves(start_time)')
      .in('contact_id', batch)
      .eq('race_events.location_id', locationId)
      .gte('race_events.race_date', today)
      .limit(20)
    if (error) throw error
    rows.push(...(data || []))
  }
  return rows
}

// ── executor (IO) ───────────────────────────────────────────────────
// ctx: { db, locationId, contactId, verifiedContactId }
export async function executeEventTool(toolName, input, ctx) {
  const { db, locationId, contactId, verifiedContactId } = ctx

  if (toolName === 'list_upcoming_events') {
    const { getAppUrl } = await import('@/lib/app-url')
    const today = dublinToday(Date.now())
    const { data: events } = await db.from('race_events')
      .select('id, name, kind, slug, description, race_date, active, registration_opens_at, registration_closes_at, member_pricing_enabled, member_fee_cents, non_member_fee_cents, members_only, waves:race_waves(id, start_time, capacity, label)')
      .eq('location_id', locationId)
      .eq('active', true)
      .gte('race_date', today)
      .order('race_date', { ascending: true })
      .limit(15)
    if (!events?.length) {
      return { events: [], message: 'No upcoming special events on the calendar right now.' }
    }
    const waveIds = events.flatMap((e) => (e.waves || []).map((w) => w.id))
    const takenByWave = {}
    if (waveIds.length) {
      // eslint-disable-next-line guardrails/no-uncapped-supabase-limit -- counts only derive the full/limited flags across a race's waves; domain-bounded under 1000
      const { data: regs } = await db.from('race_registrations')
        .select('wave_id, status')
        .in('wave_id', waveIds)
        .not('status', 'in', '("cancelled","no_show")')
        .limit(2000)
      for (const r of regs || []) {
        if (r.wave_id) takenByWave[r.wave_id] = (takenByWave[r.wave_id] || 0) + 1
      }
    }
    return { events: shapeEventsForAgent(events, takenByWave, Date.now(), getAppUrl()) }
  }

  if (toolName === 'get_my_event_registrations') {
    const targetContactId = verifiedContactId || contactId || null
    if (!targetContactId) {
      return { error: 'no_contact', message: 'No contact is linked to this conversation — ask the team to check instead.' }
    }
    const today = dublinToday(Date.now())

    // PERSON-ACCT.4 — the registration can sit on ANY contact row in this
    // person's group, not just the one this conversation is bound to. Fan the
    // read out across the whole group; an unreadable group falls back to the
    // pre-existing single-contact read, never a confident "no registrations".
    let rows = null
    const linked = await linkedAccountsForContact(db, targetContactId)
    if (!linked.readFailed) {
      const ids = linked.contacts.map((c) => c?.id).filter(Boolean)
      try {
        rows = await fetchRegistrationsForContactIds(db, ids, locationId, today)
      } catch (err) {
        console.error('[agent][events] get_my_event_registrations group read failed:', err?.message || err)
        rows = null // fall through to the single-contact read below
      }
    }
    if (rows == null) {
      const { data } = await db.from('race_registrations')
        .select('id, status, race_events!inner(name, kind, race_date, location_id), race_waves(start_time)')
        .eq('contact_id', targetContactId)
        .eq('race_events.location_id', locationId)
        .gte('race_events.race_date', today)
        .limit(20)
      rows = data
    }
    const registrations = shapeMyRegistrationsForAgent(rows, Date.now())
    return registrations.length
      ? { registrations }
      : { registrations: [], message: 'No upcoming event registrations found for this person.' }
  }

  if (toolName === 'book_event') {
    const targetContactId = verifiedContactId || contactId || null
    if (!targetContactId) {
      return { error: 'no_contact', message: 'No contact linked to this conversation — collect their name and email, then hand off to the team.' }
    }
    const { data: race } = await db.from('race_events')
      .select('id, name, kind, slug, description, race_date, active, location_id, capacity_mode, registration_opens_at, registration_closes_at, member_pricing_enabled, member_fee_cents, non_member_fee_cents, members_only, payment_currency, waves:race_waves(id, start_time, capacity, label)')
      .eq('id', String(input?.event_id || ''))
      .eq('location_id', locationId)
      .maybeSingle()
    if (!race) return { error: 'not_found', message: 'That event was not found — re-check list_upcoming_events.' }

    const openCheck = eventOpenForRegistration(race, Date.now())
    if (!openCheck.open) {
      return { booked: false, reason: openCheck.reason, message: 'Registration is not open for this event — say so honestly and offer alternatives.' }
    }

    // Fill-empty contact details from the conversation, then read back.
    const { data: existing } = await db.from('contacts')
      .select('id, name, first_name, last_name, email, phone, glofox_member_id')
      .eq('id', targetContactId)
      .maybeSingle()
    if (!existing) return { error: 'no_contact', message: 'Contact not found — hand off to the team.' }

    // AUTH (MIA-REVIEW.3) — see the file header. A brand-new person entering a
    // free event stays verification-free (that is the designed flow, same as
    // consultations), but the moment we would act on an EXISTING MEMBER's
    // account the class-tool rule applies: verify first. Membership is the
    // signal, because that is the account with something to lose.
    if (!verifiedContactId && existing.glofox_member_id) {
      return {
        error: 'not_verified',
        message: 'This is an existing member account — run verify_identity first, then book the entry.',
      }
    }
    const patch = {}
    const emailIn = String(input?.email || '').trim().toLowerCase()
    if (emailIn && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailIn) && !String(existing.email || '').trim()) patch.email = emailIn
    const nameIn = String(input?.name || '').trim()
    if (nameIn && !String(existing.name || '').trim()) patch.name = nameIn
    if (Object.keys(patch).length) await db.from('contacts').update(patch).eq('id', targetContactId)
    const contact = { ...existing, ...patch }
    if (!String(contact.email || '').trim()) {
      return { error: 'need_email', message: 'Ask for their email address first — the confirmation goes there.' }
    }

    const auditDetails = {
      event_id: race.id,
      wave_id: input?.wave_id || null,
      event_name: input?.event_name || race.name,
      event_date: input?.event_date || String(race.race_date),
    }

    // Draft mode parity with class bookings: queue for one-tap approval.
    const { bookingMode } = await import('./booking-tools')
    if (bookingMode(ctx.settings) === 'draft') {
      const draftId = await logEventRequest(db, ctx, { kind: 'event_booking', status: 'pending', details: { ...auditDetails, mode: 'draft' } })
      const { notifyAgentApprovalRequest } = await import('./approval-notify')
      await notifyAgentApprovalRequest(db, {
        requestId: draftId, locationId: ctx.locationId, kind: 'event_booking', customerName: ctx.nameHint,
        summary: [auditDetails.event_name, auditDetails.event_date].filter(Boolean).join(' · ') || 'event booking to confirm',
      })
      return { requested: true, message: 'Queued for the team to confirm — tell the customer they will hear back shortly. Never say it is booked yet.' }
    }

    // PERSON-ACCT.4 — member pricing / members-only gates on
    // validateMemberByEmail (registerSoloEventEntry → member-validation.js),
    // which matches the acting contact's OWN email against
    // contacts.pipeline_stage_slug — it never sees a sibling contact row. The
    // person's REAL Glofox membership can live on a sibling account, so widen
    // the signal: if ANY row in this person's group carries a genuinely
    // bookable membership (hasBookableMembership — see person-accounts.js for
    // why `glofox_membership_status === 'active'` alone never fires in prod),
    // count the entrant as a member too. readFailed → no override, i.e. the
    // unchanged single-contact/email-only behaviour.
    let memberOverride = false
    if (race.member_pricing_enabled || race.members_only) {
      const linkedForMembership = await linkedAccountsForContact(db, targetContactId)
      if (!linkedForMembership.readFailed) {
        memberOverride = linkedForMembership.contacts.some((c) => hasBookableMembership(c))
      }
    }

    const { registerSoloEventEntry } = await import('@/lib/race-register-solo')
    const result = await registerSoloEventEntry(db, { race, waveId: input?.wave_id || null, contact, memberOverride })
    await logEventRequest(db, ctx, {
      kind: 'event_booking',
      status: result.ok ? 'actioned' : 'failed',
      details: { ...auditDetails, mode: 'auto', result: { ok: result.ok, reason: result.reason || null } },
    })

    if (result.ok) {
      return { booked: true, event_name: race.name, event_date: auditDetails.event_date }
    }
    if (result.reason === 'requires_payment') {
      const { getAppUrl } = await import('@/lib/app-url')
      return {
        booked: false,
        requires_payment: true,
        price: formatEventPrice(race),
        signup_url: `${getAppUrl()}/race/${race.slug}`,
        message: 'This entry has a fee — share the signup link so they can register and pay securely there. Never collect payment in chat.',
      }
    }
    if (result.reason === 'already_registered') {
      return { booked: false, reason: 'already_registered', message: 'They already have an entry for this event — confirm that warmly.' }
    }
    if (result.reason === 'members_only') {
      return { booked: false, reason: 'members_only', message: 'This event is members-only and they could not be verified as a member — explain and offer the team.' }
    }
    if (result.reason === 'wave_full') {
      return { booked: false, reason: 'wave_full', message: 'That wave just filled — offer another wave or event from the list.' }
    }
    if (result.reason === 'need_email') {
      return { error: 'need_email', message: 'Ask for their email address first.' }
    }
    if (result.reason === 'bad_wave') {
      return { error: 'bad_wave', message: result.message || 'Pick a wave from list_upcoming_events.' }
    }
    return { booked: false, reason: result.reason, message: 'The registration did not go through — relay honestly and offer a handoff.' }
  }

  if (toolName === 'cancel_event_registration' || toolName === 'reschedule_event_wave') {
    // AUTH (MIA-REVIEW.3) — changing something the customer already HAS needs
    // the same hard verification as cancel_class_booking. The old
    // `verifiedContactId || contactId` gate let an unverified sender on a
    // thread bound to a contact (a duplicate / shared WhatsApp number, where
    // auto-verify deliberately bails) cancel that contact's entry on channel
    // possession alone.
    const targetContactId = verifiedContactId || null
    if (!targetContactId) {
      return contactId
        ? { error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first, then retry.' }
        : { error: 'no_contact', message: 'No contact linked to this conversation — hand off to the team.' }
    }
    const { data: reg } = await db.from('race_registrations')
      .select('id, status, contact_id, wave_id, race_events!inner(id, name, race_date, location_id)')
      .eq('id', String(input?.registration_id || ''))
      .eq('race_events.location_id', locationId)
      .maybeSingle()
    if (!reg) return { error: 'not_found', message: 'That registration was not found — re-check get_my_event_registrations.' }

    // PERSON-ACCT.4 — ownership must span the whole person group: the
    // registration routinely sits on a SIBLING contact row, not the verified
    // acting one. Unlike the class-booking sibling path (booking-tools.js),
    // which additionally demands corroboration (a shared phone/email) before
    // trusting a Glofox account as the same person, NO extra corroboration is
    // required here: race_registrations is a row this CRM owns outright, and
    // person_group_members is this CRM's OWN assertion that these contact
    // rows are the same human — there is no external system's competing
    // ownership claim to cross-check, the way a Glofox member id is. An
    // unreadable group (`readFailed`) falls back to the original
    // acting-contact-only check, never a confident wrong answer.
    const linkedForOwnership = await linkedAccountsForContact(db, targetContactId)
    const ownerIds = linkedForOwnership.readFailed
      ? [targetContactId]
      : linkedForOwnership.contacts.map((c) => c?.id).filter(Boolean)
    const isOwner = ownerIds.includes(reg.contact_id)

    if (toolName === 'reschedule_event_wave') {
      if (!isOwner) {
        return { error: 'not_yours', message: 'That registration belongs to someone else — hand off to the team.' }
      }
      const { moveRegistrationWave } = await import('@/lib/race-cancel')
      const result = await moveRegistrationWave(db, reg.id, String(input?.new_wave_id || ''))
      await logEventRequest(db, ctx, {
        kind: 'event_booking',
        status: result.ok ? 'actioned' : 'failed',
        details: { action: 'reschedule_wave', registration_id: reg.id, event_name: reg.race_events.name, new_wave_id: input?.new_wave_id || null, result },
      })
      if (result.ok) {
        return { rescheduled: true, event_name: reg.race_events.name, new_wave_time: input?.new_wave_time || null }
      }
      if (result.error === 'wave_full') {
        return { rescheduled: false, reason: 'wave_full', message: 'That wave is full — offer another wave from the list.' }
      }
      if (result.error === 'wrong_event') {
        return { error: 'wrong_event', message: 'That wave belongs to a different event — a different event is a cancel + new booking.' }
      }
      return { rescheduled: false, reason: result.error, message: 'The move did not go through — relay honestly and offer a handoff.' }
    }

    // cancel_event_registration
    const { registrationPaidCents, cancelRaceRegistration } = await import('@/lib/race-cancel')
    const paidCents = await registrationPaidCents(db, reg.id)
    const decision = classifyEventCancellation({
      isOwner,
      status: reg.status,
      eventDate: String(reg.race_events.race_date),
      paidCents,
      nowMs: Date.now(),
    })
    const auditDetails = {
      registration_id: reg.id,
      event_id: reg.race_events.id,
      event_name: input?.event_name || reg.race_events.name,
      event_date: input?.event_date || String(reg.race_events.race_date),
      paid_cents: paidCents,
    }
    if (decision.action === 'direct') {
      const result = await cancelRaceRegistration(db, reg.id)
      await logEventRequest(db, ctx, {
        kind: 'event_cancellation',
        status: result.ok ? 'actioned' : 'failed',
        details: { ...auditDetails, mode: 'auto', result },
      })
      return result.ok
        ? { cancelled: true, event_name: auditDetails.event_name, event_date: auditDetails.event_date }
        : { cancelled: false, message: 'The cancellation did not go through — relay honestly and offer a handoff.' }
    }
    if (decision.action === 'draft') {
      const draftId = await logEventRequest(db, ctx, {
        kind: 'event_cancellation',
        status: 'pending',
        details: { ...auditDetails, mode: 'draft' },
      })
      const { notifyAgentApprovalRequest } = await import('./approval-notify')
      await notifyAgentApprovalRequest(db, {
        requestId: draftId, locationId: ctx.locationId, kind: 'event_cancellation', customerName: ctx.nameHint,
        summary: [auditDetails.event_name, auditDetails.event_date].filter(Boolean).join(' · ') || 'paid entry cancellation',
      })
      return {
        requested: true,
        message: 'This was a PAID entry, so the team will confirm the cancellation and handle any refund question. Tell the customer they will hear back shortly — never promise a refund.',
      }
    }
    if (decision.reason === 'not_yours') {
      return { error: 'not_yours', message: 'That registration belongs to someone else — hand off to the team.' }
    }
    if (decision.reason === 'already_cancelled') {
      return { cancelled: true, message: 'It was already cancelled — confirm that warmly.' }
    }
    return { cancelled: false, reason: decision.reason, message: 'This event has already taken place — nothing to cancel.' }
  }

  return { error: 'unknown_tool', tool: toolName }
}

// Audit-trail writer — same queue/audit table as class bookings (mig
// 264 added the event kinds). Best-effort: an audit hiccup never
// blocks the customer-facing outcome.
async function logEventRequest(db, ctx, { kind, status, details }) {
  try {
    const { data, error } = await db.from('agent_membership_requests').insert({
      location_id: ctx.locationId,
      contact_id: ctx.verifiedContactId || ctx.contactId || null,
      kind,
      channel: ctx.channel || null,
      conversation_id: ctx.conversationId || null,
      details,
      status,
    }).select('id').single()
    if (error) console.warn(`[agent][events] audit insert failed: ${error.message}`)
    return data?.id || null
  } catch (e) {
    console.warn(`[agent][events] audit insert failed: ${e?.message || e}`)
    return null
  }
}
