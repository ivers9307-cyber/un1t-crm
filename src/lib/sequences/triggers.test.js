// Webhook trigger handler tests. Each handler shares a common
// shape: load entity → query sequences → filter by trigger_config
// → filter by audience → enrol. The variation that actually
// matters per-trigger is the trigger_config filter logic, so the
// tests are organised around that:
//
//   • booking_created   — event_type_id scoping
//   • status_change     — to_status / from_status scoping
//   • tag_added         — cfg.tag is required + must match
//   • race_registered   — race_event_id scoping + per-member audience
//   • race_finished     — same shape as race_registered
//   • order_status      — triggerType derived from status, source_type filter
//   • first_booking     — count of prior bookings short-circuits
//
// We don't re-test the audience-match path (that has its own
// audience.test.js) or the cooldown / dedup math (cooldown.test.js +
// enrol.test.js). We test that THIS handler's filtering logic
// passes the right contactId(s) into enrolContacts.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all the things triggers.js depends on.
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('./audience.js', () => ({ contactMatchesSequenceAudience: vi.fn() }))
vi.mock('./enrol.js', () => ({ enrolContacts: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { logWarn } = await import('@/lib/log')
const { contactMatchesSequenceAudience } = await import('./audience.js')
const { enrolContacts } = await import('./enrol.js')
const triggers = await import('./triggers.js')

beforeEach(() => {
  createServerClient.mockReset()
  logWarn.mockReset()
  contactMatchesSequenceAudience.mockReset()
  enrolContacts.mockReset()
  // Default: every contact matches the audience filter.
  contactMatchesSequenceAudience.mockResolvedValue(true)
  enrolContacts.mockResolvedValue({ enrolled: 1, skipped: 0 })
})

// Helper: build a chainable Supabase mock where each "table" the
// handler queries returns specific rows. Each table call gets one
// terminator: .single(), .maybeSingle(), or "await the chain".
function mockDb(tables) {
  return {
    from: vi.fn((table) => {
      const t = tables[table]
      if (!t) throw new Error(`unexpected table: ${table}`)
      // Pop a config off a ring of expected calls if the table is an
      // array (sequential reads against the same table use shift()).
      const cfg = Array.isArray(t) ? t.shift() : t

      const builder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: cfg.single ?? null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: cfg.maybeSingle ?? null, error: null }),
        then: (onF) => Promise.resolve({
          data: cfg.list ?? [],
          count: cfg.count ?? 0,
          error: null,
        }).then(onF),
      }
      return builder
    }),
  }
}

// ── booking_created ─────────────────────────────────────────────

describe('triggerSequencesForBooking', () => {
  it('no-ops when the booking has no contact_id', async () => {
    createServerClient.mockReturnValue(mockDb({
      bookings: { single: { id: 'b1', contact_id: null, location_id: 'loc-1' } },
    }))
    await triggers.triggerSequencesForBooking('b1')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('no-ops when the booking does not exist', async () => {
    createServerClient.mockReturnValue(mockDb({
      bookings: { single: null },
    }))
    await triggers.triggerSequencesForBooking('b1')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('no-ops when there are no active sequences for the location', async () => {
    createServerClient.mockReturnValue(mockDb({
      bookings: { single: { id: 'b1', contact_id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [] },
    }))
    await triggers.triggerSequencesForBooking('b1')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips a sequence whose trigger_config.event_type_id does not match', async () => {
    createServerClient.mockReturnValue(mockDb({
      bookings: { single: { id: 'b1', contact_id: 'c1', location_id: 'loc-1', event_type_id: 'evt-A' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { event_type_id: 'evt-B' } },
      ] },
    }))
    await triggers.triggerSequencesForBooking('b1')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('enrols when trigger_config.event_type_id is missing (any-event match)', async () => {
    createServerClient.mockReturnValue(mockDb({
      bookings: { single: { id: 'b1', contact_id: 'c1', location_id: 'loc-1', event_type_id: 'evt-A' } },
      email_sequences: { list: [{ id: 's1', trigger_config: {} }] },
    }))
    await triggers.triggerSequencesForBooking('b1')
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 's1',
      contactIds: ['c1'],
      sourceType: 'booking_created',
      sourceRef: 'b1',
    })
  })

  it('enrols when trigger_config.event_type_id matches', async () => {
    createServerClient.mockReturnValue(mockDb({
      bookings: { single: { id: 'b1', contact_id: 'c1', location_id: 'loc-1', event_type_id: 'evt-A' } },
      email_sequences: { list: [{ id: 's1', trigger_config: { event_type_id: 'evt-A' } }] },
    }))
    await triggers.triggerSequencesForBooking('b1')
    expect(enrolContacts).toHaveBeenCalledTimes(1)
  })

  it('swallows errors and logs (best-effort contract)', async () => {
    // The trigger runs createServerClient() *outside* the try/catch
    // (preserving the original behaviour — moving it inside would be
    // a behavioural change). So we make the throw happen inside the
    // try by failing the first .from() call instead.
    createServerClient.mockReturnValue({
      from: vi.fn(() => { throw new Error('db down') }),
    })
    await expect(triggers.triggerSequencesForBooking('b1')).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalledWith(
      'sequences', expect.stringContaining('booking trigger failed'),
      expect.any(Object)
    )
  })
})

// ── pipeline_stage_change ───────────────────────────────────────

describe('triggerSequencesForPipelineStageChange', () => {
  it('no-ops when oldStage === newStage', async () => {
    await triggers.triggerSequencesForPipelineStageChange('c1', 'active_member', 'active_member')
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('skips a sequence whose trigger_config.to_status does not match newStage', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { to_status: 'active_member' }, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForPipelineStageChange('c1', 'new_lead', 'lapsed')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips when from_status does not match oldStage', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { from_status: 'active_member' }, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForPipelineStageChange('c1', 'new_lead', 'active_trial')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('enrols when both to_status and from_status match', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { from_status: 'new_lead', to_status: 'active_member' }, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForPipelineStageChange('c1', 'new_lead', 'active_member')
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sequenceId: 's1',
      contactIds: ['c1'],
      sourceType: 'pipeline_stage_change',
      sourceRef: 'new_lead→active_member',
    }))
  })

  it('enrols on any-stage-change when trigger_config is empty', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [{ id: 's1', trigger_config: {}, audience_filter: null }] },
    }))
    await triggers.triggerSequencesForPipelineStageChange('c1', 'new_lead', 'active_member')
    expect(enrolContacts).toHaveBeenCalledTimes(1)
  })

  it('formats sourceRef with null sentinel for missing oldStage', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [{ id: 's1', trigger_config: {}, audience_filter: null }] },
    }))
    await triggers.triggerSequencesForPipelineStageChange('c1', null, 'active_member')
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'null→active_member',
    }))
  })

  it('skips when contactMatchesSequenceAudience returns false', async () => {
    contactMatchesSequenceAudience.mockResolvedValue(false)
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [{ id: 's1', trigger_config: {}, audience_filter: { filters: [] } }] },
    }))
    await triggers.triggerSequencesForPipelineStageChange('c1', 'new_lead', 'active_member')
    expect(enrolContacts).not.toHaveBeenCalled()
  })
})

// ── tag_added ───────────────────────────────────────────────────

describe('triggerSequencesForTagsAdded', () => {
  it('no-ops on empty addedTags', async () => {
    await triggers.triggerSequencesForTagsAdded('c1', [])
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('no-ops on non-array addedTags', async () => {
    await triggers.triggerSequencesForTagsAdded('c1', null)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('skips a sequence with no cfg.tag (must NOT fire on any tag)', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [{ id: 's1', trigger_config: {}, audience_filter: null }] },
    }))
    await triggers.triggerSequencesForTagsAdded('c1', ['vip'])
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('enrols only when cfg.tag is present in the addedTags set', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { tag: 'vip' }, audience_filter: null },
        { id: 's2', trigger_config: { tag: 'lapsed' }, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForTagsAdded('c1', ['vip'])
    expect(enrolContacts).toHaveBeenCalledTimes(1)
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sequenceId: 's1',
      sourceRef: 'vip',
    }))
  })
})

// ── order_status ────────────────────────────────────────────────

describe('triggerSequencesForOrderStatus', () => {
  it('no-ops when contactId is missing', async () => {
    await triggers.triggerSequencesForOrderStatus({
      contactId: null, locationId: 'loc-1', status: 'completed', sourceType: 'race_registration',
    })
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('no-ops when status produces an unsupported triggerType', async () => {
    await triggers.triggerSequencesForOrderStatus({
      contactId: 'c1', locationId: 'loc-1', status: 'unknown', sourceType: 'race_registration',
    })
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('derives triggerType as order_<status>', async () => {
    let queriedTriggerType
    createServerClient.mockReturnValue({
      from: vi.fn(() => {
        const builder = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(function (col, val) {
            if (col === 'trigger_type') queriedTriggerType = val
            return this
          }),
          then: (onF) => Promise.resolve({ data: [], error: null }).then(onF),
        }
        return builder
      }),
    })
    await triggers.triggerSequencesForOrderStatus({
      contactId: 'c1', locationId: 'loc-1', status: 'failed', sourceType: 'car_deposit',
    })
    expect(queriedTriggerType).toBe('order_failed')
  })

  it('skips a sequence whose source_type does not match', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', trigger_config: { source_type: 'car_deposit' }, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForOrderStatus({
      contactId: 'c1', locationId: 'loc-1', status: 'completed', sourceType: 'race_registration', orderId: 'o1',
    })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('enrols with the derived triggerType + orderId', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [{ id: 's1', trigger_config: {}, audience_filter: null }] },
    }))
    await triggers.triggerSequencesForOrderStatus({
      contactId: 'c1', locationId: 'loc-1', status: 'completed', sourceType: 'race_registration', orderId: 'o1',
    })
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sequenceId: 's1',
      contactIds: ['c1'],
      sourceType: 'order_completed',
      sourceRef: 'o1',
    }))
  })
})

// ── first_booking ───────────────────────────────────────────────

describe('triggerSequencesForFirstBooking', () => {
  it('no-ops when prior confirmed bookings exist', async () => {
    createServerClient.mockReturnValue(mockDb({
      bookings: [
        { single: { id: 'b1', contact_id: 'c1', location_id: 'loc-1', event_type_id: 'evt-A' } },
        { count: 3 }, // 3 prior bookings → not first
      ],
    }))
    await triggers.triggerSequencesForFirstBooking('b1')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('enrols when this is the first confirmed booking', async () => {
    createServerClient.mockReturnValue(mockDb({
      bookings: [
        { single: { id: 'b1', contact_id: 'c1', location_id: 'loc-1', event_type_id: 'evt-A' } },
        { count: 0 },
      ],
      email_sequences: { list: [{ id: 's1', trigger_config: {}, audience_filter: null }] },
    }))
    await triggers.triggerSequencesForFirstBooking('b1')
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sequenceId: 's1',
      sourceType: 'first_booking',
    }))
  })

  it('respects event_type_id filter on the sequence', async () => {
    createServerClient.mockReturnValue(mockDb({
      bookings: [
        { single: { id: 'b1', contact_id: 'c1', location_id: 'loc-1', event_type_id: 'evt-A' } },
        { count: 0 },
      ],
      email_sequences: { list: [
        { id: 's1', trigger_config: { event_type_id: 'evt-B' }, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForFirstBooking('b1')
    expect(enrolContacts).not.toHaveBeenCalled()
  })
})

// ── segment_added / segment_removed (SEG-TRIG.1) ────────────────

describe('triggerSequencesForSegmentAdded', () => {
  it('no-ops when contactIds is empty', async () => {
    await triggers.triggerSequencesForSegmentAdded('seg-1', [])
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('no-ops when segmentId is missing', async () => {
    await triggers.triggerSequencesForSegmentAdded(null, ['c1'])
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('no-ops when the segment does not exist', async () => {
    createServerClient.mockReturnValue(mockDb({
      contact_segments: { single: null },
    }))
    await triggers.triggerSequencesForSegmentAdded('seg-1', ['c1'])
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips a sequence whose trigger_config.segment_id does not match', async () => {
    createServerClient.mockReturnValue(mockDb({
      contact_segments: { single: { id: 'seg-1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { segment_id: 'seg-OTHER' }, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForSegmentAdded('seg-1', ['c1', 'c2'])
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips a sequence with no segment_id in trigger_config (required field)', async () => {
    createServerClient.mockReturnValue(mockDb({
      contact_segments: { single: { id: 'seg-1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: {}, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForSegmentAdded('seg-1', ['c1'])
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('enrols every matched contact when segment_id matches', async () => {
    createServerClient.mockReturnValue(mockDb({
      contact_segments: { single: { id: 'seg-1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { segment_id: 'seg-1' }, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForSegmentAdded('seg-1', ['c1', 'c2', 'c3'])
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 's1',
      contactIds: ['c1', 'c2', 'c3'],
      sourceType: 'segment_added',
      sourceRef: 'seg-1',
    })
  })

  it('drops contacts that fail the audience filter, enrols the rest', async () => {
    createServerClient.mockReturnValue(mockDb({
      contact_segments: { single: { id: 'seg-1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { segment_id: 'seg-1' }, audience_filter: { logic: 'and', filters: [{ field: 'email_status', op: 'eq', value: 'active' }] } },
      ] },
    }))
    // c1 matches, c2 doesn't, c3 matches.
    contactMatchesSequenceAudience
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    await triggers.triggerSequencesForSegmentAdded('seg-1', ['c1', 'c2', 'c3'])
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 's1',
      contactIds: ['c1', 'c3'],
      sourceType: 'segment_added',
      sourceRef: 'seg-1',
    })
  })

  it('does not enrol if every contact fails the audience filter', async () => {
    createServerClient.mockReturnValue(mockDb({
      contact_segments: { single: { id: 'seg-1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { segment_id: 'seg-1' }, audience_filter: { logic: 'and', filters: [{ field: 'x', op: 'eq', value: 'y' }] } },
      ] },
    }))
    contactMatchesSequenceAudience.mockResolvedValue(false)
    await triggers.triggerSequencesForSegmentAdded('seg-1', ['c1', 'c2'])
    expect(enrolContacts).not.toHaveBeenCalled()
  })
})

describe('triggerSequencesForSegmentRemoved', () => {
  // Removed mirrors Added — only the trigger_type query and the
  // sourceType label differ. One end-to-end happy-path test plus a
  // sourceType-label assertion is enough; the Added describe block
  // covers the shared filter/audience logic.
  it('enrols matched contacts and stamps sourceType="segment_removed"', async () => {
    createServerClient.mockReturnValue(mockDb({
      contact_segments: { single: { id: 'seg-1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { segment_id: 'seg-1' }, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForSegmentRemoved('seg-1', ['c1', 'c2'])
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 's1',
      contactIds: ['c1', 'c2'],
      sourceType: 'segment_removed',
      sourceRef: 'seg-1',
    })
  })

  it('queries email_sequences with trigger_type=segment_removed (not segment_added)', async () => {
    const eqSpy = vi.fn().mockReturnThis()
    createServerClient.mockReturnValue({
      from: vi.fn((table) => {
        if (table === 'contact_segments') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({ data: { id: 'seg-1', location_id: 'loc-1' }, error: null }),
          }
        }
        if (table === 'email_sequences') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: eqSpy,
            then: (onF) => Promise.resolve({ data: [], error: null }).then(onF),
          }
        }
        throw new Error(`unexpected table: ${table}`)
      }),
    })
    await triggers.triggerSequencesForSegmentRemoved('seg-1', ['c1'])
    // Find the eq() call with the trigger_type pair.
    const triggerTypeCall = eqSpy.mock.calls.find(call => call[0] === 'trigger_type')
    expect(triggerTypeCall).toBeDefined()
    expect(triggerTypeCall[1]).toBe('segment_removed')
  })
})
