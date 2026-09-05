// MAIL-DEADLETTER.2 — the orphan re-stamp, pinned against a hand-rolled
// chainable fake so every filter it puts on the wire is asserted, not assumed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import {
  restampOrphanInboundDeadLetters,
  RESTAMP_SCAN_LIMIT,
  RESTAMP_MAILBOX_LIMIT,
  RESTAMP_STATUSES,
} from './webhook-dead-letter-restamp.js'
import { logWarn, logInfo } from '@/lib/log'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'a0000000-0000-0000-0000-000000000002'

const MB = (over = {}) => ({ id: 'mb-1', location_id: LOC_A, address: 'studio@example.test', active: true, ...over })

const payloadTo = (to, extra = {}) => ({
  ToFull: [{ Email: to, Name: '' }],
  OriginalRecipient: to,
  Subject: 'hello',
  ...extra,
})

/**
 * A fake that records every chained call per statement and answers the
 * terminal read/update from the scripted results, in order of `.from()`.
 */
function makeDb({ orphans = [], orphansError = null, mailboxes = [], mailboxesError = null, updateError = null, updateThrows = false } = {}) {
  const statements = []
  let mailboxSelects = 0
  function chain(table) {
    const st = { table, calls: [], kind: null, updatePatch: null }
    statements.push(st)
    const resultFor = () => {
      if (table === 'webhook_dead_letter' && st.kind === 'select') {
        return { data: orphansError ? null : orphans, error: orphansError }
      }
      if (table === 'email_mailboxes') {
        mailboxSelects += 1
        return { data: mailboxesError ? null : mailboxes, error: mailboxesError }
      }
      if (table === 'webhook_dead_letter' && st.kind === 'update') {
        if (updateThrows) throw new Error('update exploded')
        if (updateError) return { data: null, error: updateError }
        const ids = st.calls.find(c => c[0] === 'in' && c[1] === 'id')?.[2] || []
        return { data: ids.map(id => ({ id })), error: null }
      }
      return { data: null, error: null }
    }
    const b = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'update']) {
      b[m] = (...args) => {
        st.calls.push([m, ...args])
        if (m === 'update') { st.kind = 'update'; st.updatePatch = args[0] }
        if (m === 'select' && st.kind !== 'update') st.kind = 'select'
        return b
      }
    }
    b.then = (resolve, reject) => Promise.resolve().then(resultFor).then(resolve, reject)
    return b
  }
  return {
    from: vi.fn((table) => chain(table)),
    _statements: statements,
    _mailboxSelects: () => mailboxSelects,
  }
}

const updates = (db) => db._statements.filter(s => s.table === 'webhook_dead_letter' && s.kind === 'update')
const has = (st, m, ...args) => st.calls.some(c => c[0] === m && JSON.stringify(c.slice(1)) === JSON.stringify(args))

beforeEach(() => vi.clearAllMocks())

describe('the orphan read — exactly the rows mig 586 touched', () => {
  it('reads NULL-location postmark_inbound rows that are still pending/failed, bounded', async () => {
    const db = makeDb()
    await restampOrphanInboundDeadLetters(db)
    const read = db._statements[0]
    expect(read.table).toBe('webhook_dead_letter')
    expect(has(read, 'select', 'id, payload')).toBe(true)
    expect(has(read, 'eq', 'provider', 'postmark_inbound')).toBe(true)
    expect(has(read, 'is', 'location_id', null)).toBe(true)
    expect(has(read, 'in', 'status', ['pending', 'failed'])).toBe(true)
    expect(has(read, 'limit', RESTAMP_SCAN_LIMIT)).toBe(true)
    expect(RESTAMP_STATUSES).toEqual(['pending', 'failed'])
  })

  it('with no orphans it touches nothing else — not even the mailbox table', async () => {
    const db = makeDb({ orphans: [] })
    const out = await restampOrphanInboundDeadLetters(db)
    expect(out).toEqual({ ok: true, scanned: 0, stamped: 0 })
    expect(db._mailboxSelects()).toBe(0)
    expect(updates(db)).toHaveLength(0)
    expect(logInfo).not.toHaveBeenCalled()
  })
})

describe('resolution — the capture path\'s own resolver, against the mailboxes that exist NOW', () => {
  it('stamps a row whose recipient matches an active mailbox, guarding the UPDATE on NULL too', async () => {
    const db = makeDb({
      orphans: [{ id: 7, payload: payloadTo('Studio@Example.test') }],
      mailboxes: [MB()],
    })
    const out = await restampOrphanInboundDeadLetters(db, { reason: 'mailbox_created', mailboxId: 'mb-1' })
    expect(out).toEqual({ ok: true, scanned: 1, stamped: 1 })
    const [up] = updates(db)
    expect(up.updatePatch).toEqual({ location_id: LOC_A })
    expect(has(up, 'in', 'id', [7])).toBe(true)
    // Idempotency: a stamp another process wrote between read and write is kept.
    expect(has(up, 'is', 'location_id', null)).toBe(true)
    expect(has(up, 'select', 'id')).toBe(true)
    expect(logInfo).toHaveBeenCalledWith('webhook-dead-letter-restamp', 'orphans re-stamped', expect.objectContaining({
      reason: 'mailbox_created', mailboxId: 'mb-1', scanned: 1, stamped: 1,
    }))
  })

  it('loads ACTIVE mailboxes only, bounded — and never stamps through an inactive one', async () => {
    const db = makeDb({
      orphans: [{ id: 1, payload: payloadTo('dead@example.test') }],
      // The fake answers whatever it is given; the predicate must ALSO hold
      // in JS, because resolveMailboxByRecipient skips inactive rows.
      mailboxes: [MB({ id: 'mb-dead', address: 'dead@example.test', active: false })],
    })
    const out = await restampOrphanInboundDeadLetters(db)
    const mbRead = db._statements.find(s => s.table === 'email_mailboxes')
    expect(has(mbRead, 'eq', 'active', true)).toBe(true)
    expect(has(mbRead, 'limit', RESTAMP_MAILBOX_LIMIT)).toBe(true)
    expect(out).toEqual({ ok: true, scanned: 1, stamped: 0 })
    expect(updates(db)).toHaveLength(0)
  })

  it('leaves a row that still matches nothing NULL — the fail-open default, never a guess', async () => {
    const db = makeDb({
      orphans: [{ id: 1, payload: payloadTo('nobody@example.test') }],
      mailboxes: [MB()],
    })
    const out = await restampOrphanInboundDeadLetters(db)
    expect(out).toEqual({ ok: true, scanned: 1, stamped: 0 })
    expect(updates(db)).toHaveLength(0)
  })

  it('the FIRST recipient that matches wins: To before Cc, the same order capture uses', async () => {
    const db = makeDb({
      orphans: [{ id: 1, payload: { ToFull: [{ Email: 'studio@example.test' }], CcFull: [{ Email: 'accounts@example.test' }] } }],
      mailboxes: [MB(), MB({ id: 'mb-2', address: 'accounts@example.test', location_id: LOC_B })],
    })
    await restampOrphanInboundDeadLetters(db)
    expect(updates(db)[0].updatePatch).toEqual({ location_id: LOC_A })
  })

  it('a Cc-only match, and an OriginalRecipient-only match, both resolve', async () => {
    const db = makeDb({
      orphans: [
        { id: 1, payload: { ToFull: [{ Email: 'someone@else.test' }], CcFull: [{ Email: 'studio@example.test' }] } },
        { id: 2, payload: { OriginalRecipient: 'studio@example.test' } },
      ],
      mailboxes: [MB()],
    })
    const out = await restampOrphanInboundDeadLetters(db)
    expect(out.stamped).toBe(2)
    expect(has(updates(db)[0], 'in', 'id', [1, 2])).toBe(true)
  })

  it('groups the write per studio — one UPDATE per location, not per row', async () => {
    const db = makeDb({
      orphans: [
        { id: 1, payload: payloadTo('studio@example.test') },
        { id: 2, payload: payloadTo('accounts@example.test') },
        { id: 3, payload: payloadTo('studio@example.test') },
      ],
      mailboxes: [MB(), MB({ id: 'mb-2', address: 'accounts@example.test', location_id: LOC_B })],
    })
    const out = await restampOrphanInboundDeadLetters(db)
    expect(out).toEqual({ ok: true, scanned: 3, stamped: 3 })
    const ups = updates(db)
    expect(ups).toHaveLength(2)
    const byLoc = Object.fromEntries(ups.map(u => [u.updatePatch.location_id, u.calls.find(c => c[0] === 'in' && c[1] === 'id')[2]]))
    expect(byLoc).toEqual({ [LOC_A]: [1, 3], [LOC_B]: [2] })
  })

  it('a malformed payload is skipped, not thrown on', async () => {
    const db = makeDb({
      orphans: [{ id: 1, payload: 'not-an-object' }, { id: 2, payload: null }, { id: 3, payload: payloadTo('studio@example.test') }],
      mailboxes: [MB()],
    })
    const out = await restampOrphanInboundDeadLetters(db)
    expect(out).toEqual({ ok: true, scanned: 3, stamped: 1 })
    expect(has(updates(db)[0], 'in', 'id', [3])).toBe(true)
  })
})

describe('the contract — never throws, never hides a failure', () => {
  it('a failed orphan read is ok:false, logged, and stops there', async () => {
    const db = makeDb({ orphansError: { message: 'boom' } })
    const out = await restampOrphanInboundDeadLetters(db)
    expect(out).toEqual({ ok: false, scanned: 0, stamped: 0, error: 'boom' })
    expect(db._mailboxSelects()).toBe(0)
    expect(logWarn).toHaveBeenCalledWith('webhook-dead-letter-restamp', 'orphan read failed', expect.anything())
  })

  it('a failed mailbox read is ok:false and writes nothing', async () => {
    const db = makeDb({ orphans: [{ id: 1, payload: payloadTo('studio@example.test') }], mailboxesError: { message: 'mb boom' } })
    const out = await restampOrphanInboundDeadLetters(db)
    expect(out).toEqual({ ok: false, scanned: 1, stamped: 0, error: 'mb boom' })
    expect(updates(db)).toHaveLength(0)
  })

  it('a failed UPDATE is ok:false with the count it DID stamp, and is logged', async () => {
    const db = makeDb({ orphans: [{ id: 1, payload: payloadTo('studio@example.test') }], mailboxes: [MB()], updateError: { message: 'up boom' } })
    const out = await restampOrphanInboundDeadLetters(db)
    expect(out.ok).toBe(false)
    expect(out.stamped).toBe(0)
    expect(logWarn).toHaveBeenCalledWith('webhook-dead-letter-restamp', 'stamp failed', expect.objectContaining({ locationId: LOC_A, count: 1 }))
  })

  it('a throw anywhere is caught and answered, never propagated', async () => {
    const db = makeDb({ orphans: [{ id: 1, payload: payloadTo('studio@example.test') }], mailboxes: [MB()], updateThrows: true })
    await expect(restampOrphanInboundDeadLetters(db)).resolves.toEqual({ ok: false, scanned: 0, stamped: 0, error: 'update exploded' })
    expect(logWarn).toHaveBeenCalledWith('webhook-dead-letter-restamp', 'threw', expect.anything())
  })

  it('a db with no from() at all is still just ok:false', async () => {
    await expect(restampOrphanInboundDeadLetters(null)).resolves.toMatchObject({ ok: false })
    await expect(restampOrphanInboundDeadLetters({})).resolves.toMatchObject({ ok: false })
  })
})
