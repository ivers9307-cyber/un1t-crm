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

  return { error: 'unknown_tool', tool: toolName }
}
