import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/audience-eligibility', () => ({ buildEligibleAudienceQuery: vi.fn() }))

import { buildEligibleAudienceQuery } from '@/lib/audience-eligibility'
import { PREVIEW_COLUMNS, PREVIEW_MAX_PAGE_SIZE } from '@/lib/audience-preview'
import { emailAudienceSample } from './email-audience-sample.js'

const FILTER = { logic: 'and', filters: [{ field: 'name', op: 'contains', value: 'a' }] }

function queryReturning(result) {
  const calls = []
  const q = {
    order: (...a) => { calls.push(['order', ...a]); return q },
    range: (...a) => { calls.push(['range', ...a]); return Promise.resolve(result) },
  }
  buildEligibleAudienceQuery.mockResolvedValue({ query: q })
  return calls
}

describe('emailAudienceSample', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns first name, masked email and stage, and no phone or id', async () => {
    const calls = queryReturning({
      data: [
        { id: 'c1', name: 'Pat Doe', first_name: 'Pat', last_name: 'Doe', email: 'patrick@example.com', phone: '+353871234567', wa_phone: '353871234567', pipeline_stage_slug: 'lead' },
        { id: 'c2', name: 'Sam Lee', first_name: '', last_name: null, email: 'sam@example.com', phone: null, pipeline_stage_slug: null },
        { id: 'c3', name: '', first_name: null, email: 'zz@example.com', pipeline_stage_slug: 'member' },
      ],
      error: null,
    })
    const rows = await emailAudienceSample('db', { filter: FILTER, locationId: 'loc-1' })
    expect(rows).toEqual([
      { first_name: 'Pat', email: 'pa•••@example.com', stage: 'lead' },
      { first_name: 'Sam', email: 'sa•••@example.com', stage: null },
      { first_name: null, email: 'z•••@example.com', stage: 'member' },
    ])
    expect(JSON.stringify(rows)).not.toMatch(/phone|353|"id"|patrick/)
    expect(buildEligibleAudienceQuery).toHaveBeenCalledWith({
      db: 'db', channel: 'email', filter: FILTER, locationId: 'loc-1', columns: PREVIEW_COLUMNS,
    })
    expect(calls).toEqual([['order', 'id', { ascending: true }], ['range', 0, PREVIEW_MAX_PAGE_SIZE - 1]])
  })

  it('caps the page at 50 even when asked for more', async () => {
    const calls = queryReturning({ data: [], error: null })
    await emailAudienceSample('db', { filter: FILTER, locationId: 'loc-1', limit: 500 })
    expect(calls[1]).toEqual(['range', 0, 49])
  })

  it('throws on a query error rather than returning an empty sample', async () => {
    queryReturning({ data: null, error: { message: 'boom' } })
    await expect(emailAudienceSample('db', { filter: FILTER, locationId: 'loc-1' })).rejects.toThrow(/boom/)
  })
})
