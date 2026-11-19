// CONTACTLOG.1 — contacts logged on the timeline, and who on a board still
// needs one.
//
// Richard's decision (19 Nov 2026) on the Lead Radar: the board gets a filter
// for the people nobody has contacted lately, and staff log each contact on the
// timeline: a call, a WhatsApp or an email, got through or not. The Radar's own
// list and its keep/contacted decisions go (a later PR).
//
// A logged contact is an `activities` event of type 'contact_log' (subject
// "WhatsApp: no reply" and so on), so the contact page's timeline shows it with
// no new table. Its own type keeps it apart from the auto-logged 'email' and
// 'whatsapp_sent' rows: those include broadcasts and sequences, and a
// newsletter is not somebody getting in touch.
//
// What counts as "contacted" at a studio within CONTACT_WINDOW_DAYS:
//   - a logged contact (type 'contact_log') created in the window,
//   - a call the older paths log (type 'call', kind 'event': the Glofox
//     interaction import), created in the window, or
//   - a call TASK marked done in the window (completed_at, which the
//     sync_activity_done_status trigger stamps).
// An open call task is a plan, not a contact, so it does not count.
//
// Server-only for loadRecentlyContacted (it takes a service-role client); the
// constants and labels are safe in the browser.

/** How long a logged contact keeps a card off the "Not contacted" list. */
export const CONTACT_WINDOW_DAYS = 14

/** The activities.type a logged contact is written with. */
export const CONTACT_LOG_TYPE = 'contact_log'

export const CONTACT_CHANNELS = Object.freeze({ call: 'Call', whatsapp: 'WhatsApp', email: 'Email' })
export const CONTACT_OUTCOMES = Object.freeze({ reached: 'got through', no_reply: 'no reply' })

const DAY_MS = 86_400_000
const CHUNK = 200
const PAGE = 1000

/** "WhatsApp: no reply" — the timeline subject. */
export function contactLogSubject(channel, outcome) {
  return `${CONTACT_CHANNELS[channel]}: ${CONTACT_OUTCOMES[outcome]}`
}

/**
 * The `activities` row for a logged contact.
 * @param {{ contactId: string, locationId: string, channel: keyof typeof CONTACT_CHANNELS, outcome: keyof typeof CONTACT_OUTCOMES, note?: string|null, nowIso: string }} p
 */
export function contactLogRow({ contactId, locationId, channel, outcome, note = null, nowIso }) {
  return {
    subject: contactLogSubject(channel, outcome),
    type: CONTACT_LOG_TYPE,
    kind: 'event',
    done: true,
    completed_at: nowIso,
    contact_id: contactId,
    location_id: locationId,
    note: note || null,
    source: 'crm',
  }
}

/**
 * Of `contactIds`, the ones contacted at `locationId` in the last
 * CONTACT_WINDOW_DAYS. Reads in chunks of ids and 1,000-row ordered pages (the
 * PostgREST cap).
 * @returns {Promise<{ ok: true, contacted: Set<string> } | { ok: false }>}
 */
export async function loadRecentlyContacted(db, { locationId, contactIds, nowMs = Date.now() }) {
  const contacted = new Set()
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  if (!locationId || ids.length === 0) return { ok: true, contacted }
  const cutoff = new Date(nowMs - CONTACT_WINDOW_DAYS * DAY_MS).toISOString()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db.from('activities')
        .select('id, contact_id')
        .eq('location_id', locationId)
        .in('type', [CONTACT_LOG_TYPE, 'call'])
        .in('contact_id', chunk)
        .or(`and(kind.eq.event,created_at.gte.${cutoff}),and(type.eq.call,done.is.true,completed_at.gte.${cutoff})`)
        .order('id')
        .range(from, from + PAGE - 1)
      if (error) return { ok: false }
      for (const r of data || []) contacted.add(r.contact_id)
      if (!data || data.length < PAGE) break
    }
  }
  return { ok: true, contacted }
}
