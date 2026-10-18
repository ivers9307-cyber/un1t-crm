// src/lib/agent/member-studios.js — MIAHATCH.1
//
// Which studios is this person a member of right now, and at which of those
// may Mia answer them? Stillorgan's members live on Glofox (columns on
// `contacts`), Hatch Street's on un1t.online (the `un1t_clients` /
// `un1t_subscriptions` mirror, mig 726). One person can be at both, under
// different contact rows linked by a person group.
//
// Two separate questions per studio, never folded together:
//   active     — the person holds a live membership (or credits) THERE.
//   answerable — that studio's Mia gate passes for THIS sender (enabled, or
//                test_mode with the sender on test_phones).
//
// Pure core (classify / answerableStudios / otherStudioOnly) plus ONE IO
// function (resolveMemberStudios). Any failed read is { studios: [],
// readFailed: true }; a caller falls back to today's thread-studio behaviour
// and must never read it as "this person is a member nowhere".

import { logWarn } from '@/lib/log'
import { MEMBERSHIP_ACTIVE_STATUSES } from '@/lib/un1t-online-map'
import { hasBookableMembership, linkedAccountsForContact, chunkIds } from '@/lib/person-accounts'
import { resolveAgentGate, phoneMatchesAllowlist } from './core'
import { resolveAgentSettings } from './settings-resolve'

const LOG_MODULE = 'mia-un1t'

/**
 * Would this studio's Mia answer THIS sender? `enabled`, or test mode with the
 * sender on `test_phones`. (enabled + test_mode is live for everyone: the
 * allowlist is not in effect.) Pure.
 */
export function isAgentOnForSender(settings, senderPhone) {
  const gate = resolveAgentGate(settings)
  if (gate.enabled) return true
  if (gate.allowlistScoped) return phoneMatchesAllowlist(senderPhone, settings?.test_phones)
  return false
}

/** A Glofox studio is active when a contact holds a bookable membership or trial credits. Pure. */
export function glofoxStudioActive(contacts) {
  return (contacts || []).some((c) => hasBookableMembership(c) || Number(c?.trial_credits_remaining) > 0)
}

/** A un1t.online studio is active on a live subscription, unlimited credits or a positive balance. Pure. */
export function un1tStudioActive({ subscriptions, client } = {}) {
  if ((subscriptions || []).some((s) => MEMBERSHIP_ACTIVE_STATUSES.includes(s?.status))) return true
  if (client?.credit_unlimited === true) return true
  return Number(client?.credit_balance) > 0
}

// Same mapping as providerFor (src/lib/membership/source.js): the two
// registered sources by name, everything else (incl. the unregistered 'un1t'
// and a null) is 'none'.
function providerKeyOf(membershipSource) {
  if (membershipSource === 'un1t_online') return 'un1t_online'
  if (membershipSource === 'glofox') return 'glofox'
  return 'none'
}

const time = (v) => (v ? Date.parse(v) || 0 : 0)

function glofoxStudioFor(location, contacts) {
  const accounts = contacts.filter((c) => c?.location_id === location.id && c.glofox_member_id)
  const ordered = [...accounts].sort((a, b) =>
    Number(hasBookableMembership(b)) - Number(hasBookableMembership(a)) || String(a.id).localeCompare(String(b.id)))
  return {
    active: glofoxStudioActive(accounts),
    contactIds: ordered.map((c) => c.id),
    glofoxMemberId: ordered[0]?.glofox_member_id,
  }
}

function un1tStudioFor(location, contacts, clients, subscriptions) {
  const atHere = (r) => r?.location_id === location.id
  const hereClients = clients.filter(atHere)
  const hereSubs = subscriptions.filter(atHere)
  const userIds = [...new Set([...hereClients, ...hereSubs].map((r) => r.un1t_user_id).filter(Boolean))]
  if (!userIds.length) return { active: false, contactIds: [] }

  const candidates = userIds.map((userId) => {
    const client = hereClients.find((c) => c.un1t_user_id === userId)
    const subs = hereSubs.filter((s) => s.un1t_user_id === userId)
    return { userId, client, active: un1tStudioActive({ subscriptions: subs, client }), seen: time(client?.last_attended_at) }
  })
  // One person, two un1t.online accounts at one studio: pick deterministically
  // (a live account first, then the most recently attended, then the lexically
  // first id) and never mix the other user's contacts into this studio.
  candidates.sort((a, b) => Number(b.active) - Number(a.active) || b.seen - a.seen || a.userId.localeCompare(b.userId))
  const chosen = candidates[0]
  if (candidates.length > 1) {
    logWarn(LOG_MODULE, 'multiple_un1t_users', {
      locationId: location.id,
      chosenUserId: chosen.userId,
      userIds: candidates.map((c) => c.userId),
    })
  }
  const ids = contacts
    .filter((c) => c.un1t_user_id === chosen.userId || (chosen.client?.contact_id && c.id === chosen.client.contact_id))
    .map((c) => c.id)
  return { active: chosen.active, contactIds: [...new Set(ids)].sort(), un1tUserId: chosen.userId }
}

/**
 * One MemberStudio per location in `locations` (the caller passes the
 * candidates: studios the person has an account at, plus the thread studio).
 * Pure apart from the multiple_un1t_users warning.
 *
 * contacts: the person group's rows, each with id, location_id,
 * glofox_member_id, the glofox membership columns and un1t_user_id.
 * agentOnByLocation: { [locationId]: boolean } from isAgentOnForSender.
 */
export function classifyMemberStudios({ contacts = [], un1tClients = [], un1tSubscriptions = [], locations = [], agentOnByLocation = {} } = {}) {
  return locations.map((location) => {
    const providerKey = providerKeyOf(location.membership_source)
    const base = { locationId: location.id, name: location.name, providerKey }
    const answerable = agentOnByLocation?.[location.id] === true
    if (providerKey === 'glofox') {
      const g = glofoxStudioFor(location, contacts)
      const studio = { ...base, active: g.active, answerable, contactIds: g.contactIds }
      if (g.glofoxMemberId) studio.glofoxMemberId = g.glofoxMemberId
      return studio
    }
    if (providerKey === 'un1t_online') {
      const u = un1tStudioFor(location, contacts, un1tClients, un1tSubscriptions)
      const studio = { ...base, active: u.active, answerable, contactIds: u.contactIds }
      if (u.un1tUserId) studio.un1tUserId = u.un1tUserId
      return studio
    }
    return { ...base, active: false, answerable, contactIds: [] }
  })
}

const hasAccount = (s) => !!(s.un1tUserId || s.glofoxMemberId)

/**
 * Which studios Mia may answer for on this turn (spec 6.1).
 *   'active'   — studios where the person is active AND the gate passes.
 *   'fallback' — none of those, but exactly one studio the person has an
 *                account at is answerable.
 *   'thread'   — neither: answerable is [] and the caller keeps today's
 *                thread-studio behaviour.
 * The thread studio is listed first. Pure.
 */
export function answerableStudios(studios, threadLocationId) {
  const list = studios || []
  const threadFirst = (arr) => [...arr].sort((a, b) => Number(b.locationId === threadLocationId) - Number(a.locationId === threadLocationId))
  const activeAnswerable = list.filter((s) => s.active && s.answerable)
  if (activeAnswerable.length) return { answerable: threadFirst(activeAnswerable), basis: 'active' }
  const withAccount = list.filter((s) => s.answerable && hasAccount(s))
  if (withAccount.length === 1) return { answerable: withAccount, basis: 'fallback' }
  return { answerable: [], basis: 'thread' }
}

/**
 * A un1t.online studio the person is active at but Mia may not answer for,
 * while the thread studio is not active and nothing is answerable-active: the
 * case where the reply should point them at the other studio. Pure.
 */
export function otherStudioOnly(studios, threadLocationId) {
  const list = studios || []
  if (list.some((s) => s.active && s.answerable)) return null
  if (list.some((s) => s.locationId === threadLocationId && s.active)) return null
  return list.find((s) => s.providerKey === 'un1t_online' && s.active && !s.answerable && s.locationId !== threadLocationId) || null
}

const FAILED = () => ({ studios: [], readFailed: true })

async function readChunked(db, table, columns, filterCol, ids, extraIn) {
  const rows = []
  for (const batch of chunkIds(ids)) {
    for (const scope of extraIn ? chunkIds(extraIn.ids) : [null]) {
      let q = db.from(table).select(columns).in(filterCol, batch)
      if (scope) q = q.in(extraIn.col, scope)
      const { data, error } = await q
      if (error) throw error
      rows.push(...(data || []))
    }
  }
  return rows
}

/**
 * The IO function. Reads the person group, the un1t.online mirror rows for its
 * un1t_user_ids at this organisation's studios, those studios, and one Mia
 * settings resolve per candidate studio (sharing one orgCache).
 *
 * Candidates = organisation studios where the group has an account (a contact
 * with a glofox_member_id there, or a un1t_clients / un1t_subscriptions row)
 * plus the thread studio.
 *
 * Any failed read -> { studios: [], readFailed: true }, never a guess.
 */
export async function resolveMemberStudios(db, { anchorContactId, threadLocationId, organizationId, senderPhone } = {}) {
  if (!db || !anchorContactId) return FAILED()
  try {
    const group = await linkedAccountsForContact(db, anchorContactId)
    if (group.readFailed) return FAILED()

    // linkedAccountsForContact's rows do not carry un1t_user_id (and its
    // column list stays as it is): read it for the same ids here.
    const groupIds = [...new Set([anchorContactId, ...group.contacts.map((c) => c.id)])]
    const linkRows = await readChunked(db, 'contacts', 'id, un1t_user_id, location_id', 'id', groupIds)
    const linkById = new Map(linkRows.map((r) => [r.id, r]))
    const contacts = group.contacts.map((c) => ({ ...c, un1t_user_id: linkById.get(c.id)?.un1t_user_id ?? null }))

    let orgLocations
    if (organizationId) {
      const { data, error } = await db.from('locations')
        .select('id, name, membership_source, organization_id')
        .eq('organization_id', organizationId)
      if (error) throw error
      orgLocations = data || []
    } else if (threadLocationId) {
      const { data, error } = await db.from('locations')
        .select('id, name, membership_source, organization_id')
        .eq('id', threadLocationId)
      if (error) throw error
      orgLocations = data || []
    } else {
      orgLocations = []
    }
    const orgLocationIds = orgLocations.map((l) => l.id)

    const userIds = [...new Set(contacts.map((c) => c.un1t_user_id).filter(Boolean))]
    let un1tClients = []
    let un1tSubscriptions = []
    if (userIds.length && orgLocationIds.length) {
      const scope = { col: 'location_id', ids: orgLocationIds }
      un1tClients = await readChunked(db, 'un1t_clients',
        'location_id, un1t_user_id, contact_id, credit_balance, credit_unlimited, last_attended_at', 'un1t_user_id', userIds, scope)
      un1tSubscriptions = await readChunked(db, 'un1t_subscriptions',
        'location_id, un1t_user_id, status', 'un1t_user_id', userIds, scope)
    }

    const accountLocationIds = new Set([
      ...contacts.filter((c) => c.glofox_member_id && c.location_id).map((c) => c.location_id),
      ...un1tClients.map((r) => r.location_id),
      ...un1tSubscriptions.map((r) => r.location_id),
    ])
    if (threadLocationId) accountLocationIds.add(threadLocationId)
    const candidates = orgLocations.filter((l) => accountLocationIds.has(l.id))

    const orgCache = new Map()
    const resolved = await Promise.all(candidates.map((l) => resolveAgentSettings(db, l.id, { orgCache })))
    const agentOnByLocation = {}
    for (let i = 0; i < candidates.length; i++) {
      if (!resolved[i]?.ok) return FAILED()
      agentOnByLocation[candidates[i].id] = isAgentOnForSender(resolved[i].settings, senderPhone)
    }

    const studios = classifyMemberStudios({ contacts, un1tClients, un1tSubscriptions, locations: candidates, agentOnByLocation })
    return { studios, readFailed: false }
  } catch (err) {
    logWarn(LOG_MODULE, 'member studio read failed', { anchorContactId, err })
    return FAILED()
  }
}
