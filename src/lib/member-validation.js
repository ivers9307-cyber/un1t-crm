// member-validation — UN1T member lookup for the public race
// signup form (mig 084).
//
// We match strictly by (location_id, lower(email)) against contacts
// whose pipeline_stage_slug marks a current member. The match is
// intentionally narrow for v1:
//
//   - Email-only: lowest friction. The signup form shows a notice
//     telling members to use the email on their UN1T account.
//   - Location-scoped: a contact only counts as a member of THIS
//     race's location. Cross-location membership is a future call
//     (and would belong to organisations, not contacts).
//   - pipeline_stage_slug ∈ {converted, member} is the membership
//     signal (FUNNEL.1: 'converted' = became a member ≤60d ago,
//     'member' = established member). The stage is classifier-derived
//     from Glofox status, so membership changes flow through here
//     without app code touching the column.
//
// We never leak whether an email exists in contacts when the lookup
// fails — the route returns { is_member: false } whether the email
// is unknown OR known-but-not-a-member. That keeps the public
// endpoint from being abused as a member-enumeration oracle.
//
// That last property depended on the lookup being an EQUALITY check. Until
// 2026-08-07 it was an unescaped .ilike(), so `%@somedomain.com` probed the
// whole domain at once: where exactly one member matched, the route answered
// is_member: true and handed back their first_name — the enumeration oracle
// this header says it prevents. See src/lib/like-escape.js.

import { escapeLikePattern } from './like-escape'

/**
 * Look up a single email against members for one location.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db   service-role or RLS-bypass client
 * @param {string} args.email        raw email from form input
 * @param {string} args.locationId   race_event.location_id
 * @returns {Promise<{
 *   is_member: boolean,
 *   contact_id: string|null,
 *   first_name: string|null,
 *   status: 'verified' | 'failed'
 * }>}
 */
export async function validateMemberByEmail({ db, email, locationId }) {
  const fail = { is_member: false, contact_id: null, first_name: null, status: 'failed' }
  if (!email || typeof email !== 'string') return fail
  if (!locationId) return fail

  const normalised = email.trim().toLowerCase()
  if (!normalised || !normalised.includes('@')) return fail

  // ilike on email column (already indexed by mig 001) so unicode/
  // case differences match. Tight scope: location + active membership.
  //
  // escapeLikePattern: `email` is typed into the PUBLIC race/event register
  // and check-member forms. Unescaped, `a_b@example.com` also matches
  // `axb@example.com` — so a stranger could submit a lookalike address, be
  // told is_member: true, and receive that member's contact_id and
  // first_name back. Member pricing keys off exactly this result.
  const { data, error } = await db
    .from('contacts')
    .select('id, first_name, name, pipeline_stage_slug')
    .eq('location_id', locationId)
    .ilike('email', escapeLikePattern(normalised))
    .maybeSingle()

  if (error || !data) return fail
  // FUNNEL.1 — current members sit in 'converted' (≤60d since joining)
  // or 'member' (established).
  if (!['converted', 'member'].includes(data.pipeline_stage_slug)) return fail

  return {
    is_member: true,
    contact_id: data.id,
    first_name: data.first_name || (data.name ? String(data.name).split(' ')[0] : null),
    status: 'verified',
  }
}

/**
 * Validate a full team roster. Used by the public register route at
 * submit time; loops the same lookup over every member.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db
 * @param {Array<{ name: string, email: string|null }>} args.members
 *   (captain + others, all in one list — caller composes it)
 * @param {string} args.locationId
 * @returns {Promise<Array<{
 *   name: string,
 *   email: string|null,
 *   is_member: boolean,
 *   member_contact_id: string|null,
 *   status: 'verified' | 'failed' | 'not_applicable'
 * }>>}
 */
export async function validateTeamRoster({ db, members, locationId }) {
  const out = []
  for (const m of members || []) {
    if (!m?.email) {
      out.push({
        name: m?.name || '',
        email: null,
        is_member: false,
        member_contact_id: null,
        status: 'not_applicable',
      })
      continue
    }
    const r = await validateMemberByEmail({ db, email: m.email, locationId })
    out.push({
      name: m.name || '',
      email: m.email,
      is_member: r.is_member,
      member_contact_id: r.contact_id,
      status: r.status,
    })
  }
  return out
}

/**
 * Compute totals + composition from a validated roster + race
 * pricing config. Pure function — no DB, easy to test.
 *
 * @param {object} args
 * @param {Array<{ is_member: boolean }>} args.validatedRoster
 * @param {object} args.race
 * @param {boolean} args.race.member_pricing_enabled
 * @param {number|null} args.race.member_fee_cents
 * @param {number|null} args.race.non_member_fee_cents
 * @returns {{
 *   total_cents: number,
 *   member_count: number,
 *   non_member_count: number,
 *   member_fee_cents: number|null,
 *   non_member_fee_cents: number|null,
 *   team_composition: 'all_members' | 'mixed' | 'all_non_members'
 * }}
 */
export function computeTeamPricing({ validatedRoster, race }) {
  const memberPricing = !!race?.member_pricing_enabled
  const memberFee = Number.isFinite(race?.member_fee_cents) ? race.member_fee_cents : null
  const nonMemberFee = Number.isFinite(race?.non_member_fee_cents) ? race.non_member_fee_cents : null

  let memberCount = 0
  let nonMemberCount = 0
  for (const m of validatedRoster || []) {
    if (memberPricing && m?.is_member) memberCount += 1
    else nonMemberCount += 1
  }

  // When member pricing is OFF, everyone pays the non-member fee
  // (which may be NULL = free). When ON, mix per head.
  const memberSubtotal = memberPricing && memberFee != null ? memberFee * memberCount : 0
  const nonMemberSubtotal = nonMemberFee != null ? nonMemberFee * nonMemberCount : 0
  const total = memberSubtotal + nonMemberSubtotal

  let composition = 'all_non_members'
  if (memberCount > 0 && nonMemberCount === 0) composition = 'all_members'
  else if (memberCount > 0 && nonMemberCount > 0) composition = 'mixed'

  return {
    total_cents: total,
    member_count: memberCount,
    non_member_count: nonMemberCount,
    member_fee_cents: memberPricing ? memberFee : null,
    non_member_fee_cents: nonMemberFee,
    team_composition: composition,
  }
}
