// CORPPROMO.1 — may this person claim a /corp promo at this studio?
//
// Richard, 28 Oct 2026: anyone with the link who has never trained at the
// studio, and whose email OR mobile was never used for a free trial there.
// Only this studio's history counts (training at a sibling studio does not
// stop a claim), and a paid pack or the paid /trial alone does not stop it
// (they stack).
//
// "This person" is the contact who submitted, every contact in the
// organisation with the same email or the same WhatsApp-normalised mobile,
// and every un1t.online account those contacts own at the studio.
//
//   free_trial_used — a free trial on our ledger (op trial, trial_regrant or
//     promo_grant; done, sent or unknown) or a mirrored transaction for the
//     studio's free trial product, for ANY of them (matched by email or phone);
//   trained — a booking that was not cancelled (the un1t.online mirror, or a
//     class_bookings row, which also holds the studio's older history), or any
//     subscription or membership history (the mirror, or the contact_studios
//     membership facts, active or ended).
//
// Any failed read is { ok: false }: an unreadable history is never eligible.
import { selectAll, selectAllByKeys } from '@/lib/select-all'
import { escapeLikePattern } from '@/lib/like-escape'
import { waPhoneFromPhone } from '@/lib/phone-validate'
import { logWarn } from '@/lib/log'

const PAGE = 1000
const CHUNK = 200
const FREE_TRIAL_OPS = Object.freeze(['trial', 'trial_regrant', 'promo_grant'])
const OPEN_OR_DONE = Object.freeze(['done', 'sent', 'unknown'])
const isCancelled = (s) => /cancel/i.test(String(s ?? ''))

const failed = (step, error) => Object.assign(new Error(`corp promo eligibility: ${step} failed (${error?.code ?? 'no code'})`), { code: error?.code ?? null })

/** Rows of `table` at the studio whose `column` is one of `keys`, every page. */
function rowsIn(db, table, cols, locationId, column, keys) {
  if (keys.length === 0) return Promise.resolve([])
  return selectAllByKeys(
    keys,
    (chunk, from, to) => db.from(table).select(cols).eq('location_id', locationId).in(column, chunk).order('id', { ascending: true }).range(from, to),
    { chunkSize: CHUNK, pageSize: PAGE },
  )
}

/** The contacts in the organisation that are this person (submitted + same email + same mobile). */
async function personContactIds(db, { organizationId, contactId, email, phone }) {
  const ids = new Set(contactId ? [contactId] : [])
  if (!organizationId) return [...ids]
  const normEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''
  if (normEmail) {
    const { data, error } = await db.from('contacts').select('id')
      .eq('organization_id', organizationId).ilike('email', escapeLikePattern(normEmail)).limit(50)
    if (error) throw failed('email match', error)
    for (const r of data || []) ids.add(r.id)
  }
  const wa = waPhoneFromPhone(phone)
  if (wa) {
    const rows = await selectAll((from, to) => db.from('contacts').select('id')
      .eq('organization_id', organizationId).eq('wa_phone', wa).order('id', { ascending: true }).range(from, to), { pageSize: PAGE })
    for (const r of rows) ids.add(r.id)
  }
  return [...ids]
}

/**
 * @param {object} db service-role client
 * @param {{ locationId: string, organizationId: string|null, contactId: string|null,
 *   email: string|null, phone: string|null, trialProductId: string|null }} args
 * @returns {Promise<{ ok: true, eligible: true } | { ok: true, eligible: false, reason: 'free_trial_used'|'trained' } | { ok: false }>}
 */
export async function corpPromoEligibility(db, { locationId, organizationId = null, contactId = null, email = null, phone = null, trialProductId = null } = {}) {
  if (!locationId) throw new TypeError('corpPromoEligibility: locationId is required')
  try {
    const contactIds = await personContactIds(db, { organizationId, contactId, email, phone })
    if (contactIds.length === 0) return { ok: true, eligible: true }
    const clients = await rowsIn(db, 'un1t_clients', 'id, un1t_user_id', locationId, 'contact_id', contactIds)
    const userIds = [...new Set(clients.map((c) => c.un1t_user_id).filter(Boolean))]
    const byPerson = async (table, cols) => {
      const [a, b] = await Promise.all([
        rowsIn(db, table, cols, locationId, 'contact_id', contactIds),
        rowsIn(db, table, cols, locationId, 'un1t_user_id', userIds),
      ])
      return [...a, ...b]
    }

    // A. A free trial already used, by email or mobile.
    const ledger = await byPerson('un1t_write_events', 'id, op, stage')
    if (ledger.some((r) => FREE_TRIAL_OPS.includes(r.op) && OPEN_OR_DONE.includes(r.stage))) {
      return { ok: true, eligible: false, reason: 'free_trial_used' }
    }
    if (trialProductId) {
      const tx = await byPerson('un1t_transactions', 'id, product_id')
      if (tx.some((t) => String(t.product_id ?? '') === String(trialProductId))) return { ok: true, eligible: false, reason: 'free_trial_used' }
    }

    // B. Trained at this studio.
    const [bookings, subs, classBookings, studios] = await Promise.all([
      byPerson('un1t_bookings', 'id, status'),
      byPerson('un1t_subscriptions', 'id, status'),
      rowsIn(db, 'class_bookings', 'id, status', locationId, 'contact_id', contactIds),
      selectAllByKeys(
        contactIds,
        (chunk, from, to) => db.from('contact_studios').select('contact_id, membership_status')
          .eq('location_id', locationId).in('contact_id', chunk).in('membership_status', ['active', 'ended'])
          .order('contact_id', { ascending: true }).range(from, to),
        { chunkSize: CHUNK, pageSize: PAGE },
      ),
    ])
    const booked = (rows) => rows.some((r) => !isCancelled(r.status))
    if (booked(bookings) || booked(classBookings) || subs.length > 0 || studios.length > 0) {
      return { ok: true, eligible: false, reason: 'trained' }
    }
    return { ok: true, eligible: true }
  } catch (e) {
    // Ids and codes only: a PostgREST error's details can name the email or phone.
    logWarn('corp-promo', 'eligibility read failed; not eligible until it reads', { locationId, contactId, code: e?.code ?? null })
    return { ok: false }
  }
}
