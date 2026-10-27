import { describe, it, expect } from 'vitest'
import { studioMemberships } from './contact-studio-memberships.js'

const STILL = 'a0000000-0000-4000-8000-00000000000a'
const HATCH = 'b0000000-0000-4000-8000-00000000000b'
const CCF = 'c0000000-0000-4000-8000-00000000000c'

const row = (id, name, source, extra = {}) => ({
  location_id: id, kind: 'member', status: 'active', source: source === 'un1t_online' ? 'un1t_online' : 'glofox',
  membership_plan: null, membership_status: null, membership_since: null, membership_ended_at: null,
  location: { id, name, active: true, is_host_anchor: false, membership_source: source },
  ...extra,
})

const CONTACT = {
  id: 'd0000000-0000-4000-8000-00000000000d',
  location_id: STILL,
  glofox_member_id: 'gx-1',
  glofox_membership_plan: 'Unlimited monthly',
  glofox_membership_price_cents: 12000,
  glofox_billing_interval: 'month',
  glofox_membership_state: 'active',
  trial_credits_remaining: null,
  total_attended_30d: 9,
  last_attended_at: '2026-10-25T07:00:00Z',
  lifetime_value_cents: 90000,
  lifetime_currency: 'EUR',
  glofox_synced_at: '2026-10-27T10:00:00Z',
}
const ROWS = [
  row(STILL, 'UN1T Stillorgan', 'glofox'),
  row(HATCH, 'UN1T Hatch Street', 'un1t_online', { kind: 'client', membership_plan: '10-class pack', membership_status: 'active' }),
]
const CLIENTS = [{ location_id: HATCH, last_attended_at: '2026-10-21T18:30:00Z', bookings_30d_attended: 3, credit_balance: 4, credit_unlimited: false, ltv_cents: 15000, synced_at: '2026-10-27T10:30:00Z' }]
const BILLING = { studios: [{ locationId: HATCH, pastDues: [{ amountCents: 4500, currency: 'EUR' }], subscriptions: [], transactions: [], invoices: [] }] }

const byId = (list) => Object.fromEntries(list.map((m) => [m.locationId, m]))

describe('studioMemberships (CARDLENS.7)', () => {
  it('one entry per studio, primary first, each on its own platform', () => {
    const m = studioMemberships({ contact: CONTACT, studioRows: ROWS, un1tClients: CLIENTS, un1tBilling: BILLING, glofoxArrearsCents: 0 })
    expect(m.map((x) => [x.locationId, x.platform, x.primary])).toEqual([[STILL, 'glofox', true], [HATCH, 'un1t_online', false]])
  })

  it('the Glofox studio carries the Glofox facts', () => {
    const s = byId(studioMemberships({ contact: CONTACT, studioRows: ROWS, un1tClients: CLIENTS, un1tBilling: BILLING, glofoxArrearsCents: 0 }))[STILL]
    expect(s).toMatchObject({ name: 'UN1T Stillorgan', kind: 'member', status: 'active', plan: 'Unlimited monthly', attended30d: 9, lastAttendedAt: '2026-10-25T07:00:00Z', ltvCents: 90000, owedCents: 0, overdue: false, syncedAt: '2026-10-27T10:00:00Z' })
  })

  it('the un1t.online studio carries its own facts and never the Glofox ones', () => {
    const h = byId(studioMemberships({ contact: CONTACT, studioRows: ROWS, un1tClients: CLIENTS, un1tBilling: BILLING, glofoxArrearsCents: 0 }))[HATCH]
    expect(h).toMatchObject({ plan: '10-class pack', creditsLine: '4 credits', attended30d: 3, lastAttendedAt: '2026-10-21T18:30:00Z', ltvCents: 15000, owedCents: 4500, overdue: true, amountUnreported: false, syncedAt: '2026-10-27T10:30:00Z' })
    expect(h.plan).not.toBe('Unlimited monthly')
  })

  it('un1t overdue with no amount: overdue, owed unknown (null, never 0), amount unreported', () => {
    const billing = { studios: [{ locationId: HATCH, pastDues: [{ amountCents: null, currency: null }] }] }
    const h = byId(studioMemberships({ contact: CONTACT, studioRows: ROWS, un1tClients: CLIENTS, un1tBilling: billing }))[HATCH]
    expect(h).toMatchObject({ overdue: true, owedCents: null, amountUnreported: true })
  })

  it('unknown is null, never 0: a un1t studio the viewer cannot read billing or clients for', () => {
    const h = byId(studioMemberships({ contact: CONTACT, studioRows: ROWS }))[HATCH]
    expect(h).toMatchObject({ attended30d: null, lastAttendedAt: null, ltvCents: null, owedCents: null, overdue: false, creditsLine: null, syncedAt: null })
  })

  it('a Glofox studio for a contact with no Glofox account has no Glofox facts', () => {
    const s = byId(studioMemberships({ contact: { ...CONTACT, glofox_member_id: null }, studioRows: ROWS }))[STILL]
    expect(s).toMatchObject({ plan: null, attended30d: null, lastAttendedAt: null, ltvCents: null, syncedAt: null })
  })

  it('a lead-only studio with no membership system', () => {
    const rows = [...ROWS, row(CCF, 'CCF Autos', 'none', { kind: 'lead', source: 'lead_form' })]
    const c = byId(studioMemberships({ contact: CONTACT, studioRows: rows }))[CCF]
    expect(c).toMatchObject({ platform: 'none', kind: 'lead', plan: null, attended30d: null })
  })

  it('unlimited credits say so', () => {
    const h = byId(studioMemberships({ contact: CONTACT, studioRows: ROWS, un1tClients: [{ ...CLIENTS[0], credit_unlimited: true }] }))[HATCH]
    expect(h.creditsLine).toBe('Unlimited credits')
  })

  it('a locked Glofox membership is overdue there', () => {
    const s = byId(studioMemberships({ contact: { ...CONTACT, glofox_membership_state: 'locked' }, studioRows: ROWS, glofoxArrearsCents: 12000 }))[STILL]
    expect(s).toMatchObject({ overdue: true, owedCents: 12000 })
  })

  it('a closed studio or a host anchor is not a membership (it would make a one-studio person "multi")', () => {
    const rows = [ROWS[0], row(CCF, 'Old studio', 'none', { location: { id: CCF, name: 'Old studio', active: false, membership_source: 'none' } }), row(HATCH, 'Host', 'none', { location: { id: HATCH, name: 'Host', active: true, is_host_anchor: true, membership_source: 'none' } })]
    expect(studioMemberships({ contact: CONTACT, studioRows: rows }).map((m) => m.locationId)).toEqual([STILL])
  })

  it('no rows (a failed read): empty, so the page keeps its old cards', () => {
    expect(studioMemberships({ contact: CONTACT, studioRows: [] })).toEqual([])
  })
})
