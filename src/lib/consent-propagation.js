import { escapeLikePattern } from '@/lib/like-escape'
import { CONSENT_ACTIONS } from '@/lib/consent-actions'

// DUPEUNSUB.1 — an opt-out on one contact record must reach that person's
// other records.
//
// THE COMPLAINT THIS EXISTS FOR
// A customer opted out of murphyp.eoin@gmail.com via the one-click unsubscribe
// link on 2026-08-10. He holds FOUR contact records; eoin02@hotmail.com
// carries the SAME phone number and was left untouched — still opted in,
// still mailable. Nothing was sent to it in the gap, so no harm landed this
// time, but only because no campaign happened to run that week.
//
// MATCHING AXIS — this is the part that has to be right, not just present:
//   • email    — exact, CASE-INSENSITIVE. Contacts are stored mixed-case, so
//                .eq() misses real matches. The repo's equality idiom is
//                .ilike() with an ESCAPED pattern (escapeLikePattern, from
//                @/lib/like-escape): `_` and `%` are LIKE wildcards *and*
//                legal email characters, so an unescaped `a_b@x.com` would
//                also match `axb@x.com`. check:guardrails'
//                no-unescaped-ilike-pattern enforces this for a direct
//                .ilike() call, but cannot see inside a .or() string — the
//                discipline still applies here by hand.
//   • wa_phone — NOT the raw `phone` column. `wa_phone` is normalised by the
//                derive_wa_phone trigger (mig 330); `phone` holds `+353…`,
//                `353…` and `08…` variants of the same number live, so it is
//                useless as a join key.
//
// DELIBERATELY NOT `person_group_id`: that grouping is NAME-matched (mig
// 270), and in this exact case it binds two different phone numbers under
// "Eoin Murphy" — it may hold two different people who happen to share a
// name. Suppressing a stranger's marketing consent because they share a name
// with someone who opted out is a worse failure than missing a genuine
// duplicate.
//
// WRITE TARGET DEPENDS ON SCOPE — mirrors exactly what the two consent routes
// do for the ORIGIN contact, and for the same reason (LOCCOMMS.4, mig
// 489/543):
//   • scoped (locationId set)  → contact_location_preferences, AT THAT
//     LOCATION ONLY. Writing contact_preferences here would trip the mig 489
//     sync trigger, which fans a global FALSE out to EVERY location row —
//     turning "this sibling left the Hatch Street list" into "this sibling
//     left every UN1T list", exactly the harm LOCCOMMS.4 exists to prevent.
//   • global (locationId null) → contact_preferences, and let the mig
//     489/543 trigger fan the opt-out out to every location row and stamp
//     unsubscribed_at itself. Writing contact_location_preferences directly
//     here would leave each sibling's global row still saying "subscribed" —
//     the same global-vs-location desync mig 543 was written to fix, just
//     landing on a different contact.
//
// Best-effort by contract: this runs AFTER the origin contact's own opt-out
// is already durable, and must never cause it to fail or error. Every write
// below is inside try/catch — supabase-js query builders are thenables, not
// Promises (.then but no .catch), so `await builder.catch(() => {})` throws
// synchronously and the write never runs; `try { await … } catch {}` is the
// only safe form (CLAUDE.md).

const SIBLING_CAP = 20

/**
 * Contact ids sharing this person's email or wa_phone, excluding `contactId`
 * itself. `[]` when neither matching field is present, WITHOUT querying — an
 * empty .or() would otherwise become a filter-less query over every contact.
 * `[]` (never a throw) on a query error: a failed lookup must read as "no
 * siblings found", not break the caller.
 *
 * @param {object} db - supabase server client
 * @param {{ contactId: string, email?: string|null, waPhone?: string|null }} args
 * @returns {Promise<string[]>}
 */
export async function findConsentSiblings(db, { contactId, email, waPhone }) {
  const clauses = []
  if (email) clauses.push(`email.ilike.${escapeLikePattern(email.toLowerCase())}`)
  if (waPhone) clauses.push(`wa_phone.eq.${waPhone}`)
  if (clauses.length === 0) return []

  // Several rows is the expected answer, not an edge case — never .single()/
  // .maybeSingle() here.
  const { data, error } = await db
    .from('contacts')
    .select('id')
    .or(clauses.join(','))
    .neq('id', contactId)
    .limit(SIBLING_CAP)

  if (error) {
    console.error('[consent-propagation] sibling lookup failed:', error.message)
    return []
  }
  return (data || []).map((row) => row.id)
}

/**
 * Apply the same opt-out to every sibling of `contactId`. Always resolves to
 * `{ propagated: <count> }` — including on failure, where the count is 0.
 * Never throws: see the header comment for why that is load-bearing (this
 * runs after the origin contact's own opt-out is already durable).
 *
 * @param {object} db
 * @param {{
 *   contactId: string,
 *   email?: string|null,
 *   waPhone?: string|null,
 *   channels: string[],
 *   locationId?: string|null,
 * }} args
 * @returns {Promise<{ propagated: number }>}
 */
export async function propagateOptOut(db, { contactId, email, waPhone, channels, locationId = null }) {
  try {
    if (!channels || channels.length === 0) return { propagated: 0 }

    const siblings = await findConsentSiblings(db, { contactId, email, waPhone })
    if (siblings.length === 0) return { propagated: 0 }

    const nowIso = new Date().toISOString()
    const patch = { updated_at: nowIso }
    for (const channel of channels) patch[channel] = false

    if (locationId) {
      // Scoped — write contact_location_preferences directly, so stamp
      // unsubscribed_at by hand: the mig 543 trigger only fires off a
      // contact_preferences write, which this branch deliberately avoids.
      if (channels.includes('email_marketing')) patch.unsubscribed_at = nowIso
      const { error } = await db
        .from('contact_location_preferences')
        .update(patch)
        .in('contact_id', siblings)
        .eq('location_id', locationId)
      if (error) {
        console.error('[consent-propagation] sibling write failed:', error.message)
        return { propagated: 0 }
      }
    } else {
      // Global — write contact_preferences and let the mig 489/543 trigger
      // fan the change out to every location row (and stamp unsubscribed_at
      // there itself).
      const { error } = await db
        .from('contact_preferences')
        .update(patch)
        .in('contact_id', siblings)
      if (error) {
        console.error('[consent-propagation] sibling write failed:', error.message)
        return { propagated: 0 }
      }
    }

    // Audit trail. Not error-checked, matching the two consent routes' own
    // consent_log writes — this is best-effort evidence, not the write the
    // caller's success hinges on.
    await db.from('consent_log').insert(
      siblings.flatMap((id) =>
        channels.map((channel) => ({
          contact_id: id,
          channel,
          action: CONSENT_ACTIONS.OPT_OUT,
          source: 'duplicate_propagation',
          location_id: locationId,
        })),
      ),
    )

    return { propagated: siblings.length }
  } catch (err) {
    console.error('[consent-propagation] threw:', err?.message || err)
    return { propagated: 0 }
  }
}
