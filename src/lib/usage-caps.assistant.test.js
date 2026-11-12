// ASSISTCAP.1 — the staff assistant's OWN spend cap (mig 806).
//
// The property that matters most here is the PARTITION: Mia's cap and the
// assistant's cap read two different sums, so neither can exhaust the other's
// budget. mig 421 excluded source 'assistant_chat' from
// org_ai_spend_month_cents and this reads only it, so a test that proves each
// status asks its OWN rpc is proving the thing that would break if someone
// later "simplified" the two into one.

import { describe, it, expect, vi } from 'vitest'
import { getAiCapStatus, getAssistantCapStatus } from './usage-caps.js'

function stubDb({
  orgId = 'org-1',
  aiCap = 5000,
  assistantCap = 2000,
  aiSpend = 0,
  assistantSpend = 0,
  assistantRpcError = null,
} = {}) {
  const rpcCalls = []
  const db = {
    from: vi.fn((table) => {
      if (table === 'locations') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: orgId ? { organization_id: orgId } : null }) }),
          }),
        }
      }
      if (table === 'org_settings') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  ai_hard_cap_cents: aiCap,
                  email_hard_cap_sends: null,
                  assistant_hard_cap_cents: assistantCap,
                },
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
    rpc: vi.fn(async (fn, args) => {
      rpcCalls.push({ fn, args })
      if (fn === 'org_ai_spend_month_cents') return { data: aiSpend, error: null }
      if (fn === 'org_assistant_spend_month_cents') {
        return assistantRpcError
          ? { data: null, error: assistantRpcError }
          : { data: assistantSpend, error: null }
      }
      return { data: null, error: { message: `unknown fn ${fn}` } }
    }),
  }
  return { db, rpcCalls }
}

describe('getAssistantCapStatus', () => {
  it('is not capped when no assistant cap is set, and never asks for the spend', async () => {
    const { db, rpcCalls } = stubDb({ assistantCap: null })
    const res = await getAssistantCapStatus({ locationId: 'loc-1' }, { db })
    expect(res.capped).toBe(false)
    expect(res.organizationId).toBe('org-1')
    // No cap means the sum is not worth a round trip.
    expect(rpcCalls.map((c) => c.fn)).not.toContain('org_assistant_spend_month_cents')
  })

  it('is not capped below the cap, and capped AT it and above it', async () => {
    for (const [spend, capped] of [[1999, false], [2000, true], [2001, true]]) {
      const { db } = stubDb({ assistantCap: 2000, assistantSpend: spend })
      const res = await getAssistantCapStatus({ locationId: 'loc-1' }, { db })
      expect(res.capped, `spend ${spend}`).toBe(capped)
      expect(res.capCents).toBe(2000)
      expect(res.spendCents).toBe(spend)
    }
  })

  it('asks for the month start on the platform calendar', async () => {
    const { db, rpcCalls } = stubDb({ assistantSpend: 10 })
    await getAssistantCapStatus({ locationId: 'loc-1' }, { db })
    const call = rpcCalls.find((c) => c.fn === 'org_assistant_spend_month_cents')
    expect(call.args.p_org).toBe('org-1')
    expect(call.args.p_month_start).toMatch(/^\d{4}-\d{2}-01$/)
  })

  it('FAILS OPEN when the spend read errors — a broken meter must not refuse a staff member', async () => {
    const { db } = stubDb({ assistantCap: 1, assistantRpcError: { message: 'connection reset' } })
    const res = await getAssistantCapStatus({ locationId: 'loc-1' }, { db })
    expect(res.capped).toBe(false)
  })

  it('FAILS OPEN when the org cannot be resolved', async () => {
    const { db, rpcCalls } = stubDb({ orgId: null, assistantCap: 1 })
    const res = await getAssistantCapStatus({ locationId: 'loc-1' }, { db })
    expect(res.capped).toBe(false)
    expect(rpcCalls).toHaveLength(0)
  })

  it('FAILS OPEN when the whole read throws', async () => {
    const db = { from: () => { throw new Error('boom') }, rpc: vi.fn() }
    const res = await getAssistantCapStatus({ locationId: 'loc-1' }, { db })
    expect(res.capped).toBe(false)
  })
})

describe('the two caps partition the ledger — neither can starve the other', () => {
  it('each status reads its OWN spend function', async () => {
    const { db, rpcCalls } = stubDb({ aiSpend: 1, assistantSpend: 1 })
    await getAiCapStatus({ locationId: 'loc-1' }, { db })
    await getAssistantCapStatus({ locationId: 'loc-1' }, { db })
    const fns = rpcCalls.map((c) => c.fn)
    expect(fns).toContain('org_ai_spend_month_cents')
    expect(fns).toContain('org_assistant_spend_month_cents')
  })

  it('assistant spend at the assistant cap does NOT pause Mia', async () => {
    // Mia's own spend is nil; the assistant has blown its budget.
    const { db } = stubDb({ aiCap: 5000, aiSpend: 0, assistantCap: 100, assistantSpend: 100000 })
    expect((await getAssistantCapStatus({ locationId: 'loc-1' }, { db })).capped).toBe(true)
    expect((await getAiCapStatus({ locationId: 'loc-1' }, { db })).capped).toBe(false)
  })

  it('Mia at her cap does NOT switch the assistant off', async () => {
    const { db } = stubDb({ aiCap: 100, aiSpend: 100000, assistantCap: 5000, assistantSpend: 0 })
    expect((await getAiCapStatus({ locationId: 'loc-1' }, { db })).capped).toBe(true)
    expect((await getAssistantCapStatus({ locationId: 'loc-1' }, { db })).capped).toBe(false)
  })
})
