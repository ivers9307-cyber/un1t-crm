// member-validation — UN1T member lookup for the public race
// signup form (mig 084).
//
// We match strictly by (location_id, lower(email)) against contacts
// whose pipeline_stage_slug marks a current member. The match is
// intentionally narrow for v1:
//
//   - Email-only: lowest friction. The signup form shows a notice
//     telling members to use the email on their UN1T account.
//   - Organisation-scoped (EVENT-MEMBER-ORG.1): a member of ANY studio
//     in the event's organisation counts, whichever studio owns the
//     event. Every UN1T member's contact still lives on Stillorgan (its
//     Glofox namespace holds Hatch Street's members too), so a
//     location-scoped check charged every member full price on a Hatch
//     event. Host-anchor locations (`is_host_anchor`) are not studios:
//     an event owned by one keeps the old single-location scope, and
//     their contacts never count as studio members.
//   - pipeline_stage_slug ∈ {converted, member} is the membership
//     signal (FUNNEL.1: 'converted' = became a member ≤60d ago,
//     'member' = established member). The stage is classifier-derived
//     from Glofox status, so membership changes flow through here
//     without app code touching the column.
//   - OR an ACTIVE contact_studios row of kind member at one of those
//     studios (ORGCONTACTS.2, mig 764): a membership sold outside Glofox,
//     e.g. Hatch Street's un1t.online plans.
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
import { logWarn } from './log'
import { contactsAtStudio } from './contact-studios'

const MEMBER_STAGES = ['converted', 'member']

/**
 * The locations whose members count as members on an event owned by
 * `locationId`: every non-host-anchor location in the same organisation.
 * A host-anchor owner, an org-less location, or a failed read falls back
 * to `[locationId]` (the pre-org behaviour), never to nothing.
 *
 * @returns {Promise<string[]>}
 */
export async function memberLocationIdsFor(db, locationId) {
  if (!locationId) return []
  const narrow = [locationId]
  // .maybeSingle(): primary key, 0-or-1 rows.
  const { data: loc, error } = await db
    .from('locations')
    .select('id, organization_id, is_host_anchor')
    .eq('id', locationId)
    .maybeSingle()
  if (error || !loc) {
    logWarn('member-validation', 'event location unreadable; member check stays on that location', { locationId, error: error?.message })
    return narrow
  }
  if (loc.is_host_anchor || !loc.organization_id) return narrow
  const { data: sibs, error: sibErr } = await db
    .from('locations')
    .select('id')
    .eq('organization_id', loc.organization_id)
    .eq('is_host_anchor', false)
  if (sibErr || !Array.isArray(sibs)) {
    logWarn('member-validation', 'org studios unreadable; member check stays on the event location', { locationId, error: sibErr?.message })
    return narrow
  }
  const ids = new Set(sibs.map((r) => r.id))
  ids.add(locationId)
  return [...ids]
}

/**
 * Look up a single email against members of the event's organisation.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db   service-role or RLS-bypass client
 * @param {string} args.email        raw email from form input
 * @param {string} args.locationId   race_event.location_id
 * @param {string[]} [args.memberLocationIds]  precomputed
 *   memberLocationIdsFor(db, locationId) — a roster passes it once
 * @returns {Promise<{
 *   is_member: boolean,
 *   contact_id: string|null,
 *   first_name: string|null,
 *   status: 'verified' | 'failed'
 * }>}
 */
export async function validateMemberByEmail({ db, email, locationId, memberLocationIds = null }) {
  const fail = { is_member: false, contact_id: null, first_name: null, status: 'failed' }
  if (!email || typeof email !== 'string') return fail
  if (!locationId) return fail

  const normalised = email.trim().toLowerCase()
  if (!normalised || !normalised.includes('@')) return fail

  // ilike on email column (already indexed by mig 001) so unicode/
  // case differences match. Scope: the org's studios + active membership.
  //
  // escapeLikePattern: `email` is typed into the PUBLIC race/event register
  // and check-member forms. Unescaped, `a_b@example.com` also matches
  // `axb@example.com` — so a stranger could submit a lookalike address, be
  // told is_member: true, and receive that member's contact_id and
  // first_name back. Member pricing keys off exactly this result.
  //
  // `contacts_email_org_unique` is per org but case-sensitive, so one
  // address can still sit on several rows as case variants (Foo@ vs foo@),
  // and .maybeSingle() would error on those and fail a real member. Read a
  // few and take a member row if any is one; the escaped pattern only ever
  // matches case variants of THIS address.
  const locationIds = memberLocationIds?.length ? memberLocationIds : await memberLocationIdsFor(db, locationId)
  const { data: rows, error } = await db
    .from('contacts')
    .select('id, first_name, name, pipeline_stage_slug')
    .in('location_id', locationIds)
    .ilike('email', escapeLikePattern(normalised))
    .limit(10)

  if (error || !Array.isArray(rows)) return fail
  // FUNNEL.1 — current members sit in 'converted' (≤60d since joining)
  // or 'member' (established). That stage is classified from Glofox.
  let data = rows.find((r) => MEMBER_STAGES.includes(r.pipeline_stage_slug))
  // ORGCONTACTS.2 (mig 764) — a membership held outside Glofox (Hatch
  // Street's un1t.online plans) is an ACTIVE contact_studios row of kind
  // member at one of the same studios. A failed read here only means "not
  // proven a member this way", the same as the stage check finding nothing.
  if (!data && rows.length > 0) {
    let holder = null
    for (const locationId of locationIds) {
      const held = await contactsAtStudio(db, locationId, { kinds: ['member'], status: 'active', contactIds: rows.map((r) => r.id) })
      if (!held.ok) {
        logWarn('member-validation', 'contact_studios unreadable; stage check only', { error: held.error })
        break
      }
      holder = held.rows[0]?.contact_id ?? null
      if (holder) break
    }
    data = holder ? rows.find((r) => r.id === holder) : null
  }
  if (!data) return fail

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
  let memberLocationIds = null
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
    if (!memberLocationIds) memberLocationIds = await memberLocationIdsFor(db, locationId)
    const r = await validateMemberByEmail({ db, email: m.email, locationId, memberLocationIds })
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
