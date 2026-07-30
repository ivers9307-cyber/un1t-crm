// enrolContacts integration-shaped tests. The two dedup tiers have
// already been pinned individually (cooldown.test.js does the math
// for tier 2); these tests assert the full function wires the
// pieces together correctly:
//
//   1. empty contactIds short-circuits
//   2. active dedup is consulted before cooldown (cheaper query
//      shape — short-circuits the cooldown read for already-active
//      contacts)
//   3. tier-2 (cooldown) is consulted only for non-active candidates
//   4. final insert excludes both blocked sets
//   5. the parent-counter RPC is fired post-insert
//   6. RPC failures don't propagate (best-effort accounting)

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { enrolContacts } = await import('./enrol.js')

/**
 * Mock Supabase chain. Each table.from() returns a builder where:
 *   - .select(...).eq(...).eq(...).in(...) → resolves to { data: ... }
 *   - .select(...).eq(...).single() → resolves to { data: seqRow }
 *   - .insert([...]) → resolves to { error: ... }
 *
 * We capture the final .insert payload so tests can assert exactly
 * which contacts were enrolled.
 */
function mockDb({
  activeContactIds = [],
  history = [],
  cooldownDays = null,
  insertError = null,
  rpcError = null,
  exemptContactIds = [],
} = {}) {
  const inserts = []
  const rpcCalls = []
  const contactsQueries = []

  function chain(rows) {
    const builder = {
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { re_enrolment_cooldown_days: cooldownDays }, error: null }),
      // The .in(...).in(...) chain on history reads + active reads
      // ends with a `then` (await on the chain). vitest's
      // `.mockResolvedValue` doesn't apply to chains, so we attach a
      // thenable. The selectKind below picks which dataset.
      then: undefined,
    }
    builder.then = (onFulfilled) =>
      Promise.resolve({ data: rows, error: null }).then(onFulfilled)
    return builder
  }

  const db = {
    from: vi.fn((table) => {
      if (table === 'sequence_enrollments') {
        return {
          select: vi.fn((cols) => {
            // active dedup: select('contact_id') ... .eq('status', 'active')
            // history dedup: select('contact_id, status, last_processed_at, created_at') ... .in('status', ['completed', 'exited'])
            if (cols.includes('last_processed_at')) {
              return chain(history)
            }
            return chain(activeContactIds.map(id => ({ contact_id: id })))
          }),
          insert: vi.fn(async (rows) => {
            inserts.push(rows)
            return { error: insertError }
          }),
        }
      }
      if (table === 'email_sequences') {
        return { select: vi.fn(() => chain([{ re_enrolment_cooldown_days: cooldownDays }])) }
      }
      if (table === 'contacts') {
        // automations_exempt gate: select('id').in('id', chunk)
        //   .eq('automations_exempt', true). The mock ignores the
        //   filters and returns every exempt id — fixtures keep the
        //   exempt set a subset of the candidates.
        return {
          select: vi.fn(() => {
            contactsQueries.push(table)
            return chain(exemptContactIds.map(id => ({ id })))
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
    rpc: vi.fn(async (name, args) => {
      rpcCalls.push({ name, args })
      if (rpcError) {
        // The implementation chains .catch() onto the rpc promise to
        // swallow these. Simulate that the rpc returns a rejected
        // promise.
        const p = Promise.reject(rpcError)
        // attach .catch so the implementation can swallow it
        return p
      }
      return { data: null, error: null }
    }),
  }
  return { db, inserts, rpcCalls, contactsQueries }
}

beforeEach(() => {
  createServerClient.mockReset()
})

describe('enrolContacts — short-circuits', () => {
  it('returns { enrolled: 0, skipped: 0 } when contactIds is empty', async () => {
    createServerClient.mockReturnValue({ from: vi.fn() })
    expect(await enrolContacts({ sequenceId: 's1', contactIds: [] }))
      .toEqual({ enrolled: 0, skipped: 0 })
  })

  it('returns { enrolled: 0, skipped: 0 } when contactIds is not an array', async () => {
    createServerClient.mockReturnValue({ from: vi.fn() })
    expect(await enrolContacts({ sequenceId: 's1', contactIds: null }))
      .toEqual({ enrolled: 0, skipped: 0 })
  })
})

describe('enrolContacts — active dedup (tier 1)', () => {
  it('skips contacts already in status=active and inserts the rest', async () => {
    const { db, inserts } = mockDb({ activeContactIds: ['a'] })
    createServerClient.mockReturnValue(db)
    const out = await enrolContacts({ sequenceId: 's1', contactIds: ['a', 'b', 'c'] })
    expect(out.enrolled).toBe(2)
    expect(out.skipped).toBe(1) // a is skipped
    // inserted contacts are b + c
    expect(inserts).toHaveLength(1)
    const inserted = inserts[0].map(r => r.contact_id).sort()
    expect(inserted).toEqual(['b', 'c'])
  })

  it('inserts every row with status=active and current_step_order=0', async () => {
    const { db, inserts } = mockDb()
    createServerClient.mockReturnValue(db)
    await enrolContacts({ sequenceId: 's1', contactIds: ['a'] })
    expect(inserts[0][0]).toMatchObject({
      sequence_id: 's1',
      contact_id: 'a',
      current_step_order: 0,
      status: 'active',
      source_type: 'manual',
      source_ref: null,
    })
    expect(typeof inserts[0][0].next_step_at).toBe('string')
  })

  it('passes through sourceType + sourceRef', async () => {
    const { db, inserts } = mockDb()
    createServerClient.mockReturnValue(db)
    await enrolContacts({
      sequenceId: 's1', contactIds: ['a'],
      sourceType: 'trigger:status_change', sourceRef: 'evt-99',
    })
    expect(inserts[0][0].source_type).toBe('trigger:status_change')
    expect(inserts[0][0].source_ref).toBe('evt-99')
  })
})

describe('enrolContacts — cooldown dedup (tier 2)', () => {
  it('blocks contacts with prior terminal rows when cooldownDays is null', async () => {
    // Legacy regime: ANY past completed/exited row blocks.
    // Quirk preserved from the pre-split implementation:
    // `skipped` only counts the active-dedup tier — cooldown-blocked
    // contacts are missing from the counter when at least one row
    // does get inserted. This is an API quirk callers have lived
    // with; the split must not change it.
    const { db } = mockDb({
      history: [{ contact_id: 'a', status: 'completed', last_processed_at: '2024-01-01', created_at: '2024-01-01' }],
      cooldownDays: null,
    })
    createServerClient.mockReturnValue(db)
    const out = await enrolContacts({ sequenceId: 's1', contactIds: ['a', 'b'] })
    // a is cooldown-blocked, b is enrolled.
    expect(out.enrolled).toBe(1)
    expect(out.skipped).toBe(0) // see quirk note above
  })

  it('allows re-enrolment when cooldown has elapsed', async () => {
    // 100 days ago, cooldown 30 → out of window, allowed.
    const longAgo = new Date(Date.now() - 100 * 86_400_000).toISOString()
    const { db } = mockDb({
      history: [{ contact_id: 'a', status: 'completed', last_processed_at: longAgo, created_at: longAgo }],
      cooldownDays: 30,
    })
    createServerClient.mockReturnValue(db)
    const out = await enrolContacts({ sequenceId: 's1', contactIds: ['a'] })
    expect(out.enrolled).toBe(1)
    expect(out.skipped).toBe(0)
  })

  it('blocks re-enrolment when cooldown has not elapsed', async () => {
    // 5 days ago, cooldown 30 → blocked.
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString()
    const { db } = mockDb({
      history: [{ contact_id: 'a', status: 'completed', last_processed_at: recent, created_at: recent }],
      cooldownDays: 30,
    })
    createServerClient.mockReturnValue(db)
    const out = await enrolContacts({ sequenceId: 's1', contactIds: ['a'] })
    expect(out.enrolled).toBe(0)
    expect(out.skipped).toBe(1)
  })
})

describe('enrolContacts — insert errors', () => {
  it('throws when the final insert returns an error', async () => {
    const { db } = mockDb({ insertError: { message: 'unique violation' } })
    createServerClient.mockReturnValue(db)
    await expect(enrolContacts({ sequenceId: 's1', contactIds: ['a'] }))
      .rejects.toThrow(/Enrol failed: unique violation/)
  })
})

describe('enrolContacts — counter RPC', () => {
  it('fires increment_sequence_enrolled with the insert count', async () => {
    const { db, rpcCalls } = mockDb()
    createServerClient.mockReturnValue(db)
    await enrolContacts({ sequenceId: 's1', contactIds: ['a', 'b', 'c'] })
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]).toEqual({
      name: 'increment_sequence_enrolled',
      args: { p_sequence_id: 's1', p_delta: 3 },
    })
  })

  it('does not throw when the RPC fails (best-effort accounting)', async () => {
    const { db } = mockDb({ rpcError: new Error('rpc not present') })
    createServerClient.mockReturnValue(db)
    // Should resolve normally despite the RPC rejection.
    const out = await enrolContacts({ sequenceId: 's1', contactIds: ['a'] })
    expect(out.enrolled).toBe(1)
  })
})

describe('enrolContacts — automations_exempt gate (HOST-MASTER.3)', () => {
  it('drops automations_exempt contacts for non-manual sourceTypes', async () => {
    const { db, inserts } = mockDb({ exemptContactIds: ['c1'] })
    createServerClient.mockReturnValue(db)
    const out = await enrolContacts({
      sequenceId: 's1', contactIds: ['c1', 'c2'], sourceType: 'tag_added',
    })
    expect(out.enrolled).toBe(1)
    expect(out.skipped).toBe(1) // c1 counted as skipped
    expect(inserts).toHaveLength(1)
    expect(inserts[0].map(r => r.contact_id)).toEqual(['c2'])
  })

  it('returns skipped: contactIds.length when ALL candidates are exempt', async () => {
    const { db, inserts, rpcCalls } = mockDb({ exemptContactIds: ['c1', 'c2'] })
    createServerClient.mockReturnValue(db)
    const out = await enrolContacts({
      sequenceId: 's1', contactIds: ['c1', 'c2'], sourceType: 'booking_created',
    })
    expect(out).toEqual({ enrolled: 0, skipped: 2 })
    expect(inserts).toHaveLength(0)
    expect(rpcCalls).toHaveLength(0)
  })

  it('manual sourceType enrols exempt contacts (and never reads the flag)', async () => {
    const { db, inserts, contactsQueries } = mockDb({ exemptContactIds: ['c1'] })
    createServerClient.mockReturnValue(db)
    const out = await enrolContacts({
      sequenceId: 's1', contactIds: ['c1', 'c2'], sourceType: 'manual',
    })
    expect(out.enrolled).toBe(2)
    expect(inserts[0].map(r => r.contact_id).sort()).toEqual(['c1', 'c2'])
    expect(contactsQueries).toHaveLength(0) // gate bypassed entirely
  })

  it('omitted sourceType (defaults to manual) enrols exempt contacts', async () => {
    const { db, inserts } = mockDb({ exemptContactIds: ['c1'] })
    createServerClient.mockReturnValue(db)
    const out = await enrolContacts({ sequenceId: 's1', contactIds: ['c1', 'c2'] })
    expect(out.enrolled).toBe(2)
    expect(inserts[0].map(r => r.contact_id).sort()).toEqual(['c1', 'c2'])
  })

  it('churn_radar sourceType enrols exempt contacts (operator per-member click)', async () => {
    const { db, inserts, contactsQueries } = mockDb({ exemptContactIds: ['c1'] })
    createServerClient.mockReturnValue(db)
    const out = await enrolContacts({
      sequenceId: 's1', contactIds: ['c1'], sourceType: 'churn_radar',
    })
    expect(out.enrolled).toBe(1)
    expect(inserts[0].map(r => r.contact_id)).toEqual(['c1'])
    expect(contactsQueries).toHaveLength(0)
  })

  it('webhook sourceType respects the flag (inbound automation, not a human click)', async () => {
    const { db, inserts } = mockDb({ exemptContactIds: ['c1'] })
    createServerClient.mockReturnValue(db)
    const out = await enrolContacts({
      sequenceId: 's1', contactIds: ['c1', 'c2'], sourceType: 'webhook',
    })
    expect(out.enrolled).toBe(1)
    expect(inserts[0].map(r => r.contact_id)).toEqual(['c2'])
  })
})

describe('enrolContacts — short-circuit when nothing to insert', () => {
  it('returns skipped: contactIds.length when ALL are already active', async () => {
    const { db, inserts, rpcCalls } = mockDb({ activeContactIds: ['a', 'b'] })
    createServerClient.mockReturnValue(db)
    const out = await enrolContacts({ sequenceId: 's1', contactIds: ['a', 'b'] })
    expect(out).toEqual({ enrolled: 0, skipped: 2 })
    expect(inserts).toHaveLength(0)
    expect(rpcCalls).toHaveLength(0) // no insert → no counter bump
  })
})
