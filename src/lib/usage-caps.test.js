import { describe, it, expect, vi } from 'vitest'
import { dublinMonthStartStr, getAiCapStatus, getEmailCapStatus } from './usage-caps.js'

function stubDb({ orgId = 'org-1', aiCap = 5000, emailCap = 10000, spend = 0, sends = 0 } = {}) {
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
                data: { ai_hard_cap_cents: aiCap, email_hard_cap_sends: emailCap },
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
    rpc: vi.fn(async (fn, args) => {
      rpcCalls.push({ fn, args })
      if (fn === 'org_ai_spend_month_cents') return { data: spend, error: null }
      if (fn === 'org_email_sends_month') return { data: sends, error: null }
      return { data: null, error: { message: 'unknown fn' } }
    }),
  }
  return { db, rpcCalls }
}

describe('dublinMonthStartStr', () => {
  it('returns the first of the current Dublin month as YYYY-MM-01', () => {
    expect(dublinMonthStartStr('2026-07-19')).toBe('2026-07-01')
    expect(dublinMonthStartStr('2026-01-01')).toBe('2026-01-01')
  })
})

describe('getAiCapStatus', () => {
  it('is not capped while month spend is under the org hard cap', async () => {
    const { db, rpcCalls } = stubDb({ aiCap: 5000, spend: 4999 })
    const status = await getAiCapStatus({ locationId: 'loc-1' }, { db })
    expect(status).toMatchObject({ capped: false, capCents: 5000, spendCents: 4999, organizationId: 'org-1' })
    expect(rpcCalls[0].fn).toBe('org_ai_spend_month_cents')
    expect(rpcCalls[0].args.p_org).toBe('org-1')
    expect(rpcCalls[0].args.p_month_start).toMatch(/^\d{4}-\d{2}-01$/)
  })

  it('caps at or beyond the hard cap', async () => {
    const { db } = stubDb({ aiCap: 5000, spend: 5000 })
    const status = await getAiCapStatus({ locationId: 'loc-1' }, { db })
    expect(status.capped).toBe(true)
  })

  it('no configured cap (null) means never capped — and skips the spend query', async () => {
    const { db, rpcCalls } = stubDb({ aiCap: null })
    const status = await getAiCapStatus({ locationId: 'loc-1' }, { db })
    expect(status).toMatchObject({ capped: false })
    expect(rpcCalls).toHaveLength(0)
  })

  it('accepts a direct organizationId without a locations lookup', async () => {
    const { db } = stubDb({ aiCap: 100, spend: 200 })
    const status = await getAiCapStatus({ organizationId: 'org-1' }, { db })
    expect(status.capped).toBe(true)
    expect(db.from).not.toHaveBeenCalledWith('locations')
  })

  it('fails OPEN on any infrastructure error — a metering failure must never silence Mia', async () => {
    const db = {
      from: () => {
        throw new Error('db down')
      },
      rpc: async () => ({ data: null, error: { message: 'x' } }),
    }
    const status = await getAiCapStatus({ locationId: 'loc-1' }, { db })
    expect(status).toMatchObject({ capped: false })
  })

  it('fails open when the location resolves to no organization', async () => {
    const { db } = stubDb({ orgId: null })
    const status = await getAiCapStatus({ locationId: 'loc-1' }, { db })
    expect(status).toMatchObject({ capped: false })
  })
})

describe('getEmailCapStatus', () => {
  it('caps campaign starts when month sends reach the org email hard cap', async () => {
    const { db } = stubDb({ emailCap: 10000, sends: 10000 })
    const status = await getEmailCapStatus({ locationId: 'loc-1' }, { db })
    expect(status).toMatchObject({ capped: true, capSends: 10000, monthSends: 10000 })
  })

  it('is not capped under the cap, and never capped with no cap configured', async () => {
    const { db: under } = stubDb({ emailCap: 10000, sends: 9999 })
    expect((await getEmailCapStatus({ locationId: 'loc-1' }, { db: under })).capped).toBe(false)
    const { db: none, rpcCalls } = stubDb({ emailCap: null })
    expect((await getEmailCapStatus({ locationId: 'loc-1' }, { db: none })).capped).toBe(false)
    expect(rpcCalls).toHaveLength(0)
  })

  it('fails OPEN on error — a metering failure must never block a campaign', async () => {
    const db = {
      from: () => {
        throw new Error('db down')
      },
      rpc: async () => ({ data: null, error: { message: 'x' } }),
    }
    expect((await getEmailCapStatus({ locationId: 'loc-1' }, { db })).capped).toBe(false)
  })
})
