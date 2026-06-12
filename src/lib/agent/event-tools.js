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
// Pure helpers tested in event-tools.test.js; executor does the IO
// and never throws (mirrors executeBookingTool).

export const EVENT_TOOLS = [
  {
    name: 'list_upcoming_events',
    description:
      "List the studio's upcoming special events — races (e.g. Hyrox sims), workshops, " +
      'seminars, open days, masterclasses — with dates, start waves, spaces left, pricing and ' +
      'the signup link. No verification needed. Use when someone asks about races/events, or ' +
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
      'new, collect their full name and email first — the confirmation goes there.',
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

/**
 * Shape race_events rows (waves embedded) for the agent: open-for-
 * registration future events with per-wave availability, pricing and
 * the public signup link. Pure.
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
          spots_left: spotsLeft == null ? 'unlimited' : spotsLeft,
          ...(spotsLeft === 0 ? { full: true } : {}),
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
    const { data: rows } = await db.from('race_registrations')
      .select('id, status, race_events!inner(name, kind, race_date, location_id), race_waves(start_time)')
      .eq('contact_id', targetContactId)
      .eq('race_events.location_id', locationId)
      .gte('race_events.race_date', today)
      .limit(20)
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
      .select('id, name, kind, slug, description, race_date, active, location_id, registration_opens_at, registration_closes_at, member_pricing_enabled, member_fee_cents, non_member_fee_cents, members_only, payment_currency, waves:race_waves(id, start_time, capacity, label)')
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
      .select('id, name, first_name, last_name, email, phone')
      .eq('id', targetContactId)
      .maybeSingle()
    if (!existing) return { error: 'no_contact', message: 'Contact not found — hand off to the team.' }
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
      await logEventRequest(db, ctx, { kind: 'event_booking', status: 'pending', details: { ...auditDetails, mode: 'draft' } })
      return { requested: true, message: 'Queued for the team to confirm — tell the customer they will hear back shortly. Never say it is booked yet.' }
    }

    const { registerSoloEventEntry } = await import('@/lib/race-register-solo')
    const result = await registerSoloEventEntry(db, { race, waveId: input?.wave_id || null, contact })
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

  return { error: 'unknown_tool', tool: toolName }
}

// Audit-trail writer — same queue/audit table as class bookings (mig
// 264 added the event kinds). Best-effort: an audit hiccup never
// blocks the customer-facing outcome.
async function logEventRequest(db, ctx, { kind, status, details }) {
  try {
    await db.from('agent_membership_requests').insert({
      location_id: ctx.locationId,
      contact_id: ctx.verifiedContactId || ctx.contactId || null,
      kind,
      channel: ctx.channel || null,
      conversation_id: ctx.conversationId || null,
      details,
      status,
    })
  } catch (e) {
    console.warn(`[agent][events] audit insert failed: ${e?.message || e}`)
  }
}
