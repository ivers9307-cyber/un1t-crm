// NEWSTART.1b — may this person claim a Glofox promo (Stillorgan /newstart)?
//
// Refusals, in this order:
//   active_member   — any contact that is this person is a member NOW at the
//     studio: a contact_studios row there with membership_status 'active', or
//     a contact homed at the studio with glofox_membership_status 'member'.
//     (trial / credit_member / classpass_payg are NOT refused here: fulfilment
//     checks the live Glofox plan.)
//   already_claimed — this promo was GRANTED for any of them at this studio;
//   help_pending    — a claim of theirs is in doubt (help_requested) or was
//     resolved by staff (handled): we cannot say the classes are on the
//     account, so the answer must never claim they are;
//   in_progress     — a claim for it is still processing.
// Prior trials and training never refuse. "This person" is personContactIds()
// (same email or same WhatsApp-normalised mobile, across the organisation).
//
// Any failed read is { ok: false }: an unreadable history is never eligible.
import { selectAllByKeys } from '@/lib/select-all'
import { personContactIds } from '@/lib/corp-promo-eligibility'
import { logWarn } from '@/lib/log'

const PAGE = 1000
const CHUNK = 200

/**
 * @param {object} db service-role client
 * @param {{ locationId: string, organizationId: string|null, contactId: string|null,
 *   email: string|null, phone: string|null, promoKey: string }} args
 * @returns {Promise<{ ok: true, eligible: true } | { ok: true, eligible: false, reason: 'active_member'|'already_claimed'|'help_pending'|'in_progress'|'free_trial_used' } | { ok: false }>}
 */
export async function glofoxCorpPromoEligibility(db, { locationId, organizationId = null, contactId = null, email = null, phone = null, promoKey, openWeekKeys = [] } = {}) {
  if (!locationId) throw new TypeError('glofoxCorpPromoEligibility: locationId is required')
  if (!promoKey) throw new TypeError('glofoxCorpPromoEligibility: promoKey is required')
  try {
    // OPENWEEK.1 — an open week granted at this studio is the person's free
    // trial: every OTHER promo there refuses it (free_trial_used).
    const owKeys = (Array.isArray(openWeekKeys) ? openWeekKeys : []).filter((k) => typeof k === 'string' && k && k !== promoKey)
    const keys = [promoKey, ...owKeys]
    const contactIds = await personContactIds(db, { organizationId, contactId, email, phone })
    if (contactIds.length === 0) return { ok: true, eligible: true }

    let [studios, homed, claims] = await Promise.all([
      selectAllByKeys(
        contactIds,
        (chunk, from, to) => db.from('contact_studios').select('contact_id, membership_status')
          .eq('location_id', locationId).eq('membership_status', 'active').in('contact_id', chunk)
          .order('contact_id', { ascending: true }).range(from, to),
        { chunkSize: CHUNK, pageSize: PAGE },
      ),
      selectAllByKeys(
        contactIds,
        (chunk, from, to) => db.from('contacts').select('id')
          .eq('location_id', locationId).eq('glofox_membership_status', 'member').in('id', chunk)
          .order('id', { ascending: true }).range(from, to),
        { chunkSize: CHUNK, pageSize: PAGE },
      ),
      selectAllByKeys(
        contactIds,
        (chunk, from, to) => db.from('corp_promo_claims').select('id, status, promo_key')
          .eq('location_id', locationId).in('promo_key', keys).in('contact_id', chunk)
          .order('id', { ascending: true }).range(from, to),
        { chunkSize: CHUNK, pageSize: PAGE },
      ),
    ])

    if (studios.length > 0 || homed.length > 0) return { ok: true, eligible: false, reason: 'active_member' }
    const isOpenWeekClaim = (c) => owKeys.includes(c.promo_key)
    if (!owKeys.includes(promoKey) && claims.some((c) => isOpenWeekClaim(c) && c.status === 'granted')) {
      return { ok: true, eligible: false, reason: 'free_trial_used' }
    }
    claims = claims.filter((c) => !isOpenWeekClaim(c))
    if (claims.some((c) => c.status === 'granted')) return { ok: true, eligible: false, reason: 'already_claimed' }
    if (claims.some((c) => ['help_requested', 'handled'].includes(c.status))) return { ok: true, eligible: false, reason: 'help_pending' }
    if (claims.some((c) => c.status === 'processing')) return { ok: true, eligible: false, reason: 'in_progress' }
    return { ok: true, eligible: true }
  } catch (e) {
    // Ids and codes only: a PostgREST error's details can name the email or phone.
    logWarn('corp-promo', 'glofox eligibility read failed; not eligible until it reads', { locationId, contactId, code: e?.code ?? null })
    return { ok: false }
  }
}
