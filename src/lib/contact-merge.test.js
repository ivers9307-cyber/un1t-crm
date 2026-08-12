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


// ── mergeContacts — now a thin RPC wrapper (MERGE-TX.1) ─────────────────
//
// WHAT CHANGED AND WHY THE COVERAGE IS NOT WEAKER
// ───────────────────────────────────────────────
// mergeContacts used to run ~25 unprotected statements from JS: dedupe deletes,
// then FK re-points, then the survivor stamp, then the loser delete. The old
// tests here pinned that sequence — the stamp lands after the re-points, an
// errored or zero-row stamp throws before the delete, a failed dedupe read
// aborts before anything folds. All of it existed to make a HALF-MERGE
// survivable, because there was no transaction.
//
// Migration 533 moves the whole merge into public.merge_contacts(), so it runs
// in one implicit transaction. Those orderings still exist — they are asserted
// against the migration text in tests/migration-533-merge-contacts.test.js —
// but they are no longer JS behaviour, so pinning them against a fake supabase
// client here would be testing a mock.
//
// What replaces them is stronger where it counts: the tests below prove the JS
// issues NO writes at all. The entire class of bug the old tests guarded
// against — a partial write from this function — is now structurally
// unreachable rather than carefully handled.
//
// Honest gap: nothing here EXECUTES the SQL. This repo has no local Postgres
// and no pgTAP (supabase/ has no config.toml), so the migration is covered by
// text assertions only, exactly as migrations 510-512 are.

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

// Fake client: reads of `contacts` resolve the two fixtures; db.rpc records the
// call and returns whatever the test configured.
function makeRpcDb({ survivor = SURVIVOR, loser = LOSER, rpc } = {}) {
  const ops = []
  const rpcCalls = []
  return {
    ops,
    rpcCalls,
    rpc(name, params) {
      rpcCalls.push({ name, params })
      return Promise.resolve(
        rpc ?? {
          data: {
            survivor: { ...survivor, last_name: 'Lovelace', phone: '+353871234567', tags: ['vip', 'newsletter'] },
            folded: { 'activities.contact_id': 3, 'deals.contact_id': 1 },
          },
          error: null,
        },
      )
    },
    from(table) {
      const ctx = { table, op: null, filters: [] }
      const builder = {
        select(cols) { if (!ctx.op) { ctx.op = 'select'; ctx.cols = cols } return builder },
        update(payload) { ctx.op = 'update'; ctx.payload = payload; return builder },
        delete() { ctx.op = 'delete'; return builder },
        eq(c, v) { ctx.filters.push(['eq', c, v]); return builder },
        in(c, v) { ctx.filters.push(['in', c, v]); return builder },
        is(c, v) { ctx.filters.push(['is', c, v]); return builder },
        single() { ctx.single = true; return builder },
        maybeSingle() { ctx.maybeSingle = true; return builder },
        then(onOk, onErr) {
          ops.push(ctx)
          const id = ctx.filters.find(f => f[0] === 'eq' && f[1] === 'id')?.[2]
          let res = { data: null, error: null }
          if (table === 'contacts' && ctx.op === 'select') {
            if (id === survivor?.id) res = { data: survivor, error: null }
            else if (id === loser?.id) res = { data: loser, error: null }
            else res = { data: null, error: { message: 'no rows' } }
          }
          return Promise.resolve().then(() => res).then(onOk, onErr)
        },
      }
      return builder
    },
  }
}

describe('mergeContacts — delegates the whole merge to one transaction', () => {
  it('calls the merge_contacts RPC with both ids and the merged field payload', async () => {
    const db = makeRpcDb()
    await mergeContacts(db, { survivorId: 'survivor-1', loserId: 'loser-1' })

    expect(db.rpcCalls).toHaveLength(1)
    expect(db.rpcCalls[0].name).toBe('merge_contacts')
    expect(db.rpcCalls[0].params.p_survivor_id).toBe('survivor-1')
    expect(db.rpcCalls[0].params.p_loser_id).toBe('loser-1')
    // The field-merge rule stays in JS (pickMergedFields), so its output rides
    // along rather than being reimplemented in SQL.
    expect(db.rpcCalls[0].params.p_merged_fields).toMatchObject({
      last_name: 'Lovelace',
      phone: '+353871234567',
      email: 'ada@x.com',
    })
    expect(db.rpcCalls[0].params.p_merged_tags).toEqual(['vip', 'newsletter'])
  })

  it('issues NO writes of its own — a half-merge is structurally impossible here', async () => {
    // This is the replacement for every old ordering test. The JS cannot leave
    // a partial merge because the JS does not write.
    const db = makeRpcDb()
    await mergeContacts(db, { survivorId: 'survivor-1', loserId: 'loser-1' })

    expect(db.ops.filter(o => o.op === 'update')).toEqual([])
    expect(db.ops.filter(o => o.op === 'delete')).toEqual([])
    expect(db.ops.every(o => o.op === 'select')).toBe(true)
  })

  it('returns the { survivor, folded } contract the route and UI depend on', async () => {
    const db = makeRpcDb()
    const out = await mergeContacts(db, { survivorId: 'survivor-1', loserId: 'loser-1' })

    expect(out.survivor.last_name).toBe('Lovelace')
    expect(out.survivor.phone).toBe('+353871234567')
    expect(out.survivor.tags).toEqual(['vip', 'newsletter'])
    expect(out.folded).toEqual({ 'activities.contact_id': 3, 'deals.contact_id': 1 })
  })

  it('throws with the database message when the transaction aborts', async () => {
    const db = makeRpcDb({ rpc: { data: null, error: { message: 'duplicate key value violates unique constraint' } } })
    await expect(mergeContacts(db, { survivorId: 'survivor-1', loserId: 'loser-1' }))
      .rejects.toThrow(/duplicate key value/)
  })

  it('says the merge was rolled back — the operator must not go hunting for a half-merge', async () => {
    const db = makeRpcDb({ rpc: { data: null, error: { message: 'deadlock detected' } } })
    await expect(mergeContacts(db, { survivorId: 'survivor-1', loserId: 'loser-1' }))
      .rejects.toThrow(/rolled back|nothing (has )?changed/i)
  })

  it('treats a null RPC payload as a failure rather than reporting an empty success', async () => {
    const db = makeRpcDb({ rpc: { data: null, error: null } })
    await expect(mergeContacts(db, { survivorId: 'survivor-1', loserId: 'loser-1' })).rejects.toThrow(/mergeContacts/)
  })

  it.each([
    [{ survivorId: '', loserId: 'l' }, /survivorId and loserId required/],
    [{ survivorId: 's', loserId: '' }, /survivorId and loserId required/],
    [{ survivorId: 'x', loserId: 'x' }, /cannot merge a contact with itself/],
  ])('keeps the argument guards (%#) — and never reaches the RPC', async (args, re) => {
    const db = makeRpcDb()
    await expect(mergeContacts(db, args)).rejects.toThrow(re)
    expect(db.rpcCalls).toEqual([])
  })

  it('still refuses a cross-location merge before calling anything', async () => {
    const db = makeRpcDb({ loser: { ...LOSER, location_id: 'loc-2' } })
    await expect(mergeContacts(db, { survivorId: 'survivor-1', loserId: 'loser-1' }))
      .rejects.toThrow(/same location/)
    expect(db.rpcCalls).toEqual([])
  })

  it.each([
    ['survivor', 'nope-1', 'loser-1', /survivor nope-1 not found/],
    ['loser', 'survivor-1', 'nope-2', /loser nope-2 not found/],
  ])('still reports a missing %s', async (_which, survivorId, loserId, re) => {
    const db = makeRpcDb()
    await expect(mergeContacts(db, { survivorId, loserId })).rejects.toThrow(re)
    expect(db.rpcCalls).toEqual([])
  })

  it('never sends last_active_at — contacts has no such column, and it 400d every merge', async () => {
    // pickMergedFields listed last_active_at from the day merge shipped
    // (36e49302). public.contacts has never had that column (verified against
    // information_schema 2026-08-12; the string appears in no migration), so
    // PostgREST rejected the stamp with PGRST204 on EVERY merge — after the
    // dedupe deletes and FK re-points had already landed. That is the
    // half-merged state migration 532 had to repair.
    const db = makeRpcDb()
    await mergeContacts(db, { survivorId: 'survivor-1', loserId: 'loser-1' })
    expect(db.rpcCalls[0].params.p_merged_fields).not.toHaveProperty('last_active_at')
  })
})
