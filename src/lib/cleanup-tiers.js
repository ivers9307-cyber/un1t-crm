// CLEANTIERS.1 — how many of a studio's mailable contacts sit in each contact
// cleanup tier, for the List health page. READ ONLY: nothing here suppresses,
// tags or changes a contact. The tiers are the ones the owner agreed on
// 26 Nov 2026 (email marketing review, contact cleanup section):
//
//   1 Keep, mail normally   current member, or attended / booked / paid /
//                           clicked in the last 90 days, or joined in the
//                           last 90 days, or sent fewer than 5 marketing emails
//   2 Keep, mail less       latest of those 90 to 180 days ago
//   3 Re-engage, then decide latest 180 days to 12 months ago
//   4 Seasonal sends only   nothing for 12 months or more (never removed:
//                           the owner chose seasonal sends, not a pause)
//   Not mailable            everyone on the list the send builder would not
//                           reach (no consent, bounced, complained, suppressed)
//
// Opens count for nothing: they are not filtered for Apple Mail Privacy
// Protection or scanners, so a recorded open is not evidence of a reader.
//
// Counted from the SEND builder's own query (buildAudienceQueryAsync with an
// empty filter), so a tier can never include someone a campaign would not
// reach. Each window is one PostgREST `or()`, and a null date simply fails its
// comparison, so a contact with no activity recorded falls through to the
// lowest tier. Tiers are nested windows: tier 2 = active within 180 days
// minus tier 1, and so on.
//
// Attendance, booking and payment dates come from the Glofox sync, so at a
// studio without Glofox (Hatch Street's members live in un1t_clients) members
// fall into the lower tiers. The page says so.

import { buildAudienceQueryAsync } from '@/lib/postmark'
import { selectAll } from '@/lib/select-all'

const DAY = 24 * 60 * 60 * 1000
export const MIN_MARKETING_EMAILS = 5

/**
 * The PostgREST `or()` that says "active within `days`".
 * @param {Date} now
 * @param {number} days
 */
export function activeWithinClause(now, days) {
  const since = new Date(now.getTime() - days * DAY).toISOString()
  const joinedSince = new Date(now.getTime() - 90 * DAY).toISOString()
  return [
    'and(glofox_membership_state.eq.active,glofox_membership_status.in.(member,credit_member))',
    `last_attended_at.gte.${since}`,
    `last_booked_at.gte.${since}`,
    `last_payment_at.gte.${since}`,
    `last_email_click_at.gte.${since}`,
    `created_at.gte.${joinedSince}`,
    `total_emails_sent.lt.${MIN_MARKETING_EMAILS}`,
    'total_emails_sent.is.null',
  ].join(',')
}

/**
 * @param {any} db service-role client
 * @param {string} locationId
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<{ ok: boolean, mailable: number, tiers: { keep: number, less: number, reengage: number, seasonal: number } }>}
 */
// HATCHTIERS.1 — a studio whose members live in un1t.online (Hatch Street)
// has no Glofox dates on its contacts; its visits are un1t_clients rows. Its
// list is small, so the tiers are counted in JS over the mailable ids, with a
// un1t.online visit (or an unlimited plan, the nearest thing to a current
// membership there) counting as activity alongside clicks and the contact's
// own dates.
const DAY_MS = 24 * 60 * 60 * 1000
async function countUn1tTiers(db, locationId, now) {
  const rows = await selectAll((from, to) => {
    return buildAudienceQueryAsync(db, { logic: 'and', filters: [] }, locationId, {
      columns: 'id, created_at, total_emails_sent, last_attended_at, last_booked_at, last_payment_at, last_email_click_at',
    }).then(({ query }) => query.order('id', { ascending: true }).range(from, to))
  })
  const clients = await selectAll((from, to) => db
    .from('un1t_clients')
    .select('contact_id, last_attended_at, credit_unlimited')
    .eq('location_id', locationId)
    .not('contact_id', 'is', null)
    .order('contact_id', { ascending: true })
    .range(from, to))
  const visit = new Map()
  const unlimited = new Set()
  for (const c of clients) {
    if (c.credit_unlimited) unlimited.add(c.contact_id)
    const t = c.last_attended_at ? Date.parse(c.last_attended_at) : NaN
    if (Number.isFinite(t) && t > (visit.get(c.contact_id) || 0)) visit.set(c.contact_id, t)
  }
  const tiers = { keep: 0, less: 0, reengage: 0, seasonal: 0 }
  for (const r of rows) {
    const ageDays = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? (now.getTime() - t) / DAY_MS : Infinity }
    const newish = ageDays(r.created_at) <= 90 || (r.total_emails_sent ?? 0) < MIN_MARKETING_EMAILS
    const latest = Math.min(
      ageDays(r.last_attended_at), ageDays(r.last_booked_at), ageDays(r.last_payment_at), ageDays(r.last_email_click_at),
      visit.has(r.id) ? (now.getTime() - visit.get(r.id)) / DAY_MS : Infinity,
    )
    if (newish || unlimited.has(r.id) || latest <= 90) tiers.keep++
    else if (latest <= 180) tiers.less++
    else if (latest <= 365) tiers.reengage++
    else tiers.seasonal++
  }
  return { ok: true, mailable: rows.length, tiers }
}

export async function countCleanupTiers(db, locationId, { now = new Date(), un1tOnline = false } = {}) {
  if (un1tOnline) {
    try { return await countUn1tTiers(db, locationId, now) } catch (e) {
      console.error('[cleanup tiers] un1t count failed:', e?.message)
      return { ok: false, mailable: 0, tiers: { keep: 0, less: 0, reengage: 0, seasonal: 0 } }
    }
  }
  const count = async (days) => {
    const { query } = await buildAudienceQueryAsync(db, { logic: 'and', filters: [] }, locationId, {
      columns: 'id',
      selectOpts: { count: 'exact', head: true },
    })
    const q = days == null ? query : query.or(activeWithinClause(now, days))
    const { count: n, error } = await q
    if (error) throw new Error(error.message)
    return n || 0
  }
  try {
    const [mailable, a90, a180, a365] = await Promise.all([count(null), count(90), count(180), count(365)])
    return {
      ok: true,
      mailable,
      tiers: {
        keep: a90,
        less: Math.max(0, a180 - a90),
        reengage: Math.max(0, a365 - a180),
        seasonal: Math.max(0, mailable - a365),
      },
    }
  } catch (e) {
    console.error('[cleanup tiers] count failed:', e?.message)
    return { ok: false, mailable: 0, tiers: { keep: 0, less: 0, reengage: 0, seasonal: 0 } }
  }
}
