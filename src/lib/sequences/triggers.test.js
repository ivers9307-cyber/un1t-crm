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
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('./audience.js', () => ({ contactMatchesSequenceAudience: vi.fn() }))
vi.mock('./enrol.js', () => ({ enrolContacts: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { logWarn, logError } = await import('@/lib/log')
const { contactMatchesSequenceAudience } = await import('./audience.js')
const { enrolContacts } = await import('./enrol.js')
const triggers = await import('./triggers.js')

beforeEach(() => {
  createServerClient.mockReset()
  logWarn.mockReset()
  logError.mockReset()
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

  it('without a locationId reads the HOME studio\'s sequences and never the locations table', async () => {
    const db = mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1', organization_id: 'org-1' } },
      email_sequences: { list: [{ id: 's1', trigger_config: {}, audience_filter: null }] },
    })
    createServerClient.mockReturnValue(db)
    await triggers.triggerSequencesForPipelineStageChange('c1', 'new_lead', 'active_member')
    const seqBuilder = db.from.mock.results[db.from.mock.calls.findIndex(([t]) => t === 'email_sequences')].value
    expect(seqBuilder.eq).toHaveBeenCalledWith('location_id', 'loc-1')
    expect(db.from.mock.calls.map(([t]) => t)).not.toContain('locations')
    expect(enrolContacts).toHaveBeenCalledTimes(1)
  })

  // TDSEQ.1 — a move on a studio's own board (Hatch's un1t.online board) starts
  // THAT studio's sequences, whoever's home the contact is.
  describe('with { locationId } (the board\'s studio)', () => {
    it('enrols a shared contact (home Stillorgan, board Hatch) in Hatch\'s sequence', async () => {
      const db = mockDb({
        contacts: { single: { id: 'c1', location_id: 'stillorgan', organization_id: 'org-1' } },
        locations: { maybeSingle: { id: 'hatch', organization_id: 'org-1' } },
        email_sequences: { list: [
          { id: 'seq-hatch-td', trigger_config: { to_status: 'trial_done' }, audience_filter: null },
          { id: 'seq-hatch-other', trigger_config: { to_status: 'converted' }, audience_filter: null },
        ] },
      })
      createServerClient.mockReturnValue(db)
      await triggers.triggerSequencesForPipelineStageChange('c1', 'second_class', 'trial_done', { locationId: 'hatch' })
      const seqBuilder = db.from.mock.results[db.from.mock.calls.findIndex(([t]) => t === 'email_sequences')].value
      expect(seqBuilder.eq).toHaveBeenCalledWith('location_id', 'hatch')
      expect(seqBuilder.eq).toHaveBeenCalledWith('trigger_type', 'pipeline_stage_change')
      expect(seqBuilder.eq).toHaveBeenCalledWith('status', 'active')
      expect(enrolContacts).toHaveBeenCalledTimes(1)
      expect(enrolContacts).toHaveBeenCalledWith({
        sequenceId: 'seq-hatch-td',
        contactIds: ['c1'],
        sourceType: 'pipeline_stage_change',
        sourceRef: 'second_class→trial_done',
      })
    })

    it('keeps from_status and the audience filter', async () => {
      contactMatchesSequenceAudience.mockResolvedValueOnce(false)
      createServerClient.mockReturnValue(mockDb({
        contacts: { single: { id: 'c1', location_id: 'stillorgan', organization_id: 'org-1' } },
        locations: { maybeSingle: { id: 'hatch', organization_id: 'org-1' } },
        email_sequences: { list: [
          { id: 's-aud', trigger_config: {}, audience_filter: { filters: [{ x: 1 }] } },
          { id: 's-from', trigger_config: { from_status: 'first_class' }, audience_filter: null },
          { id: 's-ok', trigger_config: { from_status: 'second_class', to_status: 'trial_done' }, audience_filter: null },
        ] },
      }))
      await triggers.triggerSequencesForPipelineStageChange('c1', 'second_class', 'trial_done', { locationId: 'hatch' })
      expect(enrolContacts.mock.calls.map(([a]) => a.sequenceId)).toEqual(['s-ok'])
      expect(contactMatchesSequenceAudience).toHaveBeenCalledWith(expect.anything(), 'c1', { filters: [{ x: 1 }] })
    })

    it('refuses a studio in another organisation: no sequence read, nothing enrolled, a warning', async () => {
      const db = mockDb({
        contacts: { single: { id: 'c1', location_id: 'stillorgan', organization_id: 'org-1' } },
        locations: { maybeSingle: { id: 'elsewhere', organization_id: 'org-2' } },
      })
      createServerClient.mockReturnValue(db)
      await triggers.triggerSequencesForPipelineStageChange('c1', 'second_class', 'trial_done', { locationId: 'elsewhere' })
      expect(db.from.mock.calls.map(([t]) => t)).not.toContain('email_sequences')
      expect(enrolContacts).not.toHaveBeenCalled()
      expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_change_skipped', { reason: 'cross_organisation', locationId: 'elsewhere' })
    })

    it('needs no organisation check when the board studio IS the home studio', async () => {
      const db = mockDb({
        contacts: { single: { id: 'c1', location_id: 'hatch', organization_id: 'org-1' } },
        email_sequences: { list: [{ id: 's1', trigger_config: {}, audience_filter: null }] },
      })
      createServerClient.mockReturnValue(db)
      await triggers.triggerSequencesForPipelineStageChange('c1', 'second_class', 'trial_done', { locationId: 'hatch' })
      expect(db.from.mock.calls.map(([t]) => t)).not.toContain('locations')
      expect(enrolContacts).toHaveBeenCalledTimes(1)
    })

    it('never throws if a read fails', async () => {
      createServerClient.mockReturnValue({ from: () => { throw new Error('boom') } })
      await expect(triggers.triggerSequencesForPipelineStageChange('c1', 'a', 'b', { locationId: 'hatch' })).resolves.toBeUndefined()
      expect(logWarn).toHaveBeenCalled()
    })
  })
})

// ── membership_state_change ─────────────────────────────────────

describe('triggerSequencesForMembershipStateChange', () => {
  it('no-ops when oldState === newState', async () => {
    await triggers.triggerSequencesForMembershipStateChange('c1', 'active', 'active')
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('skips a sequence whose trigger_config.to_state does not match newState', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { to_state: 'locked' }, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForMembershipStateChange('c1', 'active', 'paused')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips when from_state does not match oldState', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { from_state: 'paused' }, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForMembershipStateChange('c1', 'active', 'locked')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('enrols when to_state matches (the dunning case: → locked)', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [
        { id: 's1', trigger_config: { to_state: 'locked' }, audience_filter: null },
      ] },
    }))
    await triggers.triggerSequencesForMembershipStateChange('c1', 'active', 'locked')
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sequenceId: 's1',
      contactIds: ['c1'],
      sourceType: 'membership_state_change',
      sourceRef: 'active→locked',
    }))
  })

  it('enrols on any-state-change when trigger_config is empty', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [{ id: 's1', trigger_config: {}, audience_filter: null }] },
    }))
    await triggers.triggerSequencesForMembershipStateChange('c1', 'paused', 'active')
    expect(enrolContacts).toHaveBeenCalledTimes(1)
  })

  it('formats sourceRef with null sentinel for missing oldState', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [{ id: 's1', trigger_config: {}, audience_filter: null }] },
    }))
    await triggers.triggerSequencesForMembershipStateChange('c1', null, 'locked')
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'null→locked',
    }))
  })

  it('skips when contactMatchesSequenceAudience returns false', async () => {
    contactMatchesSequenceAudience.mockResolvedValue(false)
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [{ id: 's1', trigger_config: {}, audience_filter: { filters: [] } }] },
    }))
    await triggers.triggerSequencesForMembershipStateChange('c1', 'active', 'locked')
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

// ── contact_created ─────────────────────────────────────────────

describe('triggerSequencesForContactCreated', () => {
  it('does nothing when no contactId is given', async () => {
    await triggers.triggerSequencesForContactCreated(null)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('enrols the contact into each matching active contact_created sequence', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [{ id: 'seq-1', audience_filter: null }] },
    }))
    await triggers.triggerSequencesForContactCreated('c1')
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 'seq-1',
      contactIds: ['c1'],
      sourceType: 'contact_created',
      sourceRef: 'created',
    })
  })

  it('skips contacts that do not match the sequence audience', async () => {
    contactMatchesSequenceAudience.mockResolvedValue(false)
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [{ id: 'seq-1', audience_filter: { foo: 'bar' } }] },
    }))
    await triggers.triggerSequencesForContactCreated('c1')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('does nothing when the contact is not found', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: null },
    }))
    await triggers.triggerSequencesForContactCreated('missing')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('never throws if the db read fails', async () => {
    createServerClient.mockReturnValue({ from: () => { throw new Error('boom') } })
    await expect(triggers.triggerSequencesForContactCreated('c1')).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalled()
  })

  // SHAREDCONTACT.1 — a contact is one person per organisation; signing up at
  // a sibling studio is "new to that studio".
  it('fires the JOINED studio\'s sequences for a same-organisation contact', async () => {
    const db = mockDb({
      contacts: { single: { id: 'c1', location_id: 'stillorgan', organization_id: 'org-1' } },
      locations: { maybeSingle: { id: 'hatch', organization_id: 'org-1' } },
      email_sequences: { list: [{ id: 'seq-hatch', audience_filter: null }] },
    })
    createServerClient.mockReturnValue(db)
    await triggers.triggerSequencesForContactCreated('c1', { locationId: 'hatch' })
    const seqBuilder = db.from.mock.results[db.from.mock.calls.findIndex(([t]) => t === 'email_sequences')].value
    expect(seqBuilder.eq).toHaveBeenCalledWith('location_id', 'hatch')
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 'seq-hatch',
      contactIds: ['c1'],
      sourceType: 'contact_created',
      sourceRef: 'joined_studio',
    })
  })

  it('refuses a studio in another organisation and enrols nothing', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'stillorgan', organization_id: 'org-1' } },
      locations: { maybeSingle: { id: 'elsewhere', organization_id: 'org-2' } },
    }))
    await triggers.triggerSequencesForContactCreated('c1', { locationId: 'elsewhere' })
    expect(enrolContacts).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('sequences', 'contact_created_skipped', { reason: 'cross_organisation', locationId: 'elsewhere' })
  })

  it('keeps "created" and the home studio when the given studio IS home, and carries a sourceRef', async () => {
    const db = mockDb({
      contacts: { single: { id: 'c1', location_id: 'hatch', organization_id: 'org-1' } },
      email_sequences: { list: [{ id: 'seq-hatch', audience_filter: null }] },
    })
    createServerClient.mockReturnValue(db)
    await triggers.triggerSequencesForContactCreated('c1', { locationId: 'hatch', sourceRef: 'un1t_online_signup' })
    expect(db.from.mock.calls.map(([t]) => t)).not.toContain('locations')
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({ sequenceId: 'seq-hatch', sourceRef: 'un1t_online_signup' }))
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

// ── STAGETRIG.1 — deal-placement wiring ─────────────────────────
//
// triggerSequencesForPipelineStageChange was called from exactly ONE
// place: POST /api/contacts, where the old stage is always null. Every
// real stage MOVE — the Glofox sync/webhook reclassification, the
// operator Cold dismissal, a manual PUT /api/deals/[id] — wrote
// deals.stage_id and let the mig-155 trigger update
// contacts.pipeline_stage_slug without telling the sequence engine.
// So no pipeline_stage_change sequence with a to_status other than the
// creation stage could ever fire, which made the shipped
// `lead_status_member_welcome` template ({ to_status: 'converted' })
// permanently inert.
//
// ensureDealForContact already returns the diff — { action: 'move',
// from_slug, to_slug } — so this adapter is the one place that decides
// when a placement result is a stage change worth firing.
describe('triggerSequencesForDealPlacement (STAGETRIG.1)', () => {
  // HATCHPIPE.1 — the fence. A stage move only enrols when it happened on
  // the primary board at the contact's OWN studio and is the source of the
  // contact's pipeline_stage_slug (mig 736). Two reads of `contacts`: the
  // fence re-read (maybeSingle) and the trigger's own (single).
  const OPTS = { dealLocationId: 'loc-1', pipelineId: 'pl-1' }
  const movedDb = (contactOverrides = {}) => mockDb({
    contacts: {
      maybeSingle: { id: 'c1', location_id: 'loc-1', pipeline_stage_slug: 'converted', ...contactOverrides },
      single: { id: 'c1', location_id: 'loc-1' },
    },
    email_sequences: { list: [
      { id: 's-welcome', trigger_config: { to_status: 'converted' }, audience_filter: null },
    ] },
  })
  const MOVE = { action: 'move', deal_id: 'd1', from_slug: 'active_trial', to_slug: 'converted' }

  it('fires on a real move, with the from/to slugs the placement reported', async () => {
    createServerClient.mockReturnValue(movedDb())
    await triggers.triggerSequencesForDealPlacement('c1', MOVE, OPTS)
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sequenceId: 's-welcome',
      contactIds: ['c1'],
      sourceType: 'pipeline_stage_change',
      sourceRef: 'active_trial→converted',
    }))
    expect(logWarn).not.toHaveBeenCalled()
  })

  // The no-op guard. The classifier is idempotent, so every sync of an
  // unchanged member returns 'leave' — firing on those would enrol the
  // whole membership on every nightly tick.
  it.each([
    ['leave', { action: 'leave', deal_id: 'd1', stage_slug: 'converted' }],
    // A 'create' reads its board first (PIPEBUILD.3e): see createOnLegacyBoardDoesNot.
    ['error', { action: 'error', error: 'stage not found' }],
    ['skipped', { action: 'skipped', reason: 'reclassify skipped (no booking signal)' }],
    ['null', null],
    ['undefined', undefined],
  ])('does not fire for a %s placement result', async (_label, dealResult) => {
    await triggers.triggerSequencesForDealPlacement('c1', dealResult, OPTS)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('does not fire when a move reports the same slug on both sides', async () => {
    await triggers.triggerSequencesForDealPlacement('c1', {
      action: 'move', from_slug: 'converted', to_slug: 'converted',
    }, OPTS)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('does not fire without a contactId', async () => {
    await triggers.triggerSequencesForDealPlacement(null, {
      action: 'move', from_slug: 'a', to_slug: 'b',
    }, OPTS)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  // Same best-effort contract as every other trigger: it is called from
  // sync/webhook/route paths whose primary write has already landed.
  it('never throws — a broken sequence cannot fail the caller', async () => {
    createServerClient.mockImplementation(() => { throw new Error('db down') })
    await expect(triggers.triggerSequencesForDealPlacement('c1', {
      action: 'move', from_slug: 'a', to_slug: 'b',
    }, OPTS)).resolves.toBeUndefined()
  })

  it('goes through the same enrolment guards as any other trigger (audience gate honoured)', async () => {
    contactMatchesSequenceAudience.mockResolvedValue(false)
    createServerClient.mockReturnValue(movedDb())
    await triggers.triggerSequencesForDealPlacement('c1', MOVE, OPTS)
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  describe('HATCHPIPE.1 fence', () => {
    it.each([
      ['no options at all', undefined],
      ['an empty options object', {}],
      ['dealLocationId absent', { pipelineId: 'pl-1' }],
      ['pipelineId absent', { dealLocationId: 'loc-1' }],
    ])('refuses with missing_board when %s', async (_label, opts) => {
      await triggers.triggerSequencesForDealPlacement('c1', MOVE, opts)
      expect(createServerClient).not.toHaveBeenCalled()
      expect(enrolContacts).not.toHaveBeenCalled()
      expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_trigger_skipped', {
        reason: 'missing_board',
        dealLocationId: opts?.dealLocationId,
      })
    })

    it('refuses cross_location when the deal is at another studio than the contact', async () => {
      createServerClient.mockReturnValue(movedDb({ location_id: 'loc-2' }))
      await triggers.triggerSequencesForDealPlacement('c1', MOVE, OPTS)
      expect(enrolContacts).not.toHaveBeenCalled()
      expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_trigger_skipped', {
        reason: 'cross_location',
        dealLocationId: 'loc-1',
      })
    })

    it('refuses not_slug_source when the re-read slug differs from to_slug', async () => {
      createServerClient.mockReturnValue(movedDb({ pipeline_stage_slug: 'lapsed' }))
      await triggers.triggerSequencesForDealPlacement('c1', MOVE, OPTS)
      expect(enrolContacts).not.toHaveBeenCalled()
      expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_trigger_skipped', {
        reason: 'not_slug_source',
        dealLocationId: 'loc-1',
      })
    })

    it('refuses contact_unreadable when the contact cannot be read', async () => {
      createServerClient.mockReturnValue(mockDb({ contacts: { maybeSingle: null } }))
      await triggers.triggerSequencesForDealPlacement('c1', MOVE, OPTS)
      expect(enrolContacts).not.toHaveBeenCalled()
      expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_trigger_skipped', {
        reason: 'contact_unreadable',
        dealLocationId: 'loc-1',
      })
    })

    it('refuses contact_unreadable when the contact read errors', async () => {
      const db = mockDb({ contacts: { maybeSingle: { id: 'c1' } } })
      const from = db.from
      db.from = vi.fn((t) => {
        const b = from(t)
        b.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } })
        return b
      })
      createServerClient.mockReturnValue(db)
      await triggers.triggerSequencesForDealPlacement('c1', MOVE, OPTS)
      expect(enrolContacts).not.toHaveBeenCalled()
      expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_trigger_skipped', {
        reason: 'contact_unreadable',
        dealLocationId: 'loc-1',
      })
    })

    it('own-studio move that is the slug source enrols at that studio', async () => {
      const db = movedDb()
      createServerClient.mockReturnValue(db)
      await triggers.triggerSequencesForDealPlacement('c1', MOVE, OPTS)
      expect(db.from).toHaveBeenCalledWith('contacts')
      const seqBuilder = db.from.mock.results
        .map((r, i) => ({ r: r.value, t: db.from.mock.calls[i][0] }))
        .find((x) => x.t === 'email_sequences').r
      expect(seqBuilder.eq).toHaveBeenCalledWith('location_id', 'loc-1')
      expect(enrolContacts).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['leave', { action: 'leave', stage_slug: 'x' }],
      ['create', { action: 'create', stage_slug: 'x' }],
      ['equal slugs', { action: 'move', from_slug: 'x', to_slug: 'x' }],
    ])('%s still never enrols, fence or no fence', async (_label, dealResult) => {
      createServerClient.mockReturnValue(movedDb())
      await triggers.triggerSequencesForDealPlacement('c1', dealResult, OPTS)
      expect(enrolContacts).not.toHaveBeenCalled()
    })
  })
})

// PIPEBUILD.3e — a placement on a CONFIGURED board (pipelines.board_type set:
// an offer board) fires that board's own stage at the board's studio, as the
// nightly pass does (triggerSequencesForPipelineStageChange with { locationId }).
// A create fires only there; every other board keeps STAGETRIG.1/HATCHPIPE.1.
describe('triggerSequencesForDealPlacement — configured boards (PIPEBUILD.3e)', () => {
  const OPTS = { dealLocationId: 'loc-1', pipelineId: 'pl-corp' }
  const CREATE = { action: 'create', deal_id: 'd1', stage_slug: 'corp_new', pipeline_id: 'pl-corp' }
  const boardDb = ({ board = { id: 'pl-corp', location_id: 'loc-1', board_type: 'offer' }, contact = { id: 'c1', location_id: 'loc-1', pipeline_stage_slug: 'new_lead' }, seqs } = {}) => mockDb({
    pipelines: { maybeSingle: board },
    contacts: { maybeSingle: contact, single: contact },
    email_sequences: { list: seqs ?? [{ id: 's-corp', trigger_config: { to_status: 'corp_new' }, audience_filter: null }] },
  })
  const builderFor = (db, table) => db.from.mock.results
    .map((r, i) => ({ r: r.value, t: db.from.mock.calls[i][0] }))
    .filter((x) => x.t === table).map((x) => x.r)

  it('createOnOfferBoardFires: a first deal on an offer board enrols null → its entry stage at the board\'s studio', async () => {
    const db = boardDb()
    createServerClient.mockReturnValue(db)
    await triggers.triggerSequencesForDealPlacement('c1', CREATE, OPTS)
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sequenceId: 's-corp', contactIds: ['c1'], sourceType: 'pipeline_stage_change', sourceRef: 'null→corp_new',
    }))
    const [board] = builderFor(db, 'pipelines')
    expect(board.eq).toHaveBeenCalledWith('id', 'pl-corp')
    const [seq] = builderFor(db, 'email_sequences')
    expect(seq.eq).toHaveBeenCalledWith('location_id', 'loc-1')
  })

  it('createOnLegacyBoardDoesNot: a first deal on a board without board_type enrols nobody and reads no sequences', async () => {
    const db = boardDb({ board: { id: 'pl-acq', location_id: 'loc-1', board_type: null } })
    createServerClient.mockReturnValue(db)
    await triggers.triggerSequencesForDealPlacement('c1', { ...CREATE, stage_slug: 'new_lead', pipeline_id: 'pl-acq' }, { dealLocationId: 'loc-1', pipelineId: 'pl-acq' })
    expect(enrolContacts).not.toHaveBeenCalled()
    expect(db.from).not.toHaveBeenCalledWith('email_sequences')
    expect(db.from).not.toHaveBeenCalledWith('contacts')
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a create whose board belongs to another studio than the deal enrols nobody', async () => {
    createServerClient.mockReturnValue(boardDb({ board: { id: 'pl-corp', location_id: 'loc-2', board_type: 'offer' } }))
    await triggers.triggerSequencesForDealPlacement('c1', CREATE, OPTS)
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('a create with an unreadable board skips with board_unreadable', async () => {
    createServerClient.mockReturnValue(mockDb({}))
    await triggers.triggerSequencesForDealPlacement('c1', CREATE, OPTS)
    expect(enrolContacts).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_trigger_skipped', { reason: 'board_unreadable', dealLocationId: 'loc-1' })
  })

  it('a create without its board skips with missing_board and reads nothing', async () => {
    await triggers.triggerSequencesForDealPlacement('c1', CREATE, {})
    expect(createServerClient).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_trigger_skipped', { reason: 'missing_board', dealLocationId: undefined })
  })

  it('a move onto an offer board that the slug-source fence would refuse still fires the board\'s stage', async () => {
    // The slug the database holds is not the offer stage (not_slug_source).
    const db = boardDb({ contact: { id: 'c1', location_id: 'loc-1', pipeline_stage_slug: 'new_lead' } })
    createServerClient.mockReturnValue(db)
    await triggers.triggerSequencesForDealPlacement('c1', { action: 'move', from_slug: 'new_lead', to_slug: 'corp_new' }, OPTS)
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({ sourceRef: 'new_lead→corp_new' }))
    const [seq] = builderFor(db, 'email_sequences')
    expect(seq.eq).toHaveBeenCalledWith('location_id', 'loc-1')
  })

  it('a legacy move the fence refuses is still refused with its reason (the board read changes nothing)', async () => {
    createServerClient.mockReturnValue(boardDb({ board: { id: 'pl-1', location_id: 'loc-1', board_type: null }, contact: { id: 'c1', location_id: 'loc-1', pipeline_stage_slug: 'lapsed' } }))
    await triggers.triggerSequencesForDealPlacement('c1', { action: 'move', from_slug: 'active_trial', to_slug: 'converted' }, { dealLocationId: 'loc-1', pipelineId: 'pl-1' })
    expect(enrolContacts).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_trigger_skipped', { reason: 'not_slug_source', dealLocationId: 'loc-1' })
  })

  // PIPEBUILD.3g — the contact's home studio is NOT the board's studio.
  describe('a contact from another studio (home ≠ dealLocationId)', () => {
    const away = { id: 'c1', location_id: 'loc-home', organization_id: 'org-1', pipeline_stage_slug: 'new_lead' }
    const awayDb = ({ board = { id: 'pl-corp', location_id: 'loc-1', board_type: 'offer' }, boardStudioOrg = 'org-1' } = {}) => mockDb({
      pipelines: { maybeSingle: board },
      contacts: { maybeSingle: away, single: away },
      locations: { maybeSingle: { id: 'loc-1', organization_id: boardStudioOrg } },
      email_sequences: { list: [{ id: 's-corp', trigger_config: { to_status: 'corp_new' }, audience_filter: null }] },
    })

    it('same organisation: an offer-board create and move fire at the BOARD\'s studio', async () => {
      for (const result of [CREATE, { action: 'move', from_slug: 'new_lead', to_slug: 'corp_new' }]) {
        enrolContacts.mockClear()
        const db = awayDb()
        createServerClient.mockReturnValue(db)
        await triggers.triggerSequencesForDealPlacement('c1', result, OPTS)
        const [seq] = builderFor(db, 'email_sequences')
        expect(seq.eq).toHaveBeenCalledWith('location_id', 'loc-1')
        expect(seq.eq).not.toHaveBeenCalledWith('location_id', 'loc-home')
        const [loc] = builderFor(db, 'locations')
        expect(loc.eq).toHaveBeenCalledWith('id', 'loc-1')
        expect(enrolContacts).toHaveBeenCalledTimes(1)
        expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({ sequenceId: 's-corp', contactIds: ['c1'] }))
      }
    })

    it('another organisation: refused cross_organisation, no sequence read, nothing enrolled', async () => {
      for (const result of [CREATE, { action: 'move', from_slug: 'new_lead', to_slug: 'corp_new' }]) {
        enrolContacts.mockClear()
        logWarn.mockClear()
        const db = awayDb({ boardStudioOrg: 'org-2' })
        createServerClient.mockReturnValue(db)
        await triggers.triggerSequencesForDealPlacement('c1', result, OPTS)
        expect(db.from).not.toHaveBeenCalledWith('email_sequences')
        expect(enrolContacts).not.toHaveBeenCalled()
        expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_change_skipped', { reason: 'cross_organisation', locationId: 'loc-1' })
      }
    })

    it('a legacy board in the same situation still skips cross_location', async () => {
      const db = awayDb({ board: { id: 'pl-1', location_id: 'loc-1', board_type: null } })
      createServerClient.mockReturnValue(db)
      await triggers.triggerSequencesForDealPlacement('c1', { action: 'move', from_slug: 'active_trial', to_slug: 'converted' }, { dealLocationId: 'loc-1', pipelineId: 'pl-1' })
      expect(enrolContacts).not.toHaveBeenCalled()
      expect(db.from).not.toHaveBeenCalledWith('email_sequences')
      expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_trigger_skipped', { reason: 'cross_location', dealLocationId: 'loc-1' })
    })
  })

  // PIPEBUILD.5m — ensureDealForContact marks a first offer-board placement on
  // a claim older than the board's baseline silent; the adapter starts nothing.
  it('a silent placement (create or move) enrols nobody and reads nothing', async () => {
    const db = boardDb()
    createServerClient.mockReturnValue(db)
    await triggers.triggerSequencesForDealPlacement('c1', { ...CREATE, silent: true, silent_reason: 'claim_before_baseline' }, OPTS)
    await triggers.triggerSequencesForDealPlacement('c1', { action: 'move', from_slug: 'new_lead', to_slug: 'corp_new', silent: true, silent_reason: 'claim_time_unknown' }, { ...OPTS, configuredBoardsOnly: true })
    expect(enrolContacts).not.toHaveBeenCalled()
    expect(db.from).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_trigger_skipped', { reason: 'claim_before_baseline', dealLocationId: 'loc-1' })
    expect(logWarn).toHaveBeenCalledWith('sequences', 'stage_trigger_skipped', { reason: 'claim_time_unknown', dealLocationId: 'loc-1' })
  })

  describe('configuredBoardsOnly (the place-now path)', () => {
    it('a legacy-board move enrols nobody and never reads the contact', async () => {
      const db = boardDb({ board: { id: 'pl-1', location_id: 'loc-1', board_type: null }, contact: { id: 'c1', location_id: 'loc-1', pipeline_stage_slug: 'converted' } })
      createServerClient.mockReturnValue(db)
      await triggers.triggerSequencesForDealPlacement('c1', { action: 'move', from_slug: 'active_trial', to_slug: 'converted' }, { dealLocationId: 'loc-1', pipelineId: 'pl-1', configuredBoardsOnly: true })
      expect(enrolContacts).not.toHaveBeenCalled()
      expect(db.from).not.toHaveBeenCalledWith('contacts')
    })
    it('an offer-board move and create fire', async () => {
      createServerClient.mockReturnValue(boardDb())
      await triggers.triggerSequencesForDealPlacement('c1', { action: 'move', from_slug: 'new_lead', to_slug: 'corp_new' }, { ...OPTS, configuredBoardsOnly: true })
      createServerClient.mockReturnValue(boardDb())
      await triggers.triggerSequencesForDealPlacement('c1', CREATE, { ...OPTS, configuredBoardsOnly: true })
      expect(enrolContacts).toHaveBeenCalledTimes(2)
    })
  })
})

// ── un1t_account_created (UN1TWELCOME.2) ────────────────────────

describe('triggerSequencesForUn1tAccountCreated', () => {
  const args = { contactId: 'c1', locationId: 'loc-1', crmMade: false, un1tUserId: 'u1' }

  it('enrols into each matching active sequence from step 0', async () => {
    const db = mockDb({ email_sequences: { list: [{ id: 'seq-1', audience_filter: null }] } })
    const res = await triggers.triggerSequencesForUn1tAccountCreated(db, args)
    expect(res).toEqual({ ok: true, enrolled: 1 })
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 'seq-1',
      contactIds: ['c1'],
      sourceType: 'un1t_account_created',
      sourceRef: 'u1',
      startStepOrder: 0,
    })
  })

  it('starts at step 1 when the CRM made the account', async () => {
    const db = mockDb({ email_sequences: { list: [{ id: 'seq-1', audience_filter: null }] } })
    await triggers.triggerSequencesForUn1tAccountCreated(db, { ...args, crmMade: true })
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({ startStepOrder: 1 }))
  })

  it('returns enrolled 0 when there are no sequences', async () => {
    const db = mockDb({ email_sequences: { list: [] } })
    expect(await triggers.triggerSequencesForUn1tAccountCreated(db, args)).toEqual({ ok: true, enrolled: 0 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('does not enrol a contact outside the audience', async () => {
    contactMatchesSequenceAudience.mockResolvedValue(false)
    const db = mockDb({ email_sequences: { list: [{ id: 'seq-1', audience_filter: { a: 1 } }] } })
    expect(await triggers.triggerSequencesForUn1tAccountCreated(db, args)).toEqual({ ok: true, enrolled: 0 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('returns ok:false and logs when the sequences read fails', async () => {
    const db = { from: () => {
      const b = { select: () => b, eq: () => b, then: (f) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(f) }
      return b
    } }
    const res = await triggers.triggerSequencesForUn1tAccountCreated(db, args)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('sequences_unreadable')
    expect(JSON.stringify(logError.mock.calls)).not.toMatch(/boom/)
    expect(logError).toHaveBeenCalledWith('sequences', expect.any(String), { locationId: args.locationId, code: null })
  })

  it('returns ok:false when enrolment throws', async () => {
    enrolContacts.mockRejectedValue(new Error('insert failed'))
    const db = mockDb({ email_sequences: { list: [{ id: 'seq-1', audience_filter: null }] } })
    const res = await triggers.triggerSequencesForUn1tAccountCreated(db, args)
    expect(res).toEqual({ ok: false, reason: 'trigger_error' })
    expect(JSON.stringify(logError.mock.calls)).not.toMatch(/insert failed/)
    expect(logError).toHaveBeenCalledWith('sequences', expect.any(String), { contactId: args.contactId, locationId: args.locationId, errName: 'Error' })
  })
})

// ── un1t_paid_trial_purchased (PAIDTRIALTRIGGER.1) ─────────────────
describe('triggerSequencesForUn1tPaidTrialPurchased', () => {
  const args = { contactId: 'c1', locationId: 'loc-1', transactionId: 'tx-1' }

  it('enrols into each matching active €39-purchase sequence from step 0, the purchase as the source', async () => {
    const db = mockDb({ email_sequences: { list: [{ id: 'seq-9', audience_filter: null }] } })
    const res = await triggers.triggerSequencesForUn1tPaidTrialPurchased(db, args)
    expect(res).toEqual({ ok: true, enrolled: 1 })
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 'seq-9',
      contactIds: ['c1'],
      sourceType: 'un1t_paid_trial_purchased',
      sourceRef: 'tx-1',
      startStepOrder: 0,
    })
  })

  it('asks only for this studio\'s active sequences of this trigger type', async () => {
    const db = mockDb({ email_sequences: { list: [] } })
    await triggers.triggerSequencesForUn1tPaidTrialPurchased(db, args)
    const seqBuilder = db.from.mock.results
      .map((r, i) => ({ r: r.value, t: db.from.mock.calls[i][0] }))
      .find((x) => x.t === 'email_sequences').r
    expect(seqBuilder.eq).toHaveBeenCalledWith('location_id', 'loc-1')
    expect(seqBuilder.eq).toHaveBeenCalledWith('trigger_type', 'un1t_paid_trial_purchased')
    expect(seqBuilder.eq).toHaveBeenCalledWith('status', 'active')
  })

  it('respects the audience, and reports a failed read as ok:false without its text', async () => {
    contactMatchesSequenceAudience.mockResolvedValue(false)
    const db = mockDb({ email_sequences: { list: [{ id: 'seq-9', audience_filter: { a: 1 } }] } })
    expect(await triggers.triggerSequencesForUn1tPaidTrialPurchased(db, args)).toEqual({ ok: true, enrolled: 0 })
    expect(enrolContacts).not.toHaveBeenCalled()

    const bad = { from: () => {
      const b = { select: () => b, eq: () => b, then: (f) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(f) }
      return b
    } }
    const res = await triggers.triggerSequencesForUn1tPaidTrialPurchased(bad, args)
    expect(res).toEqual({ ok: false, reason: 'sequences_unreadable' })
    expect(JSON.stringify(logError.mock.calls)).not.toMatch(/boom/)
  })
})

// ── paid_trial_checkout_purchased (STILL39SEQ.1) ────────────────────
describe('triggerSequencesForCheckoutTrialPurchased', () => {
  const args = { contactId: 'c1', locationId: 'loc-st', purchaseId: 'tp-1' }

  it('enrols into each matching active checkout-purchase sequence from step 0, the purchase as the source', async () => {
    const db = mockDb({ email_sequences: { list: [{ id: 'seq-7', audience_filter: null }] } })
    const res = await triggers.triggerSequencesForCheckoutTrialPurchased(db, args)
    expect(res).toEqual({ ok: true, enrolled: 1 })
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 'seq-7',
      contactIds: ['c1'],
      sourceType: 'paid_trial_checkout_purchased',
      sourceRef: 'tp-1',
      startStepOrder: 0,
    })
  })

  it('asks only for this studio\'s active sequences of this trigger type', async () => {
    const db = mockDb({ email_sequences: { list: [] } })
    await triggers.triggerSequencesForCheckoutTrialPurchased(db, args)
    const seqBuilder = db.from.mock.results
      .map((r, i) => ({ r: r.value, t: db.from.mock.calls[i][0] }))
      .find((x) => x.t === 'email_sequences').r
    expect(seqBuilder.eq).toHaveBeenCalledWith('location_id', 'loc-st')
    expect(seqBuilder.eq).toHaveBeenCalledWith('trigger_type', 'paid_trial_checkout_purchased')
    expect(seqBuilder.eq).toHaveBeenCalledWith('status', 'active')
  })
})
