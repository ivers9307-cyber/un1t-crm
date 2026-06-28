// syncSegmentMemberships diff + dispatch tests.
//
// Focus is on the loop semantics in segment-sync.js:
//   • No-active-triggers → early exit, no segment query
//   • Stable segment (current == stored) → no trigger fired
//   • Additions-only → segment_added fired, segment_removed NOT
//   • Removals-only → segment_removed fired, segment_added NOT
//   • Mixed → both fired with the correct contact_id batches
//
// We don't re-test the trigger handlers themselves (that's
// triggers.test.js) or the audience-filter machinery (its own
// audience-filter.test.js). We test that THIS module computes
// the right diff and dispatches it to the right handler.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the module-graph dependencies. Each mock is referenced by
// the same path the production module uses.
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/audience-filter', () => ({
  applyAudienceFilterAsync: vi.fn(),
  InvalidAudienceFilterError: class extends Error {},
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('./triggers.js', () => ({
  triggerSequencesForSegmentAdded:   vi.fn().mockResolvedValue(undefined),
  triggerSequencesForSegmentRemoved: vi.fn().mockResolvedValue(undefined),
}))

const { createServerClient } = await import('@/lib/supabase')
const { applyAudienceFilterAsync } = await import('@/lib/audience-filter')
const {
  triggerSequencesForSegmentAdded,
  triggerSequencesForSegmentRemoved,
} = await import('./triggers.js')
const { syncSegmentMemberships } = await import('./segment-sync.js')

beforeEach(() => {
  createServerClient.mockReset()
  applyAudienceFilterAsync.mockReset()
  triggerSequencesForSegmentAdded.mockReset()
  triggerSequencesForSegmentRemoved.mockReset()
  triggerSequencesForSegmentAdded.mockResolvedValue(undefined)
  triggerSequencesForSegmentRemoved.mockResolvedValue(undefined)
  // Default: passthrough — the filter doesn't alter the query.
  applyAudienceFilterAsync.mockImplementation(async ({ query }) => ({ query }))
})

// Mock the Supabase client with table-keyed responses. Each table
// can override any of:
//   - triggerRows  → list returned by .from('email_sequences')...
//   - segmentRows  → list returned by .from('contact_segments')...
//   - currentMembers  → contact_ids returned by .from('contacts')...
//   - storedMemberships → contact_ids returned by .from('contact_segment_memberships')...
// upsert + delete are spied so we can assert what was persisted.
function buildDb({ triggerRows = [], segmentRows = [], currentMembers = [], storedMemberships = [] } = {}) {
  const upsertSpy = vi.fn().mockResolvedValue({ data: null, error: null })
  // inSpy tracks deletes — the delete chain ends in .in(contact_id, [...]).
  const inSpy = vi.fn().mockResolvedValue({ data: null, error: null })
  // updateSegmentSpy tracks the first-sync memberships_initialized_at stamp.
  const updateSegmentSpy = vi.fn().mockResolvedValue({ data: null, error: null })

  const db = {
    from: vi.fn((table) => {
      switch (table) {
        case 'email_sequences': {
          const eqSpy = vi.fn().mockReturnThis()
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            eq: eqSpy,
            then: (onF) => Promise.resolve({ data: triggerRows, error: null }).then(onF),
          }
        }
        case 'contact_segments': {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            // First-sync stamps memberships_initialized_at via update().eq().
            update: () => ({ eq: updateSegmentSpy }),
            then: (onF) => Promise.resolve({ data: segmentRows, error: null }).then(onF),
          }
        }
        case 'contacts': {
          // computeSegmentMembers iterates with .range() until a short
          // page. Return all members on the first range call, empty
          // on subsequent calls.
          let called = 0
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            range: vi.fn().mockImplementation(() => {
              const page = called++ === 0
                ? currentMembers.map(id => ({ id }))
                : []
              return Promise.resolve({ data: page, error: null })
            }),
          }
        }
        case 'contact_segment_memberships': {
          // Two read paths (range-paginated SELECT) and two write
          // paths (upsert + delete). Distinguish by which builder
          // method the caller hits next.
          let rangeCalled = 0
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: inSpy,
            range: vi.fn().mockImplementation(() => {
              const page = rangeCalled++ === 0
                ? storedMemberships.map(contact_id => ({ contact_id }))
                : []
              return Promise.resolve({ data: page, error: null })
            }),
            upsert: upsertSpy,
            delete: () => ({
              eq: vi.fn().mockReturnThis(),
              in: inSpy,
            }),
          }
        }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    }),
  }
  return { db, upsertSpy, inSpy, updateSegmentSpy }
}

describe('syncSegmentMemberships', () => {
  it('early-exits when no active segment_* triggers exist', async () => {
    const { db } = buildDb({ triggerRows: [] })
    createServerClient.mockReturnValue(db)

    const stats = await syncSegmentMemberships()

    expect(stats).toEqual({ segments_processed: 0, additions: 0, removals: 0, errors: 0 })
    // Should not have fetched segments at all.
    expect(db.from).toHaveBeenCalledWith('email_sequences')
    expect(db.from).not.toHaveBeenCalledWith('contact_segments')
    expect(triggerSequencesForSegmentAdded).not.toHaveBeenCalled()
    expect(triggerSequencesForSegmentRemoved).not.toHaveBeenCalled()
  })

  it('fires neither trigger for a stable segment (current == stored)', async () => {
    const { db, upsertSpy, inSpy } = buildDb({
      triggerRows: [{ trigger_config: { segment_id: 'seg-1' } }],
      segmentRows: [{ id: 'seg-1', location_id: 'loc-1', filter: null, memberships_initialized_at: '2026-01-01T00:00:00Z' }],
      currentMembers:   ['c1', 'c2', 'c3'],
      storedMemberships: ['c1', 'c2', 'c3'],
    })
    createServerClient.mockReturnValue(db)

    const stats = await syncSegmentMemberships()

    expect(stats).toEqual({ segments_processed: 1, additions: 0, removals: 0, errors: 0 })
    expect(triggerSequencesForSegmentAdded).not.toHaveBeenCalled()
    expect(triggerSequencesForSegmentRemoved).not.toHaveBeenCalled()
    expect(upsertSpy).not.toHaveBeenCalled()
    expect(inSpy).not.toHaveBeenCalled()
  })

  it('fires segment_added when contacts enter the segment', async () => {
    const { db, upsertSpy, inSpy } = buildDb({
      triggerRows: [{ trigger_config: { segment_id: 'seg-1' } }],
      segmentRows: [{ id: 'seg-1', location_id: 'loc-1', filter: null, memberships_initialized_at: '2026-01-01T00:00:00Z' }],
      currentMembers:    ['c1', 'c2', 'c3'],
      storedMemberships: ['c1'],
    })
    createServerClient.mockReturnValue(db)

    const stats = await syncSegmentMemberships()

    expect(stats.additions).toBe(2)
    expect(stats.removals).toBe(0)
    expect(triggerSequencesForSegmentAdded).toHaveBeenCalledTimes(1)
    expect(triggerSequencesForSegmentAdded).toHaveBeenCalledWith('seg-1', expect.arrayContaining(['c2', 'c3']))
    expect(triggerSequencesForSegmentAdded.mock.calls[0][1]).toHaveLength(2)
    expect(triggerSequencesForSegmentRemoved).not.toHaveBeenCalled()
    expect(upsertSpy).toHaveBeenCalledTimes(1) // additions persisted
    expect(inSpy).not.toHaveBeenCalled()       // no deletes
  })

  it('first sync (memberships_initialized_at null) establishes the baseline WITHOUT firing triggers', async () => {
    // The bug: wiring a segment_added sequence to an already-populated
    // segment fired for the WHOLE membership on the first tick. Now the
    // first sync persists the baseline + stamps the marker and suppresses
    // both triggers; only LATER joiners fire.
    const { db, upsertSpy, updateSegmentSpy } = buildDb({
      triggerRows: [{ trigger_config: { segment_id: 'seg-1' } }],
      segmentRows: [{ id: 'seg-1', location_id: 'loc-1', filter: null, memberships_initialized_at: null }],
      currentMembers:    ['c1', 'c2', 'c3'],
      storedMemberships: [], // never synced
    })
    createServerClient.mockReturnValue(db)

    const stats = await syncSegmentMemberships()

    // Baseline IS persisted (so next tick has a snapshot to diff against)…
    expect(upsertSpy).toHaveBeenCalledTimes(1)
    // …and the marker is stamped…
    expect(updateSegmentSpy).toHaveBeenCalledTimes(1)
    // …but NO triggers fire for the pre-existing membership.
    expect(triggerSequencesForSegmentAdded).not.toHaveBeenCalled()
    expect(triggerSequencesForSegmentRemoved).not.toHaveBeenCalled()
    expect(stats.segments_processed).toBe(1)
  })

  it('fires segment_removed when contacts exit the segment', async () => {
    const { db, upsertSpy, inSpy } = buildDb({
      triggerRows: [{ trigger_config: { segment_id: 'seg-1' } }],
      segmentRows: [{ id: 'seg-1', location_id: 'loc-1', filter: null, memberships_initialized_at: '2026-01-01T00:00:00Z' }],
      currentMembers:    ['c1'],
      storedMemberships: ['c1', 'c2', 'c3'],
    })
    createServerClient.mockReturnValue(db)

    const stats = await syncSegmentMemberships()

    expect(stats.additions).toBe(0)
    expect(stats.removals).toBe(2)
    expect(triggerSequencesForSegmentAdded).not.toHaveBeenCalled()
    expect(triggerSequencesForSegmentRemoved).toHaveBeenCalledTimes(1)
    expect(triggerSequencesForSegmentRemoved).toHaveBeenCalledWith('seg-1', expect.arrayContaining(['c2', 'c3']))
    expect(triggerSequencesForSegmentRemoved.mock.calls[0][1]).toHaveLength(2)
    expect(upsertSpy).not.toHaveBeenCalled()   // no inserts
    expect(inSpy).toHaveBeenCalledTimes(1)     // deletes persisted via .in(contact_id, ...)
  })

  it('fires both triggers when membership churns in both directions', async () => {
    const { db, upsertSpy, inSpy } = buildDb({
      triggerRows: [{ trigger_config: { segment_id: 'seg-1' } }],
      segmentRows: [{ id: 'seg-1', location_id: 'loc-1', filter: null, memberships_initialized_at: '2026-01-01T00:00:00Z' }],
      currentMembers:    ['c2', 'c3', 'c4'],
      storedMemberships: ['c1', 'c2', 'c3'],
    })
    createServerClient.mockReturnValue(db)

    const stats = await syncSegmentMemberships()

    expect(stats.additions).toBe(1)
    expect(stats.removals).toBe(1)
    expect(triggerSequencesForSegmentAdded).toHaveBeenCalledWith('seg-1', ['c4'])
    expect(triggerSequencesForSegmentRemoved).toHaveBeenCalledWith('seg-1', ['c1'])
    expect(upsertSpy).toHaveBeenCalledTimes(1)
    expect(inSpy).toHaveBeenCalledTimes(1)
  })

  it('deduplicates segment_ids when two triggers reference the same segment', async () => {
    // A segment can drive both an "added" sequence AND a "removed"
    // sequence — the cron should still process the segment exactly
    // once, not twice. The trigger fanout itself fires both
    // sequences via the segment_id match inside triggers.js.
    const { db } = buildDb({
      triggerRows: [
        { trigger_config: { segment_id: 'seg-1' } },
        { trigger_config: { segment_id: 'seg-1' } },
      ],
      segmentRows: [{ id: 'seg-1', location_id: 'loc-1', filter: null, memberships_initialized_at: '2026-01-01T00:00:00Z' }],
      currentMembers:    ['c1'],
      storedMemberships: ['c1'],
    })
    createServerClient.mockReturnValue(db)

    const stats = await syncSegmentMemberships()

    expect(stats.segments_processed).toBe(1)
  })

  it('ignores trigger rows without a segment_id in trigger_config', async () => {
    // A malformed sequence (no segment_id) shouldn't promote a
    // non-existent segment into the work list.
    const { db } = buildDb({
      triggerRows: [
        { trigger_config: {} },
        { trigger_config: null },
        { trigger_config: { segment_id: '' } },
      ],
      segmentRows: [],
    })
    createServerClient.mockReturnValue(db)

    const stats = await syncSegmentMemberships()

    expect(stats).toEqual({ segments_processed: 0, additions: 0, removals: 0, errors: 0 })
    // segments query never runs when the work list is empty.
    expect(db.from).not.toHaveBeenCalledWith('contact_segments')
  })
})
