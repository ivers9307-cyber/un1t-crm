import { describe, it, expect } from 'vitest'
import { shapeTenantHealth } from './tenant-health.js'

describe('shapeTenantHealth (SAAS4-O4 — /admin/health)', () => {
  const locations = [
    { id: 'l1', name: 'Stillorgan', organization_id: 'o1', organizations: { name: 'UN1T Group' } },
    { id: 'l2', name: 'Hatch', organization_id: 'o1', organizations: { name: 'UN1T Group' } },
    { id: 'l3', name: 'CCF HQ', organization_id: 'o2', organizations: { name: 'CCF Autos' } },
  ]

  it('groups locations by organization and attaches per-location signals', () => {
    const out = shapeTenantHealth({
      locations,
      heartbeats: [
        { name: 'glofox-sync', location_id: 'l1', is_stale: false, stale_seconds: 120, muted: false },
        { name: 'glofox-sync', location_id: 'l2', is_stale: true, stale_seconds: 90000, muted: false },
      ],
      connections: [
        { location_id: 'l1', platform: 'instagram', status: 'connected', last_error: null },
        { location_id: 'l2', platform: 'instagram', status: 'error', last_error: 'token expired' },
      ],
      rollups: [
        { location_id: 'l1', meter: 'anthropic_tokens', cost_cents: 250 },
        { location_id: 'l1', meter: 'anthropic_tokens', cost_cents: 50 },
      ],
      campaigns: [{ location_id: 'l2' }, { location_id: 'l2' }],
    })

    expect(out).toHaveLength(2)
    const un1t = out.find((o) => o.organizationId === 'o1')
    expect(un1t.name).toBe('UN1T Group')
    const still = un1t.locations.find((l) => l.id === 'l1')
    expect(still.heartbeats).toEqual([
      { name: 'glofox-sync', is_stale: false, stale_seconds: 120, muted: false },
    ])
    expect(still.aiCostCentsMtd).toBe(300)
    expect(still.campaignBacklog).toBe(0)
    const hatch = un1t.locations.find((l) => l.id === 'l2')
    expect(hatch.heartbeats[0].is_stale).toBe(true)
    expect(hatch.connections[0]).toMatchObject({ platform: 'instagram', status: 'error' })
    expect(hatch.campaignBacklog).toBe(2)
  })

  it('flags a location and its org as attention-needed when anything is stale or errored', () => {
    const out = shapeTenantHealth({
      locations,
      heartbeats: [{ name: 'glofox-sync', location_id: 'l2', is_stale: true, stale_seconds: 1, muted: false }],
      connections: [],
      rollups: [],
      campaigns: [],
    })
    const un1t = out.find((o) => o.organizationId === 'o1')
    expect(un1t.locations.find((l) => l.id === 'l2').needsAttention).toBe(true)
    expect(un1t.locations.find((l) => l.id === 'l1').needsAttention).toBe(false)
    expect(un1t.needsAttention).toBe(true)
    expect(out.find((o) => o.organizationId === 'o2').needsAttention).toBe(false)
  })

  it('muted heartbeats never flag attention', () => {
    const out = shapeTenantHealth({
      locations,
      heartbeats: [{ name: 'glofox-sync', location_id: 'l3', is_stale: true, stale_seconds: 1, muted: true }],
      connections: [],
      rollups: [],
      campaigns: [],
    })
    expect(out.find((o) => o.organizationId === 'o2').needsAttention).toBe(false)
  })

  it('tolerates empty inputs', () => {
    expect(shapeTenantHealth({ locations: [], heartbeats: null, connections: null, rollups: null, campaigns: null })).toEqual([])
  })
})
