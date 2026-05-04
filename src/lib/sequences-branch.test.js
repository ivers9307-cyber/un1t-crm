// Tests for the Tier 3E / mig 091 branch step.
//
// evaluateBranchPredicate is a pure-ish function (it only hits the
// DB for has_tag), so we drive it with a minimal Supabase chain
// stub that returns a fixed contact_tags lookup result.
// processBranchStep is the wrapper that picks then/else_step_order;
// we cover its routing + default-pointer + loop-guard behaviour
// here too.

import { describe, it, expect } from 'vitest'
import { evaluateBranchPredicate, processBranchStep } from './sequences.js'

// Tiny PromiseLike stub that mimics PostgREST's chainable builder
// for the has_tag query: from('contact_tags')
//   .select('id').eq(...).eq(...).is(...).limit(1) → { data, error }.
function fakeDbForTags(matchingTagsByContact) {
  return {
    from(table) {
      if (table !== 'contact_tags') throw new Error(`unexpected table: ${table}`)
      const filters = {}
      const builder = {
        select: () => builder,
        eq: (k, v) => { filters[k] = v; return builder },
        is: (k, v) => { filters[`${k}_is`] = v; return builder },
        limit: () => builder,
        // PromiseLike: await it directly.
        then: (resolve) => {
          const tagsForContact = matchingTagsByContact[filters.contact_id] || []
          const match = tagsForContact.includes(filters.tag) ? [{ id: 'fake' }] : []
          resolve({ data: match, error: null })
        },
      }
      return builder
    },
  }
}

describe('evaluateBranchPredicate', () => {
  const contact = {
    id: 'c1',
    lead_status: 'member',
    label: null,
    email_status: 'active',
    sms_status: 'active',
    marketing_opt_in: true,
  }

  it('throws on missing predicate', async () => {
    await expect(
      evaluateBranchPredicate({ from: () => ({}) }, { contact, predicate: null }),
    ).rejects.toThrow(/predicate is required/)
  })

  it('throws on unknown predicate type', async () => {
    await expect(
      evaluateBranchPredicate({ from: () => ({}) }, { contact, predicate: { type: 'mystery' } }),
    ).rejects.toThrow(/unknown predicate type/)
  })

  describe('has_tag', () => {
    it('returns true when contact has the tag', async () => {
      const db = fakeDbForTags({ c1: ['race_completed'] })
      const r = await evaluateBranchPredicate(db, {
        contact,
        predicate: { type: 'has_tag', tag: 'race_completed' },
      })
      expect(r).toBe(true)
    })

    it('returns false when contact does not have the tag', async () => {
      const db = fakeDbForTags({ c1: ['something_else'] })
      const r = await evaluateBranchPredicate(db, {
        contact,
        predicate: { type: 'has_tag', tag: 'race_completed' },
      })
      expect(r).toBe(false)
    })

    it('throws when tag is empty', async () => {
      const db = fakeDbForTags({})
      await expect(
        evaluateBranchPredicate(db, { contact, predicate: { type: 'has_tag', tag: '' } }),
      ).rejects.toThrow(/tag is required/)
    })
  })

  describe('field_equals', () => {
    it('returns true on whitelisted field match', async () => {
      const r = await evaluateBranchPredicate(null, {
        contact,
        predicate: { type: 'field_equals', field: 'lead_status', value: 'member' },
      })
      expect(r).toBe(true)
    })

    it('returns false on whitelisted field mismatch', async () => {
      const r = await evaluateBranchPredicate(null, {
        contact,
        predicate: { type: 'field_equals', field: 'lead_status', value: 'cold' },
      })
      expect(r).toBe(false)
    })

    it('rejects non-whitelisted field', async () => {
      // Try to probe a column that's not in the allow-list. The
      // runner must refuse — operators should never be able to
      // route on arbitrary contact columns.
      await expect(
        evaluateBranchPredicate(null, {
          contact,
          predicate: { type: 'field_equals', field: 'phone', value: '+353871234567' },
        }),
      ).rejects.toThrow(/not allowed/)
    })

    it('handles boolean values (marketing_opt_in)', async () => {
      const r = await evaluateBranchPredicate(null, {
        contact,
        predicate: { type: 'field_equals', field: 'marketing_opt_in', value: true },
      })
      expect(r).toBe(true)
    })
  })

  describe('field_in', () => {
    it('returns true when contact value is in list', async () => {
      const r = await evaluateBranchPredicate(null, {
        contact,
        predicate: { type: 'field_in', field: 'lead_status', values: ['member', 'returning'] },
      })
      expect(r).toBe(true)
    })

    it('returns false when contact value is not in list', async () => {
      const r = await evaluateBranchPredicate(null, {
        contact,
        predicate: { type: 'field_in', field: 'lead_status', values: ['cold', 'lost_member'] },
      })
      expect(r).toBe(false)
    })

    it('rejects empty values list', async () => {
      await expect(
        evaluateBranchPredicate(null, {
          contact,
          predicate: { type: 'field_in', field: 'lead_status', values: [] },
        }),
      ).rejects.toThrow(/non-empty array/)
    })
  })
})

describe('processBranchStep', () => {
  const contact = { id: 'c1', lead_status: 'member' }

  it('returns then_step_order when predicate matches', async () => {
    const step = {
      step_order: 3,
      config: {
        predicate: { type: 'field_equals', field: 'lead_status', value: 'member' },
        then_step_order: 7,
        else_step_order: 9,
      },
    }
    const r = await processBranchStep(null, { step, contact })
    expect(r).toBe(7)
  })

  it('returns else_step_order when predicate does not match', async () => {
    const step = {
      step_order: 3,
      config: {
        predicate: { type: 'field_equals', field: 'lead_status', value: 'cold' },
        then_step_order: 7,
        else_step_order: 9,
      },
    }
    const r = await processBranchStep(null, { step, contact })
    expect(r).toBe(9)
  })

  it('falls back to step_order+1 when then_step_order missing and predicate matches', async () => {
    const step = {
      step_order: 3,
      config: { predicate: { type: 'field_equals', field: 'lead_status', value: 'member' } },
    }
    const r = await processBranchStep(null, { step, contact })
    expect(r).toBe(4)
  })

  it('falls back to step_order+2 when else_step_order missing and predicate fails', async () => {
    const step = {
      step_order: 3,
      config: { predicate: { type: 'field_equals', field: 'lead_status', value: 'cold' } },
    }
    const r = await processBranchStep(null, { step, contact })
    expect(r).toBe(5)
  })

  it('refuses backwards jump', async () => {
    // Branch at step_order=5, then_step_order=2 → loop. Reject.
    const step = {
      step_order: 5,
      config: {
        predicate: { type: 'field_equals', field: 'lead_status', value: 'member' },
        then_step_order: 2,
      },
    }
    await expect(
      processBranchStep(null, { step, contact }),
    ).rejects.toThrow(/refusing to loop backwards/)
  })

  it('refuses jump to own step_order (zero-progress loop)', async () => {
    const step = {
      step_order: 5,
      config: {
        predicate: { type: 'field_equals', field: 'lead_status', value: 'member' },
        then_step_order: 5,
      },
    }
    await expect(
      processBranchStep(null, { step, contact }),
    ).rejects.toThrow(/refusing to loop backwards/)
  })
})
