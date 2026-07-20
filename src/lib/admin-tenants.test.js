// INTEG-D2 — pure-helper tests for the /admin/tenants console assembly.

import { describe, it, expect } from 'vitest'
import {
  sumMrrCents,
  planSummary,
  pastDueCount,
  sumTopupsCents,
  aggregateUsage,
  staleHeartbeatsByLocation,
  summariseHubForLocation,
  attentionCountByOrg,
} from './admin-tenants'

const tierPin = (price, name = 'Growth', overrides = {}) => ({
  active: true,
  version: { price_cents: price, plan: { kind: 'tier', name, slug: name.toLowerCase() } },
  ...overrides,
})
const addonPin = (price) => ({
  active: true,
  version: { price_cents: price, plan: { kind: 'addon', name: 'Custom email domain', slug: 'custom_email_domain' } },
})

describe('sumMrrCents', () => {
  it('is 0 for empty / missing pins (today: every location unpinned)', () => {
    expect(sumMrrCents([])).toBe(0)
    expect(sumMrrCents(undefined)).toBe(0)
  })

  it('sums ACTIVE tier pins only — add-ons and inactive pins excluded', () => {
    expect(sumMrrCents([
      tierPin(9900),
      tierPin(19900, 'Scale'),
      tierPin(9900, 'Growth', { active: false }),
      addonPin(1500),
    ])).toBe(29800)
  })

  it('the pinned version price counts, not any newer one (grandfathering)', () => {
    // Two locations on the same plan but different pinned versions.
    expect(sumMrrCents([tierPin(9900), tierPin(10900)])).toBe(20800)
  })

  it('ignores malformed rows and non-finite prices', () => {
    expect(sumMrrCents([
      { active: true }, // no version
      { active: true, version: { price_cents: 'abc', plan: { kind: 'tier' } } },
      tierPin(5000),
    ])).toBe(5000)
  })
})

describe('planSummary', () => {
  it('null when nothing is pinned (renders "—")', () => {
    expect(planSummary([])).toBeNull()
    expect(planSummary([addonPin(1500)])).toBeNull()
    expect(planSummary([tierPin(9900, 'Growth', { active: false })])).toBeNull()
  })

  it('"Growth ×2" for two locations on the same tier', () => {
    expect(planSummary([tierPin(9900), tierPin(9900)])).toBe('Growth ×2')
  })

  it('mixed tiers list highest count first, ties alphabetical', () => {
    expect(planSummary([
      tierPin(9900), tierPin(9900), tierPin(19900, 'Scale'),
    ])).toBe('Growth ×2 · Scale ×1')
    expect(planSummary([tierPin(9900, 'Alpha'), tierPin(9900, 'Beta')]))
      .toBe('Alpha ×1 · Beta ×1')
  })
})

describe('pastDueCount', () => {
  it('counts wallets below zero (inside the grace floor)', () => {
    expect(pastDueCount([
      { balance_cents: 500 },
      { balance_cents: 0 },
      { balance_cents: -1 },
      { balance_cents: -1000 },
    ])).toBe(2)
  })

  it('empty / malformed input → 0', () => {
    expect(pastDueCount([])).toBe(0)
    expect(pastDueCount(undefined)).toBe(0)
    expect(pastDueCount([{}])).toBe(0)
  })
})

describe('sumTopupsCents', () => {
  const monthStart = '2026-07-01'

  it('sums topup rows inside the Dublin month', () => {
    expect(sumTopupsCents([
      { kind: 'topup', amount_cents: 5000, created_at: '2026-07-05T10:00:00Z' },
      { kind: 'topup', amount_cents: 2500, created_at: '2026-07-19T10:00:00Z' },
    ], monthStart)).toBe(7500)
  })

  it('drops non-topup kinds even if present in the input', () => {
    expect(sumTopupsCents([
      { kind: 'adjustment', amount_cents: 5000, created_at: '2026-07-05T10:00:00Z' },
      { kind: 'topup', amount_cents: 100, created_at: '2026-07-05T10:00:00Z' },
    ], monthStart)).toBe(100)
  })

  it('over-fetched previous-month rows are filtered by DUBLIN day', () => {
    // 2026-06-30T23:30:00Z is 00:30 on 1 Jul in Dublin (IST) → COUNTS.
    // 2026-06-30T22:30:00Z is 23:30 on 30 Jun in Dublin → dropped.
    expect(sumTopupsCents([
      { kind: 'topup', amount_cents: 1000, created_at: '2026-06-30T23:30:00Z' },
      { kind: 'topup', amount_cents: 2000, created_at: '2026-06-30T22:30:00Z' },
    ], monthStart)).toBe(1000)
  })
})

describe('aggregateUsage', () => {
  const locationOrgMap = { 'loc-1': 'org-a', 'loc-2': 'org-a', 'loc-3': 'org-b' }

  it('sums wa/email rollups per location and org, ignoring other meters', () => {
    const { byLocation, byOrg } = aggregateUsage({
      rollupRows: [
        { organization_id: 'org-a', location_id: 'loc-1', meter: 'wa_template_send', quantity: 5 },
        { organization_id: 'org-a', location_id: 'loc-1', meter: 'wa_template_send', quantity: 3 },
        { organization_id: 'org-a', location_id: 'loc-2', meter: 'email_send', quantity: 200 },
        { organization_id: 'org-a', location_id: 'loc-1', meter: 'anthropic_tokens', quantity: 99999 },
        { organization_id: 'org-a', location_id: 'loc-1', meter: 'sms_send', quantity: 7 },
      ],
      aiEventRows: [],
      locationOrgMap,
    })
    expect(byLocation['loc-1'].wa_template_send).toBe(8)
    expect(byLocation['loc-2'].email_send).toBe(200)
    expect(byOrg['org-a']).toEqual({ wa_template_send: 8, email_send: 200, ai_message: 0, assistant_chat: 0 })
  })

  it('AI events count 1 message each; assistant_chat is EXEMPT and tallied separately', () => {
    const { byLocation, byOrg } = aggregateUsage({
      rollupRows: [],
      aiEventRows: [
        { organization_id: 'org-a', location_id: 'loc-1', source: 'mia_auto_reply' },
        { organization_id: 'org-a', location_id: 'loc-1', source: 'flow_agent' },
        { organization_id: 'org-a', location_id: 'loc-1', source: 'assistant_chat' },
      ],
      locationOrgMap,
    })
    expect(byLocation['loc-1'].ai_message).toBe(2)
    expect(byLocation['loc-1'].assistant_chat).toBe(1)
    expect(byOrg['org-a'].ai_message).toBe(2)
    expect(byOrg['org-a'].assistant_chat).toBe(1)
  })

  it('resolves org via the location map when organization_id is null on the raw event', () => {
    const { byOrg } = aggregateUsage({
      rollupRows: [],
      aiEventRows: [
        { organization_id: null, location_id: 'loc-3', source: 'mia_auto_reply' },
      ],
      locationOrgMap,
    })
    expect(byOrg['org-b'].ai_message).toBe(1)
  })

  it('empty input → empty maps', () => {
    expect(aggregateUsage({})).toEqual({ byLocation: {}, byOrg: {} })
  })
})

describe('staleHeartbeatsByLocation', () => {
  it('keeps only stale, unmuted rows, grouped by location', () => {
    const out = staleHeartbeatsByLocation([
      { name: 'glofox-sync', location_id: 'loc-1', is_stale: true, muted: false, stale_seconds: 90000 },
      { name: 'usage-rollup', location_id: 'loc-1', is_stale: false, muted: false, stale_seconds: 60 },
      { name: 'glofox-sync', location_id: 'loc-2', is_stale: true, muted: true, stale_seconds: 999999 },
      { name: 'wallet-monthly-reset', location_id: 'loc-2', is_stale: true, muted: false, stale_seconds: 172800 },
    ])
    expect(out['loc-1']).toEqual([{ name: 'glofox-sync', stale_seconds: 90000 }])
    expect(out['loc-2']).toEqual([{ name: 'wallet-monthly-reset', stale_seconds: 172800 }])
  })

  it('empty / healthy input → empty map', () => {
    expect(staleHeartbeatsByLocation([])).toEqual({})
    expect(staleHeartbeatsByLocation(undefined)).toEqual({})
  })
})

describe('summariseHubForLocation', () => {
  const hub = {
    glofox: [{ locationId: 'loc-1', status: 'connected' }],
    whatsapp: [{ locationId: 'loc-1', status: 'error' }, { locationId: 'loc-2', status: 'connected' }],
    xero: [{ locationId: 'loc-2', status: 'connected' }],
    instagram: [],
    ads: [],
    unifi: [],
    climate: [],
    bca: [],
    attention: [
      { cardKey: 'whatsapp', locationId: 'loc-1', label: 'WhatsApp', message: 'Token invalid' },
      { cardKey: 'xero', locationId: 'loc-2', label: 'Xero', message: 'Sync error' },
    ],
  }

  it('lists only the sections that have a row for the location', () => {
    const s = summariseHubForLocation(hub, 'loc-1')
    expect(s.connections).toEqual([
      { key: 'glofox', label: 'Glofox', status: 'connected' },
      { key: 'whatsapp', label: 'WhatsApp', status: 'error' },
    ])
  })

  it('filters attention to the location', () => {
    expect(summariseHubForLocation(hub, 'loc-1').attention).toHaveLength(1)
    expect(summariseHubForLocation(hub, 'loc-1').attention[0].cardKey).toBe('whatsapp')
    expect(summariseHubForLocation(hub, 'loc-2').attention[0].cardKey).toBe('xero')
  })

  it('degrades to empty when hub assembly was skipped/failed (null)', () => {
    expect(summariseHubForLocation(null, 'loc-1')).toEqual({ connections: [], attention: [] })
  })
})

describe('attentionCountByOrg', () => {
  it('counts attention items through the location→org map', () => {
    const out = attentionCountByOrg(
      [
        { locationId: 'loc-1' },
        { locationId: 'loc-1' },
        { locationId: 'loc-3' },
        { locationId: 'loc-unknown' },
      ],
      { 'loc-1': 'org-a', 'loc-3': 'org-b' }
    )
    expect(out).toEqual({ 'org-a': 2, 'org-b': 1 })
  })

  it('empty input → empty map', () => {
    expect(attentionCountByOrg([], {})).toEqual({})
    expect(attentionCountByOrg(undefined, undefined)).toEqual({})
  })
})
