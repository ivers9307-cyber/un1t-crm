// CARDLENS.7 — one membership view per studio the person has a relationship
// with, the same shape whichever system the studio runs. Pure.
//
// A Glofox studio's facts come from the contacts row (the Glofox sync writes
// them there), and only when the contact has a Glofox account. A un1t.online
// studio's facts come from that studio's un1t_clients row and its billing
// (loadUn1tBilling), which the page reads only for studios where the viewer
// holds Contacts. Glofox facts never land on a un1t.online studio, and
// anything not known is null, never 0.
import { overdueAmountKind } from '@/components/command-centre-arrears'

const PLATFORMS = new Set(['glofox', 'un1t_online'])

/**
 * @typedef {object} StudioMembership
 * @property {string} locationId
 * @property {string} name
 * @property {'glofox'|'un1t_online'|'none'} platform
 * @property {boolean} primary
 * @property {string} kind              member | client | lead
 * @property {string} status            active | ended
 * @property {string|null} plan
 * @property {number|null} priceCents   Glofox only
 * @property {string|null} priceInterval
 * @property {string|null} creditsLine
 * @property {number|null} attended30d
 * @property {string|null} lastAttendedAt
 * @property {number|null} ltvCents
 * @property {number|null} owedCents    EUR; null when unknown or not reported
 * @property {boolean} overdue
 * @property {boolean} amountUnreported
 * @property {string|null} syncedAt
 */

/**
 * @param {object} a
 * @param {object} a.contact            the contacts row
 * @param {Array<object>} a.studioRows  loadContactStudios(...).rows
 * @param {Array<object>} [a.un1tClients]  un1t_clients rows (location_id, last_attended_at,
 *   bookings_30d_attended, credit_balance, credit_unlimited, ltv_cents, synced_at)
 * @param {{ studios?: Array<object> }} [a.un1tBilling]  loadUn1tBilling(...)
 * @param {number|null} [a.glofoxArrearsCents]  the Glofox chase-list figure
 * @returns {StudioMembership[]} primary first, then by name
 */
export function studioMemberships({ contact, studioRows, un1tClients = [], un1tBilling = null, glofoxArrearsCents = null }) {
  const primaryId = contact?.location_id || null
  const clientsByLoc = new Map((un1tClients || []).filter((c) => c?.location_id).map((c) => [c.location_id, c]))
  const billingByLoc = new Map((un1tBilling?.studios || []).map((s) => [s.locationId, s]))
  const seen = new Set()
  const out = []
  for (const r of studioRows || []) {
    if (!r?.location_id || seen.has(r.location_id)) continue
    seen.add(r.location_id)
    const source = r.location?.membership_source
    const platform = PLATFORMS.has(source) ? source : 'none'
    const base = {
      locationId: r.location_id,
      name: r.location?.name || 'Studio',
      platform,
      primary: r.location_id === primaryId,
      kind: r.kind || null,
      status: r.status || null,
      plan: null,
      priceCents: null,
      priceInterval: null,
      creditsLine: null,
      attended30d: null,
      lastAttendedAt: null,
      ltvCents: null,
      owedCents: null,
      overdue: false,
      amountUnreported: false,
      syncedAt: null,
    }
    if (platform === 'glofox') out.push({ ...base, ...glofoxFacts(contact, glofoxArrearsCents) })
    else if (platform === 'un1t_online') out.push({ ...base, ...un1tFacts(r, clientsByLoc.get(r.location_id), billingByLoc.get(r.location_id)) })
    else out.push(base)
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name))
}

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null)

function glofoxFacts(contact, glofoxArrearsCents) {
  if (!contact?.glofox_member_id) return {}
  const credits = num(contact.trial_credits_remaining)
  const owed = num(glofoxArrearsCents)
  return {
    plan: contact.glofox_membership_plan || null,
    priceCents: num(contact.glofox_membership_price_cents) || null,
    priceInterval: contact.glofox_billing_interval || null,
    creditsLine: credits != null ? `${credits} trial credit${credits === 1 ? '' : 's'}` : null,
    attended30d: num(contact.total_attended_30d),
    lastAttendedAt: contact.last_attended_at || null,
    ltvCents: num(contact.lifetime_value_cents),
    owedCents: owed,
    overdue: contact.glofox_membership_state === 'locked' || (owed != null && owed > 0),
    syncedAt: contact.glofox_synced_at || null,
  }
}

function un1tFacts(row, client, billing) {
  const out = { plan: row.membership_plan || null }
  if (client) {
    out.attended30d = num(client.bookings_30d_attended)
    out.lastAttendedAt = client.last_attended_at || null
    out.ltvCents = num(client.ltv_cents)
    out.syncedAt = client.synced_at || null
    const balance = num(client.credit_balance)
    out.creditsLine = client.credit_unlimited === true
      ? 'Unlimited credits'
      : (balance != null ? `${balance} credit${balance === 1 ? '' : 's'}` : null)
  }
  if (billing) {
    const dues = billing.pastDues || []
    let eur = 0
    let unreported = false
    for (const p of dues) {
      if (overdueAmountKind(p) === 'eur') eur += p.amountCents
      else unreported = true
    }
    out.overdue = dues.length > 0
    out.amountUnreported = unreported
    out.owedCents = dues.length === 0 ? 0 : (eur > 0 ? eur : null)
  }
  return out
}
