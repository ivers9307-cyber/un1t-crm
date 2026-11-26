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
export async function countCleanupTiers(db, locationId, { now = new Date() } = {}) {
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
