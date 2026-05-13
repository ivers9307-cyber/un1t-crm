// Step handler tests. The bug-prone surface here isn't the
// "happy path send" — those depend on Postmark / WhatsApp /
// Twilio mocks that mostly tell you whether you wired the SDK
// correctly. The bugs that have actually shipped (or could
// silently ship) live in:
//
//   • field whitelists for update_field + branch — escaping these
//     would let a sequence stamp arbitrary contact columns
//   • branch step pointer logic — wrong then/else step_order
//     would silently route every contact down the wrong arm
//   • branch loop guard — a target ≤ branch's own step_order
//     would create an infinite loop in the runner
//   • webhook url scheme guard — accidentally sending contact PII
//     over plain HTTP because someone typed http:// in the config
//
// Tests focus on those validation surfaces. Send-step send
// mechanics are out of scope for this slice.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark', () => ({
  sendTransactionalEmail: vi.fn(),
  applyMergeTags: vi.fn((s) => s),
}))
vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage: vi.fn(),
  buildTemplateComponents: vi.fn(),
  getOrCreateConversation: vi.fn(),
}))
vi.mock('@/lib/twilio', () => ({
  sendLocationSms: vi.fn(),
  TwilioError: class TwilioError extends Error {
    constructor(m, opts = {}) { super(m); Object.assign(this, opts) }
  },
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('./triggers.js', () => ({ triggerSequencesForPipelineStageChange: vi.fn() }))

// GLOFOX4.3 — movePipelineStageStep dynamically imports the deal /
// stage helpers from glofox-sync. Mock them at the module level so
// each test can configure the open-deal lookup + stage resolution.
const mockGetOpenDeal = vi.fn()
const mockFindStageId = vi.fn()
vi.mock('../glofox-sync.js', () => ({
  getOpenDealWithStage: (...args) => mockGetOpenDeal(...args),
  findStageIdBySlug: (...args) => mockFindStageId(...args),
}))

const steps = await import('./steps.js')
const { triggerSequencesForPipelineStageChange } = await import('./triggers.js')

beforeEach(() => {
  triggerSequencesForPipelineStageChange.mockReset()
})

// Helper: chainable Supabase mock with configurable returns.
function mockDb(tables = {}) {
  return {
    from: vi.fn((table) => {
      const t = tables[table] || {}
      const cfg = Array.isArray(t) ? t.shift() : t
      const builder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
        insert: vi.fn().mockResolvedValue({ error: null }),
        single: vi.fn().mockResolvedValue({ data: cfg.single ?? null, error: null }),
        then: (onF) => Promise.resolve({ data: cfg.list ?? [], error: cfg.error ?? null }).then(onF),
      }
      return builder
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }
}

// ── update_field ────────────────────────────────────────────────

describe('updateFieldStep — whitelist + cascade', () => {
  const db = { from: vi.fn(() => ({ update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({}) })) })) }

  it('throws when field is not on the whitelist (security guard)', async () => {
    await expect(steps.updateFieldStep(db, {
      step: { config: { field: 'email_status', value: 'unsubscribed' } },
      contact: { id: 'c1', email_status: 'active' },
    })).rejects.toThrow(/not allowed/)
  })

  it('throws when field is empty / unset', async () => {
    await expect(steps.updateFieldStep(db, {
      step: { config: {} },
      contact: { id: 'c1' },
    })).rejects.toThrow(/not allowed/)
  })

  it('throws when value is not a string and not null', async () => {
    await expect(steps.updateFieldStep(db, {
      step: { config: { field: 'label', value: 42 } },
      contact: { id: 'c1', label: 'VIP' },
    })).rejects.toThrow(/must be a string or null/)
  })

  it('no-ops when newValue === oldValue', async () => {
    const update = vi.fn()
    const noopDb = { from: vi.fn(() => ({ update })) }
    await steps.updateFieldStep(noopDb, {
      step: { config: { field: 'label', value: 'VIP' } },
      contact: { id: 'c1', label: 'VIP' },
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('writes the new value when valid + different', async () => {
    const eqSpy = vi.fn().mockResolvedValue({})
    const updateSpy = vi.fn(() => ({ eq: eqSpy }))
    const writeDb = { from: vi.fn(() => ({ update: updateSpy })) }
    await steps.updateFieldStep(writeDb, {
      step: { config: { field: 'label', value: 'VIP' } },
      contact: { id: 'c1', label: null },
    })
    expect(updateSpy).toHaveBeenCalledWith({ label: 'VIP' })
    expect(eqSpy).toHaveBeenCalledWith('id', 'c1')
  })

  // CLASSIFY.2: lead_status is no longer writable — pipeline_stage_slug
  // is denormalised from deals, not stamped by sequence steps.
  it('rejects lead_status (removed from whitelist in CLASSIFY.2)', async () => {
    await expect(steps.updateFieldStep(db, {
      step: { config: { field: 'lead_status', value: 'member' } },
      contact: { id: 'c1' },
    })).rejects.toThrow(/not allowed/)
  })

  it('rejects pipeline_stage_slug (denormalised, not operator-writable)', async () => {
    await expect(steps.updateFieldStep(db, {
      step: { config: { field: 'pipeline_stage_slug', value: 'active_member' } },
      contact: { id: 'c1' },
    })).rejects.toThrow(/not allowed/)
  })
})

// ── apply_tag ───────────────────────────────────────────────────

describe('applyTagStep — validation + idempotency', () => {
  it('throws when config.tag is missing', async () => {
    await expect(steps.applyTagStep(mockDb(), {
      step: { config: {} },
      contact: { id: 'c1' },
    })).rejects.toThrow(/config\.tag is required/)
  })

  it('caps tag length at 60 chars', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null })
    const db = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [] }),
        insert: insertSpy,
      })),
    }
    const longTag = 'x'.repeat(80)
    await steps.applyTagStep(db, {
      step: { config: { tag: longTag } },
      contact: { id: 'c1', location_id: 'loc-1' },
      sequence: null,
    })
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      tag: 'x'.repeat(60),
    }))
  })
})

// ── branch ──────────────────────────────────────────────────────

describe('evaluateBranchPredicate', () => {
  const contact = { id: 'c1', pipeline_stage_slug: 'active_member', label: 'VIP', email_status: 'active', sms_status: 'active', marketing_opt_in: true }

  it('throws when predicate is missing', async () => {
    await expect(steps.evaluateBranchPredicate(mockDb(), { contact, predicate: null }))
      .rejects.toThrow(/predicate is required/)
  })

  it('throws on unknown predicate type', async () => {
    await expect(steps.evaluateBranchPredicate(mockDb(), {
      contact, predicate: { type: 'something_made_up' },
    })).rejects.toThrow(/unknown predicate type/)
  })

  describe('has_tag', () => {
    it('returns true when active tag exists', async () => {
      const db = mockDb({ contact_tags: { list: [{ id: 'tag-1' }] } })
      expect(await steps.evaluateBranchPredicate(db, {
        contact, predicate: { type: 'has_tag', tag: 'vip' },
      })).toBe(true)
    })

    it('returns false when tag is absent', async () => {
      const db = mockDb({ contact_tags: { list: [] } })
      expect(await steps.evaluateBranchPredicate(db, {
        contact, predicate: { type: 'has_tag', tag: 'vip' },
      })).toBe(false)
    })

    it('throws when tag is missing/empty', async () => {
      await expect(steps.evaluateBranchPredicate(mockDb(), {
        contact, predicate: { type: 'has_tag', tag: '' },
      })).rejects.toThrow(/tag is required/)
    })
  })

  describe('field_equals', () => {
    it('throws when field is not whitelisted (security guard)', async () => {
      // 'name' is intentionally NOT in the branch field allowlist.
      await expect(steps.evaluateBranchPredicate(mockDb(), {
        contact, predicate: { type: 'field_equals', field: 'name', value: 'X' },
      })).rejects.toThrow(/not allowed/)
    })

    it('returns true when contact[field] === value', async () => {
      expect(await steps.evaluateBranchPredicate(mockDb(), {
        contact, predicate: { type: 'field_equals', field: 'pipeline_stage_slug', value: 'active_member' },
      })).toBe(true)
    })

    it('returns false on mismatch', async () => {
      expect(await steps.evaluateBranchPredicate(mockDb(), {
        contact, predicate: { type: 'field_equals', field: 'pipeline_stage_slug', value: 'dormant' },
      })).toBe(false)
    })
  })

  describe('field_in', () => {
    it('throws when field is not whitelisted', async () => {
      await expect(steps.evaluateBranchPredicate(mockDb(), {
        contact, predicate: { type: 'field_in', field: 'email', values: ['a@b.com'] },
      })).rejects.toThrow(/not allowed/)
    })

    it('throws when values is empty', async () => {
      await expect(steps.evaluateBranchPredicate(mockDb(), {
        contact, predicate: { type: 'field_in', field: 'pipeline_stage_slug', values: [] },
      })).rejects.toThrow(/non-empty array/)
    })

    it('returns true when contact[field] is in the values', async () => {
      expect(await steps.evaluateBranchPredicate(mockDb(), {
        contact, predicate: { type: 'field_in', field: 'pipeline_stage_slug', values: ['active_member', 'active_trial'] },
      })).toBe(true)
    })

    it('returns false when contact[field] is not in the values', async () => {
      expect(await steps.evaluateBranchPredicate(mockDb(), {
        contact, predicate: { type: 'field_in', field: 'pipeline_stage_slug', values: ['dormant', 'lapsed'] },
      })).toBe(false)
    })
  })
})

describe('processBranchStep — pointer + loop guard', () => {
  const contact = { id: 'c1', pipeline_stage_slug: 'active_member' }

  it('returns then_step_order when predicate matches', async () => {
    const result = await steps.processBranchStep(mockDb(), {
      step: {
        step_order: 3,
        config: {
          predicate: { type: 'field_equals', field: 'pipeline_stage_slug', value: 'active_member' },
          then_step_order: 5,
          else_step_order: 9,
        },
      },
      contact,
    })
    expect(result).toBe(5)
  })

  it('returns else_step_order when predicate does not match', async () => {
    const result = await steps.processBranchStep(mockDb(), {
      step: {
        step_order: 3,
        config: {
          predicate: { type: 'field_equals', field: 'pipeline_stage_slug', value: 'dormant' },
          then_step_order: 5,
          else_step_order: 9,
        },
      },
      contact,
    })
    expect(result).toBe(9)
  })

  it('falls back to step_order + 1 for then when then_step_order is missing', async () => {
    const result = await steps.processBranchStep(mockDb(), {
      step: {
        step_order: 7,
        config: { predicate: { type: 'field_equals', field: 'pipeline_stage_slug', value: 'active_member' } },
      },
      contact,
    })
    expect(result).toBe(8) // 7 + 1
  })

  it('falls back to step_order + 2 for else when else_step_order is missing', async () => {
    const result = await steps.processBranchStep(mockDb(), {
      step: {
        step_order: 7,
        config: { predicate: { type: 'field_equals', field: 'pipeline_stage_slug', value: 'dormant' } },
      },
      contact,
    })
    expect(result).toBe(9) // 7 + 2
  })

  it('throws when target step_order ≤ branch step_order (loop guard)', async () => {
    await expect(steps.processBranchStep(mockDb(), {
      step: {
        step_order: 5,
        config: {
          predicate: { type: 'field_equals', field: 'pipeline_stage_slug', value: 'active_member' },
          then_step_order: 3, // ← jumps backwards
        },
      },
      contact,
    })).rejects.toThrow(/refusing to loop backwards/)
  })

  it('throws when target step_order === branch step_order (also forbidden)', async () => {
    await expect(steps.processBranchStep(mockDb(), {
      step: {
        step_order: 5,
        config: {
          predicate: { type: 'field_equals', field: 'pipeline_stage_slug', value: 'active_member' },
          then_step_order: 5, // ← same step
        },
      },
      contact,
    })).rejects.toThrow(/loop backwards/)
  })
})

// ── webhook ─────────────────────────────────────────────────────

describe('webhookStep — security guards + method whitelist', () => {
  const ctx = {
    step: { step_order: 1, config: {} },
    contact: { id: 'c1' },
    sequence: { id: 's1', name: 'X' },
    enrollment: { id: 'e1' },
  }

  it('throws when url is missing', async () => {
    await expect(steps.webhookStep(null, { ...ctx, step: { config: {} } }))
      .rejects.toThrow(/config\.url is required/)
  })

  it('throws on plain http:// url (PII exfil guard)', async () => {
    await expect(steps.webhookStep(null, {
      ...ctx,
      step: { ...ctx.step, config: { url: 'http://evil.example/hook' } },
    })).rejects.toThrow(/must start with https:\/\//)
  })

  it('throws on unsupported method', async () => {
    await expect(steps.webhookStep(null, {
      ...ctx,
      step: { ...ctx.step, config: { url: 'https://example.com/h', method: 'CONNECT' } },
    })).rejects.toThrow(/method "CONNECT" not supported/)
  })

  it('throws on non-2xx response', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false, status: 500, text: async () => 'oops',
    }))
    await expect(steps.webhookStep(null, {
      ...ctx,
      step: { ...ctx.step, config: { url: 'https://example.com/h' } },
    })).rejects.toThrow(/webhook returned 500/)
  })

  it('succeeds on 2xx', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }))
    await expect(steps.webhookStep(null, {
      ...ctx,
      step: { ...ctx.step, config: { url: 'https://example.com/h' } },
    })).resolves.toBeUndefined()
  })

  it('GET method omits body', async () => {
    let observed
    global.fetch = vi.fn(async (url, init) => {
      observed = init
      return { ok: true, status: 200, text: async () => '' }
    })
    await steps.webhookStep(null, {
      ...ctx,
      step: { ...ctx.step, config: { url: 'https://example.com/h', method: 'GET' } },
    })
    expect(observed.body).toBeUndefined()
  })

  it('uses cfg.payload when provided (overrides default)', async () => {
    let observed
    global.fetch = vi.fn(async (url, init) => {
      observed = init
      return { ok: true, status: 200, text: async () => '' }
    })
    await steps.webhookStep(null, {
      ...ctx,
      step: { ...ctx.step, config: {
        url: 'https://example.com/h',
        payload: { custom: 'shape' },
      } },
    })
    expect(JSON.parse(observed.body)).toEqual({ custom: 'shape' })
  })
})

// ── internal_task ───────────────────────────────────────────────

describe('internalTaskStep — validation', () => {
  it('throws when subject is missing', async () => {
    const db = mockDb()
    await expect(steps.internalTaskStep(db, {
      step: { config: {} },
      contact: { id: 'c1', location_id: 'loc-1' },
      sequence: null,
    })).rejects.toThrow(/subject is required/)
  })

  it('caps subject at 200 chars and note at 4000', async () => {
    const insertSpy = vi.fn().mockResolvedValue({})
    const db = { from: vi.fn(() => ({ insert: insertSpy })) }
    await steps.internalTaskStep(db, {
      step: {
        config: {
          subject: 'x'.repeat(300),
          note: 'y'.repeat(5000),
        },
      },
      contact: { id: 'c1', location_id: 'loc-1' },
      sequence: { id: 's1', location_id: 'loc-1' },
    })
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'x'.repeat(200),
      note: 'y'.repeat(4000),
    }))
  })

  it('uses the sequence location_id when present', async () => {
    const insertSpy = vi.fn().mockResolvedValue({})
    const db = { from: vi.fn(() => ({ insert: insertSpy })) }
    await steps.internalTaskStep(db, {
      step: { config: { subject: 'Call them' } },
      contact: { id: 'c1', location_id: 'loc-CONTACT' },
      sequence: { id: 's1', location_id: 'loc-SEQUENCE' },
    })
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      location_id: 'loc-SEQUENCE',
    }))
  })
})

// ── move_pipeline_stage (GLOFOX4.3) ──────────────────────────────

describe('movePipelineStageStep — guard rails + audit', () => {
  beforeEach(() => {
    mockGetOpenDeal.mockReset()
    mockFindStageId.mockReset()
  })

  it('throws when config.stage_slug is missing (mis-configured sequence)', async () => {
    await expect(steps.movePipelineStageStep(mockDb(), {
      step: { config: {} },
      contact: { id: 'c1', location_id: 'loc1' },
      sequence: { id: 's1', name: 'X', location_id: 'loc1' },
    })).rejects.toThrow(/stage_slug is required/)
  })

  it('throws when the target stage_slug does not resolve to a stage at the location', async () => {
    // Operator typo or stage deleted between draft + activate.
    // We throw so the runner's retry/pause kicks in rather than
    // silently no-op'ing.
    mockGetOpenDeal.mockResolvedValue({ id: 'd1', stage_slug: 'trial_active' })
    mockFindStageId.mockResolvedValue(null)
    await expect(steps.movePipelineStageStep(mockDb(), {
      step: { config: { stage_slug: 'does_not_exist' } },
      contact: { id: 'c1', location_id: 'loc1' },
      sequence: { id: 's1', name: 'Trial → Conversion', location_id: 'loc1' },
    })).rejects.toThrow(/'does_not_exist' not found/)
  })

  it('logs a no-op activity row when contact has no open deal (does not throw)', async () => {
    mockGetOpenDeal.mockResolvedValue(null)
    const insertSpy = vi.fn().mockResolvedValue({})
    const db = { from: vi.fn(() => ({ insert: insertSpy, update: vi.fn() })) }
    await steps.movePipelineStageStep(db, {
      step: { config: { stage_slug: 'conversion_ready' } },
      contact: { id: 'c1', location_id: 'loc1' },
      sequence: { id: 's1', name: 'Trial engaged', location_id: 'loc1' },
    })
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      contact_id: 'c1',
      type: 'pipeline',
      subject: expect.stringMatching(/Pipeline move skipped/),
    }))
  })

  it('logs a no-op activity row when deal is already at the target stage (idempotent)', async () => {
    mockGetOpenDeal.mockResolvedValue({ id: 'd1', stage_slug: 'conversion_ready' })
    const insertSpy = vi.fn().mockResolvedValue({})
    const updateSpy = vi.fn()
    const db = { from: vi.fn(() => ({ insert: insertSpy, update: updateSpy })) }
    await steps.movePipelineStageStep(db, {
      step: { config: { stage_slug: 'conversion_ready' } },
      contact: { id: 'c1', location_id: 'loc1' },
      sequence: { id: 's1', name: 'X', location_id: 'loc1' },
    })
    // No UPDATE on deals — already there.
    expect(updateSpy).not.toHaveBeenCalled()
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringMatching(/already at conversion_ready/),
    }))
  })

  it('moves the deal AND writes an audit activity on a real transition', async () => {
    mockGetOpenDeal.mockResolvedValue({ id: 'd1', stage_slug: 'trial_active' })
    mockFindStageId.mockResolvedValue('stage-uuid-conversion-ready')
    const eqSpy = vi.fn().mockResolvedValue({ error: null })
    const updateSpy = vi.fn(() => ({ eq: eqSpy }))
    const insertSpy = vi.fn().mockResolvedValue({})
    const db = {
      from: vi.fn((table) => {
        if (table === 'deals') return { update: updateSpy }
        return { insert: insertSpy }
      }),
    }
    await steps.movePipelineStageStep(db, {
      step: { config: { stage_slug: 'conversion_ready' } },
      contact: { id: 'c1', location_id: 'loc1' },
      sequence: { id: 's1', name: 'Trial engaged → conversion', location_id: 'loc1' },
    })
    expect(updateSpy).toHaveBeenCalledWith({ stage_id: 'stage-uuid-conversion-ready' })
    expect(eqSpy).toHaveBeenCalledWith('id', 'd1')
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      contact_id: 'c1',
      location_id: 'loc1',
      kind: 'event',
      type: 'pipeline',
      subject: 'Pipeline: trial_active → conversion_ready',
      note: 'Moved by sequence "Trial engaged → conversion".',
    }))
  })

  it('throws when the deal UPDATE returns an error (so the runner can retry/pause)', async () => {
    mockGetOpenDeal.mockResolvedValue({ id: 'd1', stage_slug: 'trial_active' })
    mockFindStageId.mockResolvedValue('stage-uuid')
    const db = {
      from: vi.fn(() => ({
        update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: { message: 'PG conn lost' } }) })),
        insert: vi.fn(),
      })),
    }
    await expect(steps.movePipelineStageStep(db, {
      step: { config: { stage_slug: 'conversion_ready' } },
      contact: { id: 'c1', location_id: 'loc1' },
      sequence: { id: 's1', name: 'X', location_id: 'loc1' },
    })).rejects.toThrow(/PG conn lost/)
  })
})
