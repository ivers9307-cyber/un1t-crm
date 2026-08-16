// TENANT.8 (item 3b) — tickCampaignSend now consults
// isFeatureEnabledAtLocation(campaign.locations, 'email') before doing
// any populate/send work, closing TENANT.6's accepted gap #2 for
// campaigns: a campaign configured before the location's email bundle
// was turned off used to keep sending regardless.
//
// The gate check runs BEFORE the populate phase, so these tests never
// need to mock campaign_recipients/contact_location_audience at all —
// a bundle-denied campaign never gets that far.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./app-url.js', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('./postmark.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendBatch: vi.fn(), buildAudienceQueryAsync: vi.fn() }
})

import { tickCampaignSend } from './campaign-sender.js'
import { buildAudienceQueryAsync } from './postmark.js'

// Populate-phase plumbing for the "proceeds past the gate" tests — an
// empty audience is the simplest way to reach a deterministic
// non-'bundle_disabled' phase without needing to mock the full
// send/Postmark path.
buildAudienceQueryAsync.mockResolvedValue({
  query: { order: () => ({ range: async () => ({ data: [], error: null }) }) },
})

function makeDb() {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') return Promise.resolve({}).then.bind(Promise.resolve({}))
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
    rpc() { return Promise.resolve({ error: null }) },
  }
  return { db, statements }
}

function campaignsUpdate(statements) {
  return statements.find((s) => s.table === 'campaigns' && s.ops[0]?.method === 'update')
}

const baseCampaign = {
  id: 'camp-1',
  name: 'July offer',
  location_id: 'loc-1',
  postmark_stream: null,
  cancel_requested_at: null,
  // Not-yet-populated — the "proceeds past the gate" tests only need to
  // reach a deterministic phase, and an empty-audience populate (mocked
  // buildAudienceQueryAsync above) finalises cleanly with no further
  // campaign_recipients plumbing needed.
  send_started_at: null,
}

beforeEach(() => vi.clearAllMocks())

describe('tickCampaignSend — location bundle/feature gate (TENANT.8)', () => {
  it('SKIPS without sending when features.email is explicitly false', async () => {
    const { db, statements } = makeDb()
    const result = await tickCampaignSend(db, {
      ...baseCampaign,
      locations: { name: 'Stillorgan', features: { email: false } },
    })
    expect(result.phase).toBe('bundle_disabled')
    // Not an error result — must never feed campaignFailurePatch's
    // repeated-error escalation into status='failed'.
    expect(result.error).toBeUndefined()
    const upd = campaignsUpdate(statements)
    expect(upd).toBeTruthy()
    expect(upd.ops[0].args[0].last_error).toMatch(/disabled at this location/i)
  })

  it('SKIPS when every bundle owning `email` is explicitly off', async () => {
    const { db } = makeDb()
    const result = await tickCampaignSend(db, {
      ...baseCampaign,
      locations: { name: 'Stillorgan', features: { bundle_messaging: false, bundle_marketing: false } },
    })
    expect(result.phase).toBe('bundle_disabled')
  })

  it('does NOT gate when only one owning bundle is off (OR semantics)', async () => {
    const { db, statements } = makeDb()
    const result = await tickCampaignSend(db, {
      ...baseCampaign,
      locations: { name: 'Stillorgan', features: { bundle_messaging: false, bundle_marketing: true } },
    })
    expect(result.phase).not.toBe('bundle_disabled')
    // Proceeds into populate/send phases — no campaigns.update stamping last_error.
    const upd = campaignsUpdate(statements)
    expect(upd?.ops[0]?.args[0]?.last_error).toBeUndefined()
  })

  it('does NOT gate when the location has no features at all (back-compat)', async () => {
    const { db } = makeDb()
    const result = await tickCampaignSend(db, {
      ...baseCampaign,
      locations: { name: 'Stillorgan', features: {} },
    })
    expect(result.phase).not.toBe('bundle_disabled')
  })

  it('does NOT gate when the locations join is missing entirely — defaults open', async () => {
    const { db } = makeDb()
    const result = await tickCampaignSend(db, { ...baseCampaign, locations: undefined })
    expect(result.phase).not.toBe('bundle_disabled')
  })

  it('cancel-requested still processes even when the bundle is off (cancel check runs first)', async () => {
    const { db } = makeDb()
    const result = await tickCampaignSend(db, {
      ...baseCampaign,
      cancel_requested_at: '2026-08-16T09:00:00.000Z',
      locations: { name: 'Stillorgan', features: { email: false } },
    })
    expect(result.phase).toBe('cancelled')
  })
})
