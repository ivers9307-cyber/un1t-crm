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
import { glofoxProvisionStep } from './steps.js'

vi.mock('@/lib/postmark', () => ({
  sendTransactionalEmail: vi.fn(),
  sendMarketingEmail: vi.fn(),
  applyMergeTags: vi.fn((s) => s),
  buildUnsubscribeUrl: vi.fn((contact, baseUrl) => `${baseUrl}/unsubscribe/${contact.id}`),
  appendUnsubscribeFooter: vi.fn((html) => html),
}))
vi.mock('@/lib/app-url', () => ({ getAppUrl: vi.fn(() => 'https://crm.test') }))
vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage: vi.fn(),
  buildTemplateComponents: vi.fn(),
  getOrCreateConversation: vi.fn(),
  renderTemplateBody: vi.fn(() => ''),
}))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T' })),
}))
vi.mock('@/lib/twilio', () => ({
  sendLocationSms: vi.fn(),
  TwilioError: class TwilioError extends Error {
    constructor(m, opts = {}) { super(m); Object.assign(this, opts) }
  },
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('./triggers.js', () => ({ triggerSequencesForPipelineStageChange: vi.fn() }))

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

// ── move_pipeline_stage (RETIRED, FUNNEL.1) ──────────────────────
//
// Stage placement is classifier-derived; the handler must no-op (no
// deals write, ever) AND resolve so a legacy step row advances past
// the step. A throwing handler would wedge the enrolment on the same
// step forever — the SEQ-LOOP-FIX failed-advance incident class.
describe('movePipelineStageStep — retired: no-op + always advance', () => {
  it('never touches deals, logs a retired-step timeline entry, and resolves', async () => {
    const insertSpy = vi.fn().mockResolvedValue({})
    const dealsUpdateSpy = vi.fn()
    const db = {
      from: vi.fn((table) => {
        if (table === 'deals') return { update: dealsUpdateSpy }
        return { insert: insertSpy }
      }),
    }
    await expect(steps.movePipelineStageStep(db, {
      step: { config: { stage_slug: 'conversion_ready' } },
      contact: { id: 'c1', location_id: 'loc1' },
      sequence: { id: 's1', name: 'Trial engaged', location_id: 'loc1' },
    })).resolves.toBeUndefined()
    expect(dealsUpdateSpy).not.toHaveBeenCalled()
    expect(db.from).not.toHaveBeenCalledWith('deals')
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      contact_id: 'c1',
      location_id: 'loc1',
      kind: 'event',
      type: 'pipeline',
      subject: expect.stringMatching(/retired \(FUNNEL\.1\)/),
      note: expect.stringContaining("'conversion_ready'"),
    }))
  })

  it('resolves even with an empty config AND a failing timeline insert (never wedge the runner)', async () => {
    const db = {
      from: vi.fn(() => ({ insert: vi.fn().mockRejectedValue(new Error('activities down')) })),
    }
    await expect(steps.movePipelineStageStep(db, {
      step: { config: {} },
      contact: { id: 'c1', location_id: 'loc1' },
      sequence: null,
    })).resolves.toBeUndefined()
  })
})

// ── glofoxProvisionStep (AUTOMATIONS Phase 1) ────────────────────

describe('glofoxProvisionStep', () => {
  it('calls findOrCreate in create-and-trial mode with source=automation at the sequence location', async () => {
    const calls = []
    const fake = async (args) => { calls.push(args); return { status: 'created' } }
    await glofoxProvisionStep({}, {
      contact: { id: 'c1', location_id: 'loc-from-contact', email: 'a@b.com', first_name: 'A', last_name: 'B' },
      sequence: { id: 's1', location_id: 'loc-1' },
      _findOrCreateGlofoxMember: fake,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      locationId: 'loc-1',
      createIfMissing: true,
      attachTrial: true,
      source: 'automation',
    })
    expect(calls[0].contact.id).toBe('c1')
  })

  it('falls back to the contact location when the sequence has none', async () => {
    const calls = []
    const fake = async (args) => { calls.push(args); return { status: 'linked' } }
    await glofoxProvisionStep({}, {
      contact: { id: 'c1', location_id: 'loc-contact', email: 'a@b.com' },
      sequence: {},
      _findOrCreateGlofoxMember: fake,
    })
    expect(calls[0].locationId).toBe('loc-contact')
  })

  it('does not throw when findOrCreate reports a failed status', async () => {
    const fake = async () => ({ status: 'failed', error: 'missing first_name or last_name' })
    await expect(glofoxProvisionStep({}, {
      contact: { id: 'c2', location_id: 'loc-1', email: 'x@y.com' },
      sequence: { id: 's1', location_id: 'loc-1' },
      _findOrCreateGlofoxMember: fake,
    })).resolves.toBeUndefined()
  })
})

// SEQ-LOOP-FIX (2026-07-02) — send-step handlers must return OUR send-log
// row uuid, never a provider id. sequence_enrollments.last_step_send_id is a
// uuid column; returning Meta's "wamid.…" (or a Twilio "SM…" sid) made the
// runner's cursor-advance update fail with 22P02 — silently — so the claim
// lease expired and the step RE-SENT every ~10 minutes (live double-send).
describe('send-step return ids are row uuids, never provider ids (re-send loop guard)', () => {
  const WA_TEMPLATE = { id: 't1', status: 'APPROVED', location_id: 'loc-1', name: 'book_first_visit', language: 'en', components: [] }

  function sendStepDb({ msgRowResult, activityRowId } = {}) {
    return {
      from: (table) => {
        if (table === 'whatsapp_templates') return { select: () => ({ eq: () => ({ single: async () => ({ data: WA_TEMPLATE }) }) }) }
        if (table === 'whatsapp_messages') return { insert: () => ({ select: () => ({ single: async () => (msgRowResult ?? { data: { id: 'aaaaaaaa-0000-0000-0000-000000000001' } }) }) }) }
        if (table === 'locations') return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'loc-1', name: 'Stillorgan', twilio_alpha_sender_id: 'UN1T' } }) }) }) }
        if (table === 'activities') return { insert: () => ({ select: () => ({ single: async () => ({ data: { id: activityRowId ?? 'bbbbbbbb-0000-0000-0000-000000000002' } }) }) }) }
        throw new Error(`unexpected table ${table}`)
      },
      rpc: async () => ({}),
    }
  }

  it('whatsapp step returns the whatsapp_messages row id, NOT the Meta wamid', async () => {
    const wa = await import('@/lib/whatsapp')
    wa.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.PROVIDER==' })
    wa.buildTemplateComponents.mockReturnValue([])
    wa.getOrCreateConversation.mockResolvedValue('conv-1')
    const out = await steps.sendWhatsappStep(sendStepDb(), {
      step: { id: 'step-1', whatsapp_template_id: 't1', whatsapp_variables: {} },
      sequence: { id: 'seq-1', location_id: 'loc-1' },
      contact: { id: 'c1', wa_phone: '353860000000', whatsapp_marketing: true, wa_status: 'active', contact_location_preferences: [{ location_id: 'loc-1', whatsapp_marketing: true, email_marketing: true, sms_marketing: true }] },
    })
    expect(out).toBe('aaaaaaaa-0000-0000-0000-000000000001')
    expect(String(out)).not.toContain('wamid')
  })

  it('whatsapp step returns null when the message-log insert yields no row (never the wamid)', async () => {
    const wa = await import('@/lib/whatsapp')
    wa.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.PROVIDER==' })
    wa.buildTemplateComponents.mockReturnValue([])
    wa.getOrCreateConversation.mockResolvedValue('conv-1')
    const out = await steps.sendWhatsappStep(sendStepDb({ msgRowResult: { data: null, error: { message: 'insert failed' } } }), {
      step: { id: 'step-1', whatsapp_template_id: 't1', whatsapp_variables: {} },
      sequence: { id: 'seq-1', location_id: 'loc-1' },
      contact: { id: 'c1', wa_phone: '353860000000', whatsapp_marketing: true, wa_status: 'active', contact_location_preferences: [{ location_id: 'loc-1', whatsapp_marketing: true, email_marketing: true, sms_marketing: true }] },
    })
    expect(out).toBeNull()
  })

  it('sms step returns the activities row id, NOT the Twilio SM sid', async () => {
    const tw = await import('@/lib/twilio')
    tw.sendLocationSms.mockResolvedValue({ sid: 'SM_PROVIDER' })
    const out = await steps.sendSmsStep(sendStepDb(), {
      step: { id: 'step-2', sms_body: 'Hi there' },
      sequence: { id: 'seq-1', location_id: 'loc-1', name: 'Nudge' },
      // COMMSFIX.E.1 — the SMS step now gates on the per-location consent row.
      contact: { id: 'c1', phone: '+353860000000', sms_status: 'active', contact_location_preferences: [{ location_id: 'loc-1', sms_marketing: true, email_marketing: true, whatsapp_marketing: true }] },
    })
    expect(out).toBe('bbbbbbbb-0000-0000-0000-000000000002')
    expect(String(out)).not.toContain('SM')
  })
})

// ── COMMS-AUDIT 2026-07-10 (SEQ batch) — WhatsApp step consent gate,
// location routing, and graceful skips ────────────────────────────
//
// Production incident this locks down: 11 of 17 enrollments of the live
// "New Lead – First Class Booking Nudge" sequence were auto-paused because
// a contact with no wa_phone made sendWhatsappStep THROW — error_count hit
// MAX_ERRORS and the enrolment wedged. Per-contact data/consent conditions
// must be recorded SKIPS (resolve null → the scheduler advances the cursor
// exactly once through its normal path), never errors. Sequence-config
// faults (missing/unapproved template) still throw — the operator must fix
// those, and the error path is how they surface.
describe('sendWhatsappStep — send-time consent gate + graceful skips (COMMS-AUDIT)', () => {
  const WA_TEMPLATE = { id: 't1', status: 'APPROVED', location_id: 'loc-1', name: 'book_first_visit', language: 'en', components: [] }
  const step = { id: 'step-1', step_order: 2, whatsapp_template_id: 't1', whatsapp_variables: {} }
  const sequence = { id: 'seq-1', name: 'New Lead – First Class Booking Nudge', location_id: 'loc-1' }
  const consentedContact = {
    id: 'c1', location_id: 'loc-1', wa_phone: '353860000000',
    whatsapp_marketing: true, wa_status: 'active',
    // LOCCOMMS.5 — steps gate on the row for sequence.location_id.
    contact_location_preferences: [{ location_id: 'loc-1', email_marketing: true, sms_marketing: true, whatsapp_marketing: true }],
  }

  function consentDb({ failActivityInsert = false } = {}) {
    const activityInserts = []
    const rpcCalls = []
    return {
      activityInserts,
      rpcCalls,
      from(table) {
        if (table === 'activities') {
          return {
            insert: (row) => {
              if (failActivityInsert) return Promise.reject(new Error('activities down'))
              activityInserts.push(row)
              return Promise.resolve({ error: null })
            },
          }
        }
        if (table === 'whatsapp_templates') return { select: () => ({ eq: () => ({ single: async () => ({ data: WA_TEMPLATE }) }) }) }
        if (table === 'whatsapp_messages') return { insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'aaaaaaaa-0000-0000-0000-000000000001' } }) }) }) }
        // TENANT.8 (item 3b) — sendWhatsappStep now fetches the sequence's
        // location for the bundle gate. `features: {}` = every bundle/key on.
        if (table === 'locations') return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'loc-1', features: {} } }) }) }) }
        throw new Error(`unexpected table ${table}`)
      },
      rpc(name) { rpcCalls.push(name); return Promise.resolve({ data: null, error: null }) },
    }
  }

  let wa
  beforeEach(async () => {
    wa = await import('@/lib/whatsapp')
    wa.sendTemplateMessage.mockReset()
    wa.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.X==' })
    wa.buildTemplateComponents.mockReturnValue([])
    wa.getOrCreateConversation.mockResolvedValue('conv-1')
  })

  it('missing wa_phone → recorded skip (resolves null, nothing sent, no throw)', async () => {
    const db = consentDb()
    const out = await steps.sendWhatsappStep(db, {
      step, sequence, contact: { ...consentedContact, wa_phone: null },
    })
    expect(out).toBeNull()
    expect(wa.sendTemplateMessage).not.toHaveBeenCalled()
    expect(db.activityInserts).toHaveLength(1)
    expect(db.activityInserts[0]).toMatchObject({
      contact_id: 'c1',
      location_id: 'loc-1',
    })
    expect(db.activityInserts[0].subject).toMatch(/skipped/i)
    expect(`${db.activityInserts[0].subject} ${db.activityInserts[0].note}`).toMatch(/whatsapp phone/i)
  })

  it('per-location whatsapp consent not true → recorded skip (mirrors the broadcast gate)', async () => {
    // LOCCOMMS.5 — the gate moved from the denormalised global column to the
    // row for sequence.location_id. Same intent, expressed where consent now
    // actually lives.
    for (const whatsapp_marketing of [false, null, undefined]) {
      const db = consentDb()
      const out = await steps.sendWhatsappStep(db, {
        step, sequence, contact: {
          ...consentedContact,
          contact_location_preferences: [{ location_id: 'loc-1', whatsapp_marketing, email_marketing: true, sms_marketing: true }],
        },
      })
      expect(out).toBeNull()
      expect(db.activityInserts).toHaveLength(1)
    }
    expect(wa.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it.each(['opted_out', 'blocked', 'undeliverable'])(
    'wa_status %s → recorded skip (a mid-sequence STOP must never get another WA step)',
    async (wa_status) => {
      const db = consentDb()
      const out = await steps.sendWhatsappStep(db, {
        step, sequence, contact: { ...consentedContact, wa_status },
      })
      expect(out).toBeNull()
      expect(wa.sendTemplateMessage).not.toHaveBeenCalled()
      expect(db.activityInserts).toHaveLength(1)
      expect(`${db.activityInserts[0].subject} ${db.activityInserts[0].note}`).toContain(wa_status)
    },
  )

  it('a skip does not bump the per-step sent metric', async () => {
    const db = consentDb()
    await steps.sendWhatsappStep(db, {
      step, sequence, contact: { ...consentedContact, wa_phone: null },
    })
    expect(db.rpcCalls).not.toContain('increment_step_sent')
  })

  it('a skip still resolves even when the activities insert fails (never wedge the runner)', async () => {
    const db = consentDb({ failActivityInsert: true })
    await expect(steps.sendWhatsappStep(db, {
      step, sequence, contact: { ...consentedContact, wa_phone: null },
    })).resolves.toBeNull()
  })

  it('consented contact sends, routed from the sequence location (locationId opt → whatsapp_numbers row, not env fallback)', async () => {
    const db = consentDb()
    const out = await steps.sendWhatsappStep(db, { step, sequence, contact: consentedContact })
    expect(out).toBe('aaaaaaaa-0000-0000-0000-000000000001')
    expect(wa.sendTemplateMessage).toHaveBeenCalledWith(
      '353860000000',
      'book_first_visit',
      'en',
      [],
      { locationId: 'loc-1' },
    )
    expect(db.rpcCalls).toContain('increment_step_sent')
  })

  it('a missing template still throws (sequence-config fault → operator must fix; error path is correct)', async () => {
    const db = {
      from: (table) => {
        if (table === 'whatsapp_templates') return { select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }
        if (table === 'locations') return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'loc-1', features: {} } }) }) }) }
        throw new Error(`unexpected table ${table}`)
      },
      rpc: async () => ({}),
    }
    await expect(steps.sendWhatsappStep(db, { step, sequence, contact: consentedContact }))
      .rejects.toThrow(/template not found/)
  })
})

// ── COMMS-AUDIT 2026-07-10 (SEQ batch) — email step: broadcast stream
// + campaign-parity marketing consent gate ────────────────────────
describe('sendEmailStep — marketing consent + broadcast stream (COMMS-AUDIT)', () => {
  const step = { id: 'st-9', step_order: 1, subject: 'Welcome', html_content: '<p>Hi {{first_name}}</p>' }
  const sequence = { id: 'seq-9', name: 'Welcome flow', location_id: 'loc-1' }
  const consentedContact = {
    id: 'c9', location_id: 'loc-1', email: 'a@b.ie',
    email_marketing: true, email_status: 'active',
    // LOCCOMMS.5 — steps gate on the row for sequence.location_id.
    contact_location_preferences: [{ location_id: 'loc-1', email_marketing: true, sms_marketing: true, whatsapp_marketing: true }],
  }

  function emailDb({ failActivityInsert = false } = {}) {
    const activityInserts = []
    const rpcCalls = []
    return {
      activityInserts,
      rpcCalls,
      from(table) {
        if (table === 'activities') {
          return {
            insert: (row) => {
              if (failActivityInsert) return Promise.reject(new Error('activities down'))
              activityInserts.push(row)
              return Promise.resolve({ error: null })
            },
          }
        }
        // COMMSFIX.E.4 — sendEmailStep resolves the location name for the
        // {{location_name}} merge tag (parity with the SMS step).
        if (table === 'locations') return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'loc-1', name: 'Stillorgan' } }) }) }) }
        throw new Error(`unexpected table ${table}`)
      },
      rpc(name) { rpcCalls.push(name); return Promise.resolve({ data: null, error: null }) },
    }
  }

  let pm
  beforeEach(async () => {
    pm = await import('@/lib/postmark')
    pm.sendMarketingEmail.mockReset()
    pm.sendTransactionalEmail.mockReset()
    pm.applyMergeTags.mockClear()
    pm.sendMarketingEmail.mockResolvedValue({ messageId: 'cccccccc-0000-0000-0000-000000000003' })
  })

  it('COMMSFIX.E.4 — passes location_name to the merge for BOTH subject and body (the SMS step already did)', async () => {
    // Six shipped templates sign customer emails 'UN1T {{location_name}}'
    // — without the extra, applyMergeTags substitutes '' and members got
    // 'UN1T ' (trailing space, no studio name).
    const db = emailDb()
    await steps.sendEmailStep(db, { enrollment: { id: 'e9' }, step, sequence, contact: consentedContact })
    expect(pm.applyMergeTags).toHaveBeenCalledWith(
      step.subject, consentedContact,
      expect.objectContaining({ location_name: 'Stillorgan' }),
    )
    expect(pm.applyMergeTags).toHaveBeenCalledWith(
      step.html_content, consentedContact,
      expect.objectContaining({
        location_name: 'Stillorgan',
        unsubscribe_url: expect.stringContaining('/unsubscribe/'),
      }),
    )
  })

  // SEQSENDER.1 (mig 555) — a sequence may name its own sender.
  it('SEQSENDER.1 — sends with no `from` when the sequence names no sender (every pre-existing sequence)', async () => {
    const db = emailDb()
    await steps.sendEmailStep(db, { enrollment: { id: 'e9' }, step, sequence, contact: consentedContact })
    const arg = pm.sendMarketingEmail.mock.calls[0][0]
    expect(arg.from).toBeUndefined()
    expect(arg.replyTo).toBeUndefined()
  })

  it('SEQSENDER.1 — builds "Name <address>" from the sequence and passes reply_to through', async () => {
    const db = emailDb()
    await steps.sendEmailStep(db, {
      enrollment: { id: 'e9' },
      step,
      sequence: { ...sequence, from_name: 'Alex Example', from_email: 'alex@example.test', reply_to: 'alex@example.test' },
      contact: consentedContact,
    })
    expect(pm.sendMarketingEmail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'Alex Example <alex@example.test>',
      replyTo: 'alex@example.test',
    }))
  })

  it('SEQSENDER.1 — a bare from_email with no from_name sends the address alone, not "undefined <addr>"', async () => {
    const db = emailDb()
    await steps.sendEmailStep(db, {
      enrollment: { id: 'e9' },
      step,
      sequence: { ...sequence, from_email: 'alex@example.test' },
      contact: consentedContact,
    })
    expect(pm.sendMarketingEmail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'alex@example.test',
    }))
  })

  it('SEQSENDER.1 — from_name WITHOUT from_email is ignored, never sent as a nameless header', async () => {
    const db = emailDb()
    await steps.sendEmailStep(db, {
      enrollment: { id: 'e9' },
      step,
      sequence: { ...sequence, from_name: 'Alex Example' },
      contact: consentedContact,
    })
    expect(pm.sendMarketingEmail.mock.calls[0][0].from).toBeUndefined()
  })

  it('sends via sendMarketingEmail (broadcast stream), NOT sendTransactionalEmail, with unsubscribe URL + atomic sequence attribution', async () => {
    const db = emailDb()
    const out = await steps.sendEmailStep(db, { enrollment: { id: 'e9' }, step, sequence, contact: consentedContact })
    expect(out).toBe('cccccccc-0000-0000-0000-000000000003')
    expect(pm.sendTransactionalEmail).not.toHaveBeenCalled()
    expect(pm.sendMarketingEmail).toHaveBeenCalledTimes(1)
    expect(pm.sendMarketingEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'a@b.ie',
      locationId: 'loc-1',
      contactId: 'c9',
      unsubscribeUrl: 'https://crm.test/unsubscribe/c9',
      sourceType: 'sequence',
      sequenceId: 'seq-9',
      sequenceStepId: 'st-9',
    }))
    expect(db.rpcCalls).toContain('increment_step_sent')
  })

  it('per-location email consent not true → recorded skip (broadcast and sequence paths must agree)', async () => {
    // LOCCOMMS.5 — see the WhatsApp equivalent above.
    for (const email_marketing of [false, null, undefined]) {
      const db = emailDb()
      const out = await steps.sendEmailStep(db, {
        enrollment: { id: 'e9' }, step, sequence,
        contact: {
          ...consentedContact,
          contact_location_preferences: [{ location_id: 'loc-1', email_marketing, whatsapp_marketing: true, sms_marketing: true }],
        },
      })
      expect(out).toBeNull()
      expect(db.activityInserts).toHaveLength(1)
      expect(db.activityInserts[0].subject).toMatch(/skipped/i)
      expect(db.rpcCalls).not.toContain('increment_step_sent')
    }
    expect(pm.sendMarketingEmail).not.toHaveBeenCalled()
  })

  it.each(['bounced', 'complained'])(
    'email_status %s → recorded skip, not an error (a mid-sequence bounce must not pause the enrolment)',
    async (email_status) => {
      const db = emailDb()
      const out = await steps.sendEmailStep(db, {
        enrollment: { id: 'e9' }, step, sequence,
        contact: { ...consentedContact, email_status },
      })
      expect(out).toBeNull()
      expect(pm.sendMarketingEmail).not.toHaveBeenCalled()
      expect(db.activityInserts).toHaveLength(1)
      expect(`${db.activityInserts[0].subject} ${db.activityInserts[0].note}`).toContain(email_status)
    },
  )

  it('email_status unsubscribed (retired, mig 492) does NOT suppress — the per-location gate above is the consent check', async () => {
    // The value is reputation-only residue; a contact carrying it who holds
    // per-location consent (e.g. re-opted-in at this location) must get the
    // step. Suppressing here recreated the cross-location over-blocking mig
    // 492 removed.
    const db = emailDb()
    const out = await steps.sendEmailStep(db, {
      enrollment: { id: 'e9' }, step, sequence,
      contact: { ...consentedContact, email_status: 'unsubscribed' },
    })
    expect(out).toBe('cccccccc-0000-0000-0000-000000000003')
    expect(pm.sendMarketingEmail).toHaveBeenCalledTimes(1)
  })

  it('email_suppressed_at set (repeat-bounce suppression, NOENGSUP.1) → recorded skip, mirrors the campaign audience gate', async () => {
    const db = emailDb()
    const out = await steps.sendEmailStep(db, {
      enrollment: { id: 'e9' }, step, sequence,
      contact: { ...consentedContact, email_suppressed_at: '2026-07-01T00:00:00.000Z' },
    })
    expect(out).toBeNull()
    expect(pm.sendMarketingEmail).not.toHaveBeenCalled()
    expect(db.activityInserts).toHaveLength(1)
    expect(`${db.activityInserts[0].subject} ${db.activityInserts[0].note}`).toMatch(/repeat bounces/i)
    expect(db.rpcCalls).not.toContain('increment_step_sent')
  })

  it('email_suppressed_at null → sends normally (suppression is the exception, not the rule)', async () => {
    const db = emailDb()
    const out = await steps.sendEmailStep(db, {
      enrollment: { id: 'e9' }, step, sequence,
      contact: { ...consentedContact, email_suppressed_at: null },
    })
    expect(out).toBe('cccccccc-0000-0000-0000-000000000003')
    expect(pm.sendMarketingEmail).toHaveBeenCalledTimes(1)
  })

  it('missing email still throws (unchanged contract)', async () => {
    await expect(steps.sendEmailStep(emailDb(), {
      enrollment: { id: 'e9' }, step, sequence,
      contact: { ...consentedContact, email: null },
    })).rejects.toThrow(/no email address/)
  })

  // UNSUBTOKEN.2 — no contact_preferences row means no unsubscribe_token, and
  // buildUnsubscribeUrl now returns null rather than the old contact.id
  // fallback (which minted a link /api/unsubscribe/[token] could never
  // resolve). A sequence email is MARKETING mail, so it must not go out
  // without a working opt-out. This is a recorded SKIP, not a throw: the
  // 2026-07-10 incident class is that per-contact faults which throw feed
  // error_count and auto-pause the whole enrolment for everyone else on it.
  it('no unsubscribe token → recorded skip, not a marketing email with a dead opt-out link', async () => {
    pm.buildUnsubscribeUrl.mockReturnValueOnce(null)
    const db = emailDb()
    const out = await steps.sendEmailStep(db, { enrollment: { id: 'e9' }, step, sequence, contact: consentedContact })
    expect(out).toBeNull()
    expect(pm.sendMarketingEmail).not.toHaveBeenCalled()
    expect(db.activityInserts).toHaveLength(1)
    expect(`${db.activityInserts[0].subject} ${db.activityInserts[0].note}`).toMatch(/unsubscribe/i)
    expect(db.rpcCalls).not.toContain('increment_step_sent')
  })

  it('the skip does not crash on the preference URL derivation', async () => {
    // The preference URL was built by string-splitting the unsubscribe URL
    // (`url.split('/unsubscribe/')[1]`), so a null URL would TypeError before
    // any gate could run — turning a recoverable skip into an enrolment-
    // pausing error.
    pm.buildUnsubscribeUrl.mockReturnValueOnce(null)
    await expect(steps.sendEmailStep(emailDb(), {
      enrollment: { id: 'e9' }, step, sequence, contact: consentedContact,
    })).resolves.toBeNull()
  })
})

// ── COMMSFIX.E.1 — SMS step: per-location marketing consent + graceful
// skips ───────────────────────────────────────────────────────────
//
// The 2026-08-09 comms audit confirmed sendSmsStep was the ONLY send
// step still bypassing the per-location consent model (it read global
// contacts.sms_status only, never contact_location_preferences.
// sms_marketing) AND still THROWING on per-contact conditions (no
// phone / opted out), feeding error_count until MAX_ERRORS auto-
// paused the whole enrolment — the identical wedge class already
// fixed for email/WA after the live 2026-07-10 incident. These tests
// pin the email/WA contract onto SMS: locationConsent() gate, row
// absent = never send, per-contact conditions are recorded SKIPS.
describe('sendSmsStep — per-location consent gate + graceful skips (COMMSFIX.E.1)', () => {
  const step = { id: 'st-sms', step_order: 3, sms_body: 'Hi {{first_name}}' }
  const sequence = { id: 'seq-sms', name: 'Dunning chase', location_id: 'loc-1' }
  const consentedContact = {
    id: 'c1', location_id: 'loc-1', phone: '+353860000000', sms_status: 'active',
    contact_location_preferences: [{ location_id: 'loc-1', email_marketing: true, sms_marketing: true, whatsapp_marketing: true }],
  }

  function smsDb() {
    const activityInserts = []
    const rpcCalls = []
    return {
      activityInserts,
      rpcCalls,
      from(table) {
        if (table === 'activities') {
          return {
            insert: (row) => {
              activityInserts.push(row)
              // recordStepSkip awaits the bare insert (thenable); the
              // send path chains .select().single() — support both.
              return {
                select: () => ({ single: async () => ({ data: { id: 'dddddddd-0000-0000-0000-000000000004' } }) }),
                then: (onF) => Promise.resolve({ error: null }).then(onF),
              }
            },
          }
        }
        if (table === 'locations') return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'loc-1', name: 'Stillorgan', twilio_alpha_sender_id: 'UN1T' } }) }) }) }
        throw new Error(`unexpected table ${table}`)
      },
      rpc(name) { rpcCalls.push(name); return Promise.resolve({ data: null, error: null }) },
    }
  }

  let tw
  beforeEach(async () => {
    tw = await import('@/lib/twilio')
    tw.sendLocationSms.mockReset()
    tw.sendLocationSms.mockResolvedValue({ sid: 'SM_PROVIDER' })
  })

  it('per-location sms consent not true → recorded skip (no Twilio call, resolves null, no throw)', async () => {
    for (const sms_marketing of [false, null, undefined]) {
      const db = smsDb()
      const out = await steps.sendSmsStep(db, {
        step, sequence, contact: {
          ...consentedContact,
          contact_location_preferences: [{ location_id: 'loc-1', sms_marketing, email_marketing: true, whatsapp_marketing: true }],
        },
      })
      expect(out).toBeNull()
      expect(db.activityInserts).toHaveLength(1)
      expect(db.activityInserts[0].subject).toMatch(/skipped/i)
      expect(`${db.activityInserts[0].subject} ${db.activityInserts[0].note}`).toMatch(/sms marketing/i)
    }
    expect(tw.sendLocationSms).not.toHaveBeenCalled()
  })

  it('no preferences row for the sequence location → recorded skip (row absent = never send)', async () => {
    const db = smsDb()
    const out = await steps.sendSmsStep(db, {
      step, sequence, contact: {
        ...consentedContact,
        contact_location_preferences: [{ location_id: 'loc-other', sms_marketing: true, email_marketing: true, whatsapp_marketing: true }],
      },
    })
    expect(out).toBeNull()
    expect(tw.sendLocationSms).not.toHaveBeenCalled()
    expect(db.activityInserts).toHaveLength(1)
    expect(`${db.activityInserts[0].subject} ${db.activityInserts[0].note}`).toMatch(/list/i)
  })

  it('missing phone → recorded skip, not a throw (no more MAX_ERRORS wedge)', async () => {
    const db = smsDb()
    const out = await steps.sendSmsStep(db, {
      step, sequence, contact: { ...consentedContact, phone: null },
    })
    expect(out).toBeNull()
    expect(tw.sendLocationSms).not.toHaveBeenCalled()
    expect(db.activityInserts).toHaveLength(1)
    expect(`${db.activityInserts[0].subject} ${db.activityInserts[0].note}`).toMatch(/phone/i)
  })

  it.each(['opted_out', 'invalid', 'undeliverable'])(
    'sms_status %s → recorded skip, not a throw',
    async (sms_status) => {
      const db = smsDb()
      const out = await steps.sendSmsStep(db, {
        step, sequence, contact: { ...consentedContact, sms_status },
      })
      expect(out).toBeNull()
      expect(tw.sendLocationSms).not.toHaveBeenCalled()
      expect(db.activityInserts).toHaveLength(1)
      expect(`${db.activityInserts[0].subject} ${db.activityInserts[0].note}`).toContain(sms_status)
    },
  )

  it('a skip does not bump the per-step sent metric', async () => {
    const db = smsDb()
    await steps.sendSmsStep(db, {
      step, sequence, contact: { ...consentedContact, phone: null },
    })
    expect(db.rpcCalls).not.toContain('increment_step_sent')
  })

  it('consented contact with active status sends and returns the activities row id', async () => {
    const db = smsDb()
    const out = await steps.sendSmsStep(db, { step, sequence, contact: consentedContact })
    expect(tw.sendLocationSms).toHaveBeenCalledTimes(1)
    expect(out).toBe('dddddddd-0000-0000-0000-000000000004')
    expect(db.rpcCalls).toContain('increment_step_sent')
  })

  it('absent sms_status still sends (back-compat for pre-mig-059 contacts)', async () => {
    const db = smsDb()
    const { sms_status: _drop, ...noStatus } = consentedContact
    const out = await steps.sendSmsStep(db, { step, sequence, contact: noStatus })
    expect(tw.sendLocationSms).toHaveBeenCalledTimes(1)
    expect(out).toBe('dddddddd-0000-0000-0000-000000000004')
  })

  it('missing sms_body still throws (sequence-config fault → operator must fix)', async () => {
    await expect(steps.sendSmsStep(smsDb(), {
      step: { ...step, sms_body: null }, sequence, contact: consentedContact,
    })).rejects.toThrow(/sms_body/)
  })
})
