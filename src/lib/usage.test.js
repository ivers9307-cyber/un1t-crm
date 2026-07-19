import { describe, it, expect, vi } from 'vitest'
import { estimateAnthropicCostCents, recordUsage } from './usage.js'

describe('estimateAnthropicCostCents', () => {
  it('prices sonnet-family tokens at $3/M input, $15/M output', () => {
    const cents = estimateAnthropicCostCents('claude-sonnet-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })
    expect(cents).toBeCloseTo(300 + 1500, 5)
  })

  it('prices cache reads at 0.1x and cache writes at 1.25x input rate', () => {
    const cents = estimateAnthropicCostCents('claude-sonnet-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    })
    expect(cents).toBeCloseTo(300 * 0.1 + 300 * 1.25, 5)
  })

  it('recognises the opus and haiku families', () => {
    expect(
      estimateAnthropicCostCents('claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 0 })
    ).toBeCloseTo(500, 5)
    expect(
      estimateAnthropicCostCents('claude-haiku-4-5', { input_tokens: 0, output_tokens: 1_000_000 })
    ).toBeCloseTo(500, 5)
  })

  it('falls back to sonnet pricing for unknown models and tolerates missing usage', () => {
    expect(estimateAnthropicCostCents('mystery-model', { input_tokens: 1_000_000 })).toBeCloseTo(300, 5)
    expect(estimateAnthropicCostCents('claude-sonnet-4-6', undefined)).toBe(0)
  })
})

describe('recordUsage', () => {
  function stubDb() {
    const inserts = []
    const insert = vi.fn(async (row) => {
      inserts.push(row)
      return { error: null }
    })
    return { db: { from: vi.fn(() => ({ insert })) }, inserts }
  }

  it('inserts a usage_events row with meter, source, location and token meta', async () => {
    const { db, inserts } = stubDb()
    await recordUsage(
      {
        locationId: 'loc-1',
        organizationId: null,
        source: 'mia_auto_reply',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5000 },
      },
      { db }
    )
    expect(db.from).toHaveBeenCalledWith('usage_events')
    expect(inserts).toHaveLength(1)
    const row = inserts[0]
    expect(row.meter).toBe('anthropic_tokens')
    expect(row.source).toBe('mia_auto_reply')
    expect(row.location_id).toBe('loc-1')
    expect(row.organization_id).toBeNull()
    expect(row.quantity).toBe(1200 + 340)
    expect(row.cost_estimate_cents).toBeGreaterThan(0)
    expect(row.meta).toMatchObject({
      model: 'claude-sonnet-4-6',
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 5000,
    })
  })

  it('never throws — a failed insert is swallowed (fire-and-forget convention)', async () => {
    const db = { from: () => ({ insert: async () => ({ error: { message: 'boom' } }) }) }
    await expect(
      recordUsage({ locationId: 'loc-1', source: 'x', model: 'm', usage: { input_tokens: 1 } }, { db })
    ).resolves.toBeUndefined()
  })

  it('never throws — even a throwing db is swallowed', async () => {
    const db = {
      from: () => {
        throw new Error('no client')
      },
    }
    await expect(
      recordUsage({ locationId: 'loc-1', source: 'x', model: 'm', usage: { input_tokens: 1 } }, { db })
    ).resolves.toBeUndefined()
  })

  it('skips the insert entirely when there is no usage payload', async () => {
    const { db, inserts } = stubDb()
    await recordUsage({ locationId: 'loc-1', source: 'x', model: 'm', usage: null }, { db })
    expect(inserts).toHaveLength(0)
  })
})
