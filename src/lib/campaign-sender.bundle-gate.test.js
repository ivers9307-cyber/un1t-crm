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
import { campaignFailurePatch } from '@/app/api/cron/run-campaigns/route.js'

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

  // ── BAREWRITE.4 — a lost rotation bump must never KILL the campaign ────────
  //
  // BAREWRITE.1 correctly stopped discarding the bump's error, then returned it
  // as `result.error`. On this path specifically that turns one transient blip
  // into a permanent kill, because the bundle gate writes `last_error` on EVERY
  // tick by design: campaignFailurePatch's "genuinely stuck" test is
  //   (last_error already present) && (no send_started_at) && (older than grace)
  // and a bundle-disabled campaign satisfies all three from its second tick
  // onwards. So the very first failed bump marked the campaign 'failed', which
  // an operator then has to resurrect by hand. That is a LOUDER failure than
  // the silent one it replaced.
  //
  // The bump is reported as a `warning` instead: surfaced by the cron (logged
  // at error level, counted in the response) but never fed to the kill switch.
  it('reports a FAILED rotation bump as a warning, never as an error', async () => {
    const db = {
      from(table) {
        if (table !== 'campaigns') throw new Error(`unexpected table ${table}`)
        const b = {
          update: () => b,
          eq: () => Promise.resolve({ error: { message: 'connection reset' } }),
        }
        return b
      },
      rpc: () => Promise.resolve({ error: null }),
    }
    const result = await tickCampaignSend(db, {
      ...baseCampaign,
      locations: { name: 'Stillorgan', features: { email: false } },
    })

    expect(result.phase).toBe('bundle_disabled')
    // THE REGRESSION: an `error` here reaches campaignFailurePatch.
    expect(result.error).toBeUndefined()
    // …but the loss is still reported, loudly, on its own channel.
    expect(result.warning).toMatch(/rotation bump failed/i)
  })

  it('proves the kill: campaignFailurePatch WOULD mark a bundle-disabled campaign failed', async () => {
    // Why the warning/error split is load-bearing rather than cosmetic. This is
    // the exact row shape the cron re-reads on the tick after a bundle-disabled
    // one, fed the error the branch used to return.
    const bundleDisabledOnTheNextTick = {
      id: 'camp-1',
      created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      send_started_at: null,
      last_error: 'Skipped — email is disabled at this location (feature toggle or bundle off).',
    }
    const patch = campaignFailurePatch(
      bundleDisabledOnTheNextTick,
      'rotation bump failed: connection reset',
    )
    expect(patch.status).toBe('failed')
  })

  // ── BAREWRITE.5 — nor may a lost EMPTY-AUDIENCE finalise kill the campaign ──
  //
  // The same shape one function lower down, and it needed the same answer.
  // BAREWRITE.1 surfaced this write's error as `result.error`, which reaches
  // campaignFailurePatch. The empty-audience finalise runs inside POPULATE, so
  // `send_started_at` is still null — one of the three conditions for "genuinely
  // stuck" — and the cron never clears `campaigns.last_error` (only
  // /api/campaigns/[id]/send does), so any campaign carrying an older error is
  // flipped to 'failed' by ONE transient blip here. 'failed' is terminal: the
  // cron picks only 'queued'/'sending'.
  //
  // What `main` did was silent, but it was also RIGHT: the campaign stays open
  // and the next tick re-runs populate, finds the same empty audience, and
  // finalises the moment the write lands. Keep the self-healing loop, add the
  // visibility, drop the kill.
  it('reports a FAILED empty-audience finalise as a warning, never as an error', async () => {
    const db = {
      from(table) {
        if (table === 'campaigns') {
          const b = { update: () => b, eq: () => Promise.resolve({ error: { message: 'connection reset' } }) }
          return b
        }
        const p = new Proxy({}, {
          get(_, method) {
            if (method === 'then') return Promise.resolve({}).then.bind(Promise.resolve({}))
            return () => p
          },
        })
        return p
      },
      rpc: () => Promise.resolve({ error: null }),
    }

    const result = await tickCampaignSend(db, {
      ...baseCampaign,
      locations: { name: 'Stillorgan', features: {} },
    })

    expect(result.phase).toBe('populate')
    // THE REGRESSION: an `error` here reaches campaignFailurePatch.
    expect(result.error).toBeUndefined()
    expect(result.warning).toMatch(/could not finalise an empty-audience campaign/i)
  })

  it('proves that kill too: a campaign with an older last_error and no send_started_at is marked failed', async () => {
    // Exactly the row the cron re-reads for a campaign that errored once before
    // and has not started sending — which is every campaign still in populate.
    const patch = campaignFailurePatch(
      {
        id: 'camp-1',
        created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
        send_started_at: null,
        last_error: 'audience load failed: connection reset',
      },
      'connection reset',
    )
    expect(patch.status).toBe('failed')
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
