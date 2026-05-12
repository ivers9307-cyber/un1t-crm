import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the trigger module before importing contact-tags so the
// helper picks up the spy.
vi.mock('./sequences/triggers.js', () => ({
  triggerSequencesForTagsAdded: vi.fn(async () => {}),
}))

import { writeContactTag, writeContactTags } from './contact-tags.js'
import { triggerSequencesForTagsAdded } from './sequences/triggers.js'

// Fluent fake supabase. Different call shapes for the lookup vs
// insert paths. The helper does:
//   .from('contact_tags').select('id').eq().eq().is().limit()
//   .from('contact_tags').insert(...)
//   .from('contact_tags').select('tag').eq().in().is()  (bulk)
function makeFakeDb({
  existingTags = [],          // single-write lookup result
  existingTagsBulk = [],      // bulk-write lookup result (array of {tag})
  insertResult = { error: null },
  lookupError = null,
} = {}) {
  return {
    from() {
      const c = {}
      c.select = (cols) => {
        c._isBulk = cols === 'tag'
        return c
      }
      c.eq = () => c
      c.in = () => c
      c.is = () => c
      c.limit = () => Promise.resolve({
        data: lookupError ? null : existingTags.map((id) => ({ id })),
        error: lookupError,
      })
      // For bulk lookup which doesn't end with .limit(), make the
      // builder thenable.
      c.then = (resolve) => {
        if (c._isBulk) {
          resolve({ data: lookupError ? null : existingTagsBulk, error: lookupError })
        } else {
          // single-mode: callers always end with .limit() above
          resolve({ data: [], error: null })
        }
      }
      c.insert = () => Promise.resolve(insertResult)
      return c
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('writeContactTag — single', () => {
  it('returns error stub when contactId or tag missing', async () => {
    const out = await writeContactTag(makeFakeDb(), { contactId: null, tag: 't' })
    expect(out.written).toBe(false)
    expect(out.error).toMatch(/missing/)
  })

  it('inserts the tag when no active row exists and fires the sequence trigger', async () => {
    const db = makeFakeDb({ existingTags: [] })
    const out = await writeContactTag(db, {
      contactId: 'c1', locationId: 'loc1', tag: 'glofox_trial_engaged',
    })
    expect(out.written).toBe(true)
    expect(out.alreadyPresent).toBe(false)
    expect(triggerSequencesForTagsAdded).toHaveBeenCalledWith('c1', ['glofox_trial_engaged'])
  })

  it('no-ops when an active row already exists and does NOT fire the trigger', async () => {
    // Idempotency guard — re-enrolling an already-enrolled contact on
    // every sync run would spam the same sequence.
    const db = makeFakeDb({ existingTags: ['existing-row-id'] })
    const out = await writeContactTag(db, {
      contactId: 'c1', locationId: 'loc1', tag: 'glofox_trial_engaged',
    })
    expect(out.written).toBe(false)
    expect(out.alreadyPresent).toBe(true)
    expect(triggerSequencesForTagsAdded).not.toHaveBeenCalled()
  })

  it('returns error when lookup fails (does not insert)', async () => {
    const db = makeFakeDb({ lookupError: { message: 'PG conn lost' } })
    const out = await writeContactTag(db, {
      contactId: 'c1', locationId: 'loc1', tag: 'glofox_trial_engaged',
    })
    expect(out.written).toBe(false)
    expect(out.error).toMatch(/PG conn lost/)
    expect(triggerSequencesForTagsAdded).not.toHaveBeenCalled()
  })

  it('returns error when insert fails (does not fire trigger)', async () => {
    const db = makeFakeDb({
      existingTags: [],
      insertResult: { error: { message: 'FK violation' } },
    })
    const out = await writeContactTag(db, {
      contactId: 'c1', locationId: 'loc1', tag: 'glofox_trial_engaged',
    })
    expect(out.written).toBe(false)
    expect(out.error).toMatch(/FK violation/)
    expect(triggerSequencesForTagsAdded).not.toHaveBeenCalled()
  })
})

describe('writeContactTags — bulk', () => {
  it('returns empty when no tags supplied', async () => {
    const out = await writeContactTags(makeFakeDb(), { contactId: 'c1', tags: [] })
    expect(out.written).toEqual([])
    expect(triggerSequencesForTagsAdded).not.toHaveBeenCalled()
  })

  it('inserts only the tags not already present and fires trigger once with the new ones', async () => {
    // c1 already has 'glofox_trial_engaged'; we add it again plus
    // a new 'glofox_trial_credits_low'. Only the new one should
    // be inserted and triggered.
    const db = makeFakeDb({ existingTagsBulk: [{ tag: 'glofox_trial_engaged' }] })
    const out = await writeContactTags(db, {
      contactId: 'c1',
      locationId: 'loc1',
      tags: ['glofox_trial_engaged', 'glofox_trial_credits_low'],
    })
    expect(out.written).toEqual(['glofox_trial_credits_low'])
    expect(out.alreadyPresent).toEqual(['glofox_trial_engaged'])
    expect(triggerSequencesForTagsAdded).toHaveBeenCalledTimes(1)
    expect(triggerSequencesForTagsAdded).toHaveBeenCalledWith('c1', ['glofox_trial_credits_low'])
  })

  it('no-ops when every requested tag is already present', async () => {
    const db = makeFakeDb({
      existingTagsBulk: [
        { tag: 'glofox_trial_engaged' },
        { tag: 'glofox_trial_credits_low' },
      ],
    })
    const out = await writeContactTags(db, {
      contactId: 'c1',
      locationId: 'loc1',
      tags: ['glofox_trial_engaged', 'glofox_trial_credits_low'],
    })
    expect(out.written).toEqual([])
    expect(triggerSequencesForTagsAdded).not.toHaveBeenCalled()
  })

  it('dedupes duplicate input tags before insert', async () => {
    const db = makeFakeDb({ existingTagsBulk: [] })
    const out = await writeContactTags(db, {
      contactId: 'c1',
      locationId: 'loc1',
      tags: ['glofox_trial_engaged', 'glofox_trial_engaged'],
    })
    expect(out.written).toEqual(['glofox_trial_engaged'])
  })
})
