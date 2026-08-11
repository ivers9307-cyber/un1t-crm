// Tests for the pure helpers in contact-merge.js. The DB-touching
// functions (getContactImpact, mergeContacts) are tested at the
// route level + manual smoke; the field-resolution + tag-union
// logic is the riskiest piece operators will be relying on so it
// gets dedicated unit coverage here.

import { describe, it, expect } from 'vitest'
import { pickMergedFields, mergeTagArrays, redactInBodyForContact, mergeContacts } from './contact-merge.js'

// Minimal fake supabase builder that records .from(table).delete().eq(col, val)
// chains so we can assert the InBody erasure hits the right tables/columns.
function makeFakeDb({ failOn = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const ctx = { table, op: null, eqs: {} }
      const builder = {
        delete() { ctx.op = 'delete'; return builder },
        eq(col, val) {
          ctx.eqs[col] = val
          // Terminal — record + return a thenable-ish result. The real code
          // awaits this; simulate a rejection when asked to test resilience.
          calls.push(ctx)
          if (failOn && failOn === table) return Promise.reject(new Error(`boom:${table}`))
          return Promise.resolve({ error: null })
        },
      }
      return builder
    },
  }
}

describe('pickMergedFields — survivor wins, loser fills empty', () => {
  it('survivor non-empty value wins over loser', () => {
    const r = pickMergedFields(
      { name: 'Alice', email: 'a@x.com' },
      { name: 'Alicia', email: 'b@y.com' },
    )
    expect(r.name).toBe('Alice')
    expect(r.email).toBe('a@x.com')
  })

  it('loser fills survivor empty string', () => {
    const r = pickMergedFields(
      { phone: '' },
      { phone: '+353871234567' },
    )
    expect(r.phone).toBe('+353871234567')
  })

  it('loser fills survivor null', () => {
    const r = pickMergedFields(
      { glofox_member_id: null },
      { glofox_member_id: 'GFX123' },
    )
    expect(r.glofox_member_id).toBe('GFX123')
  })

  it('loser fills survivor missing key', () => {
    const r = pickMergedFields(
      { name: 'Alice' },
      { lead_source: 'website' },
    )
    expect(r.lead_source).toBe('website')
  })

  it('loser fills survivor whitespace-only string', () => {
    const r = pickMergedFields(
      { last_name: '   ' },
      { last_name: 'Smith' },
    )
    expect(r.last_name).toBe('Smith')
  })

  it('both empty leaves the field empty (survivor wins, even when both empty)', () => {
    const r = pickMergedFields(
      { phone: null },
      { phone: '' },
    )
    expect(r.phone).toBe(null)
  })

  it('numeric zero is NOT treated as empty (trial_credits_remaining=0)', () => {
    // Edge case: a contact who's used up their trial credits has 0
    // — that's a meaningful value, not a missing one.
    const r = pickMergedFields(
      { trial_credits_remaining: 0 },
      { trial_credits_remaining: 3 },
    )
    expect(r.trial_credits_remaining).toBe(0)
  })

  it('keeps the OLDER created_at — lead-age math survives merge', () => {
    const r = pickMergedFields(
      { created_at: '2026-05-01T00:00:00Z' },
      { created_at: '2024-01-15T00:00:00Z' },
    )
    expect(r.created_at).toBe('2024-01-15T00:00:00Z')
  })

  it('keeps survivor created_at when loser is newer', () => {
    const r = pickMergedFields(
      { created_at: '2024-01-15T00:00:00Z' },
      { created_at: '2026-05-01T00:00:00Z' },
    )
    // pickMergedFields only writes created_at when loser is older;
    // otherwise it's not in the returned object at all (so the
    // existing survivor value stays untouched on UPDATE).
    expect(r.created_at).toBeUndefined()
  })
})

describe('mergeTagArrays — union, deduped, trims preserved order', () => {
  it('unions both arrays', () => {
    expect(mergeTagArrays(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('survives one or both nulls', () => {
    expect(mergeTagArrays(null, ['a'])).toEqual(['a'])
    expect(mergeTagArrays(['a'], null)).toEqual(['a'])
    expect(mergeTagArrays(null, null)).toEqual([])
  })

  it('trims whitespace and dedupes case-sensitively', () => {
    // Operators sometimes type tags with stray spaces; we trim. But
    // case is intentional ("VIP" ≠ "vip") so we don't lower-case.
    expect(mergeTagArrays(['  vip  ', 'engaged'], ['vip', 'VIP'])).toEqual(['vip', 'engaged', 'VIP'])
  })

  it('drops empty + whitespace-only entries', () => {
    expect(mergeTagArrays(['', '   ', 'real'], ['', null, 'other'])).toEqual(['real', 'other'])
  })

  it('drops non-string entries defensively', () => {
    expect(mergeTagArrays(['a', 5, { foo: 1 }], ['b'])).toEqual(['a', 'b'])
  })

  it('preserves survivor-first order', () => {
    // Important for the operator's mental model — their own tags
    // stay at the head of the list; loser's tags appended after.
    expect(mergeTagArrays(['a', 'b'], ['c', 'a', 'd'])).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('redactInBodyForContact — GDPR erasure gap (audit M3)', () => {
  it('hard-deletes inbody_webhook_events (by matched_contact_id) and inbody_scans (by contact_id)', async () => {
    const db = makeFakeDb()
    await redactInBodyForContact(db, 'contact-123')

    const events = db.calls.find(c => c.table === 'inbody_webhook_events')
    expect(events).toBeDefined()
    expect(events.op).toBe('delete')
    expect(events.eqs).toEqual({ matched_contact_id: 'contact-123' })

    const scans = db.calls.find(c => c.table === 'inbody_scans')
    expect(scans).toBeDefined()
    expect(scans.op).toBe('delete')
    expect(scans.eqs).toEqual({ contact_id: 'contact-123' })
  })

  it('throws when contactId is missing (guards a mass wipe)', async () => {
    await expect(redactInBodyForContact(makeFakeDb(), '')).rejects.toThrow(/contactId required/)
  })

  it('is best-effort — a failure on one table still attempts the other', async () => {
    // If the webhook-events delete rejects, inbody_scans must still be tried.
    const db = makeFakeDb({ failOn: 'inbody_webhook_events' })
    await expect(redactInBodyForContact(db, 'contact-9')).resolves.toBeUndefined()
    expect(db.calls.some(c => c.table === 'inbody_scans')).toBe(true)
  })
})

// ── mergeContacts — the destructive path ────────────────────────────────
//
// MERGE-LOSS.1. The survivor stamp used to be a bare `await` with no error
// binding while every other write in mergeContacts throws. A failed stamp
// therefore fell straight through to `DELETE FROM contacts WHERE id =
// loser`: the loser was destroyed, everything folded into it was gone
// unrecoverably, and the caller got back a success object listing merged
// fields that were never written. These tests pin the ordering AND the
// refusal.

// A fake supabase client rich enough to drive the whole mergeContacts()
// flow. Every builder is a thenable (like the real one), so the terminal
// `await` resolves through one handler that can see the accumulated chain.
// `results` keys are `<table>.<op>` and may be a value or a function.
function makeMergeDb({ survivor, loser, results = {} } = {}) {
  const ops = []

  function resultFor(ctx) {
    const key = `${ctx.table}.${ctx.op}`
    if (key in results) {
      const r = results[key]
      return typeof r === 'function' ? r(ctx) : r
    }
    if (ctx.table === 'contacts' && ctx.op === 'select') {
      const id = ctx.filters.find(f => f[0] === 'eq' && f[1] === 'id')?.[2]
      if (id === survivor?.id) return { data: survivor, error: null }
      if (id === loser?.id) return { data: loser, error: null }
      return { data: null, error: { message: 'no rows' } }
    }
    // dedupePreUpdate's reads: survivor has no conflicting rows by default.
    if (ctx.op === 'select') return { data: ctx.maybeSingle ? null : [], error: null }
    if (ctx.op === 'update') return { data: null, error: null, count: 1 }
    return { data: null, error: null }
  }

  return {
    ops,
    opKeys: () => ops.map(o => `${o.table}.${o.op}`),
    from(table) {
      const ctx = { table, op: null, payload: null, opts: null, filters: [] }
      const builder = {
        select(cols) { if (!ctx.op) { ctx.op = 'select'; ctx.cols = cols } return builder },
        update(payload, opts) { ctx.op = 'update'; ctx.payload = payload; ctx.opts = opts; return builder },
        delete() { ctx.op = 'delete'; return builder },
        eq(c, v) { ctx.filters.push(['eq', c, v]); return builder },
        in(c, v) { ctx.filters.push(['in', c, v]); return builder },
        is(c, v) { ctx.filters.push(['is', c, v]); return builder },
        single() { ctx.single = true; return builder },
        maybeSingle() { ctx.maybeSingle = true; return builder },
        then(onOk, onErr) {
          ops.push(ctx)
          return Promise.resolve().then(() => resultFor(ctx)).then(onOk, onErr)
        },
      }
      return builder
    },
  }
}

const SURVIVOR = {
  id: 'survivor-1', location_id: 'loc-1',
  name: 'Ada', first_name: 'Ada', last_name: null,
  email: 'ada@x.com', phone: null, tags: ['vip'],
}
const LOSER = {
  id: 'loser-1', location_id: 'loc-1',
  name: 'Ada L', first_name: 'Ada', last_name: 'Lovelace',
  email: 'ada2@x.com', phone: '+353871234567', tags: ['newsletter'],
}

describe('mergeContacts — a failed survivor stamp must not delete the loser', () => {
  it('happy path: stamps the survivor, then deletes the loser', async () => {
    const db = makeMergeDb({ survivor: SURVIVOR, loser: LOSER })
    const out = await mergeContacts(db, { survivorId: SURVIVOR.id, loserId: LOSER.id })

    expect(out.survivor.last_name).toBe('Lovelace')      // loser filled the gap
    expect(out.survivor.phone).toBe('+353871234567')
    expect(out.survivor.tags).toEqual(['vip', 'newsletter'])
    expect(db.opKeys()).toContain('contacts.delete')

    const stamp = db.ops.find(o => o.table === 'contacts' && o.op === 'update')
    const del = db.ops.find(o => o.table === 'contacts' && o.op === 'delete')
    expect(db.ops.indexOf(stamp)).toBeLessThan(db.ops.indexOf(del))
  })

  it('stamps AFTER the FK updates — the documented ordering stays', async () => {
    // The comment above the stamp explains why: a partial FK failure must
    // not leave the survivor's fields modified while the loser still owns
    // its dependents. Fixing the stamp must not "fix" it by moving it up.
    const db = makeMergeDb({ survivor: SURVIVOR, loser: LOSER })
    await mergeContacts(db, { survivorId: SURVIVOR.id, loserId: LOSER.id })

    const stampIdx = db.ops.findIndex(o => o.table === 'contacts' && o.op === 'update')
    const lastFkIdx = db.ops.map((o, i) => (o.op === 'update' && o.table !== 'contacts' ? i : -1))
      .filter(i => i >= 0).pop()
    expect(lastFkIdx).toBeGreaterThan(-1)
    expect(stampIdx).toBeGreaterThan(lastFkIdx)
  })

  it('an ERRORED survivor stamp throws and the loser survives', async () => {
    const db = makeMergeDb({
      survivor: SURVIVOR,
      loser: LOSER,
      results: {
        'contacts.update': { data: null, error: { message: 'deadlock detected' }, count: null },
      },
    })
    await expect(mergeContacts(db, { survivorId: SURVIVOR.id, loserId: LOSER.id }))
      .rejects.toThrow(/deadlock detected/)
    expect(db.opKeys()).not.toContain('contacts.delete')
  })

  it('a ZERO-ROW survivor stamp throws too — a silent no-op is still a failed stamp', async () => {
    // PostgREST reports no error when an UPDATE matches nothing. "The
    // survivor's fields were never written" is the state being guarded,
    // however it arose.
    const db = makeMergeDb({
      survivor: SURVIVOR,
      loser: LOSER,
      results: { 'contacts.update': { data: null, error: null, count: 0 } },
    })
    await expect(mergeContacts(db, { survivorId: SURVIVOR.id, loserId: LOSER.id }))
      .rejects.toThrow(/mergeContacts/)
    expect(db.opKeys()).not.toContain('contacts.delete')
  })

  it('the thrown message names the half-merged state so the operator can act', async () => {
    // The FK updates have already run and cannot be undone, so the honest
    // report is: nothing was destroyed, the loser is still there, re-run.
    const db = makeMergeDb({
      survivor: SURVIVOR,
      loser: LOSER,
      results: { 'contacts.update': { data: null, error: { message: 'boom' }, count: null } },
    })
    const err = await mergeContacts(db, { survivorId: SURVIVOR.id, loserId: LOSER.id })
      .catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/not been deleted/i)
    expect(err.message).toMatch(/re-run/i)
    expect(err.message).toContain(LOSER.id)
  })

  it('does not report success for fields it never wrote', async () => {
    const db = makeMergeDb({
      survivor: SURVIVOR,
      loser: LOSER,
      results: { 'contacts.update': { data: null, error: { message: 'boom' }, count: null } },
    })
    // The old code resolved with { survivor: { ...survivor, ...mergedFields } }
    // — a success object describing a write that never landed.
    await expect(mergeContacts(db, { survivorId: SURVIVOR.id, loserId: LOSER.id })).rejects.toThrow()
  })
})

describe('dedupePreUpdate — its reads and writes report failure', () => {
  // A discarded read error here is not harmless: it yields "the survivor
  // has none of these", the dedupe is skipped, and the FK update that
  // follows hits the very UNIQUE index this function exists to clear — so
  // the merge dies at a confusing 23505 on an unrelated-looking table
  // instead of at the read that actually failed.
  const cases = [
    ['contact_preferences', 'contact_preferences.select'],
    ['sequence_enrollments', 'sequence_enrollments.select'],
    ['contact_tags', 'contact_tags.select'],
  ]

  it.each(cases)('a failed %s read aborts the merge before anything is folded', async (table, key) => {
    const db = makeMergeDb({
      survivor: SURVIVOR,
      loser: LOSER,
      results: { [key]: { data: null, error: { message: `read failed: ${table}` } } },
    })
    await expect(mergeContacts(db, { survivorId: SURVIVOR.id, loserId: LOSER.id }))
      .rejects.toThrow(new RegExp(table))
    // Nothing destructive, and no FK re-pointing, may have happened.
    expect(db.opKeys()).not.toContain('contacts.delete')
    expect(db.ops.filter(o => o.op === 'update')).toEqual([])
  })

  it('a failed dedupe DELETE aborts too — the conflict it was clearing is still there', async () => {
    const db = makeMergeDb({
      survivor: SURVIVOR,
      loser: LOSER,
      results: {
        'contact_preferences.select': { data: { id: 'pref-1' }, error: null },
        'contact_preferences.delete': { data: null, error: { message: 'delete refused' } },
      },
    })
    await expect(mergeContacts(db, { survivorId: SURVIVOR.id, loserId: LOSER.id }))
      .rejects.toThrow(/contact_preferences/)
    expect(db.opKeys()).not.toContain('contacts.delete')
  })
})
