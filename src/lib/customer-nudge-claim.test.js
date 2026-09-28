// C21 PUSHDONE.1b — member engagement pushes claim first (a duplicate to a
// member is worse than a miss) and release the claim when nothing reached the
// member because something broke. They used to keep it, losing the nudge.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./customer-push', () => ({ sendCustomerPush: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { sendCustomerPush } = await import('./customer-push')
const { logWarn, logError } = await import('./log')
const { sendNudgeOnce, readReachableContacts, nudgeFailed } = await import('./customer-nudge-claim')

// customer_engagement_nudges + champ_push_tokens, just enough of each.
function makeDb({ insertError = null, insertRows = [{ id: 'nudge-1' }], deleteError = null, tokenRows = [], tokenError = null } = {}) {
  const calls = { inserts: [], deletes: [], tokenReads: [] }
  return {
    calls,
    from(table) {
      if (table === 'champ_push_tokens') {
        return { select: () => ({ in: (_c, ids) => { calls.tokenReads.push(ids); return Promise.resolve(tokenError ? { data: null, error: tokenError } : { data: tokenRows.filter((r) => ids.includes(r.contact_id)), error: null }) } }) }
      }
      if (table !== 'customer_engagement_nudges') throw new Error(`unexpected table ${table}`)
      return {
        insert: (row) => ({ select: () => { calls.inserts.push(row); return Promise.resolve(insertError ? { data: null, error: insertError } : { data: insertRows, error: null }) } }),
        delete: () => ({ eq: (_c, id) => { calls.deletes.push(id); return Promise.resolve({ error: deleteError }) } }),
      }
    },
  }
}
const ARGS = { contactId: 'c1', type: 'winback', dedupKey: '2026-09', payload: { title: 't', body: 'b', data: { type: 'winback' } }, module: 'cron-winback' }

beforeEach(() => {
  vi.clearAllMocks()
  sendCustomerPush.mockResolvedValue({ sent: 1, invalidated: 0, failed: 0, skipped: 0 })
})

describe('sendNudgeOnce', () => {
  it('claims, sends, keeps the claim on delivery', async () => {
    const db = makeDb()
    expect(await sendNudgeOnce(db, ARGS)).toMatchObject({ status: 'sent' })
    expect(db.calls.inserts).toEqual([{ contact_id: 'c1', type: 'winback', dedup_key: '2026-09' }])
    expect(sendCustomerPush).toHaveBeenCalledWith(db, 'c1', ARGS.payload)
    expect(db.calls.deletes).toEqual([])
  })

  it('RELEASES the claim when nothing reached the member because something broke', async () => {
    const db = makeDb()
    sendCustomerPush.mockResolvedValueOnce({ sent: 0, invalidated: 0, failed: 1, skipped: 0, read_failed: 1 })
    expect(await sendNudgeOnce(db, ARGS)).toMatchObject({ status: 'released' })
    expect(db.calls.deletes).toEqual(['nudge-1'])
    expect(logWarn).toHaveBeenCalledWith('cron-winback', 'nothing delivered; claim released, a later run retries',
      { contactId: 'c1', type: 'winback', dedupKey: '2026-09', read_failed: true })
  })

  it('a throwing send releases too', async () => {
    const db = makeDb()
    sendCustomerPush.mockRejectedValueOnce(new Error('boom'))
    expect((await sendNudgeOnce(db, ARGS)).status).toBe('released')
    expect(db.calls.deletes).toEqual(['nudge-1'])
  })

  it('a partial delivery keeps the claim: never a duplicate', async () => {
    const db = makeDb()
    sendCustomerPush.mockResolvedValueOnce({ sent: 1, invalidated: 0, failed: 1, skipped: 0 })
    expect((await sendNudgeOnce(db, ARGS)).status).toBe('sent')
    expect(db.calls.deletes).toEqual([])
  })

  it('nothing to deliver to (no token left, opted out) keeps the claim: settled', async () => {
    const db = makeDb()
    sendCustomerPush.mockResolvedValueOnce({ sent: 0, invalidated: 0, failed: 0, skipped: 1 })
    expect((await sendNudgeOnce(db, ARGS)).status).toBe('settled')
    expect(db.calls.deletes).toEqual([])
  })

  it('an existing claim (unique violation) is deduped, silently, and nothing is sent', async () => {
    const db = makeDb({ insertError: { code: '23505', message: 'duplicate key' } })
    expect((await sendNudgeOnce(db, ARGS)).status).toBe('deduped')
    expect(sendCustomerPush).not.toHaveBeenCalled()
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('any other claim error sends NOTHING and says so (F4)', async () => {
    const db = makeDb({ insertError: { code: '08006', message: 'connection failure' } })
    expect((await sendNudgeOnce(db, ARGS)).status).toBe('claim_failed')
    expect(sendCustomerPush).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('cron-winback', 'nudge claim failed; nothing sent, a later run retries',
      { contactId: 'c1', type: 'winback', dedupKey: '2026-09', err: 'connection failure' })
  })

  it('a failed release is said at error level: this nudge is lost', async () => {
    const db = makeDb({ deleteError: { message: 'down' } })
    sendCustomerPush.mockResolvedValueOnce({ sent: 0, invalidated: 0, failed: 1, skipped: 0 })
    expect((await sendNudgeOnce(db, ARGS)).status).toBe('release_failed')
    expect(logError).toHaveBeenCalledWith('cron-winback', 'nothing delivered and the claim release failed; this nudge will not retry',
      expect.objectContaining({ contactId: 'c1', err: 'down' }))
  })

  it('nudgeFailed names the three "did not get it this run" statuses', () => {
    expect(['claim_failed', 'released', 'release_failed'].every(nudgeFailed)).toBe(true)
    expect(['sent', 'settled', 'deduped'].some(nudgeFailed)).toBe(false)
  })
})

describe('readReachableContacts', () => {
  it('returns the contacts with a token', async () => {
    const db = makeDb({ tokenRows: [{ contact_id: 'a' }, { contact_id: 'c' }] })
    const { reachable, failed } = await readReachableContacts(db, ['a', 'b', 'c'], 'm')
    expect([...reachable].sort()).toEqual(['a', 'c'])
    expect(failed).toBe(0)
  })

  it('a failed read is not "unreachable": counted, logged, nobody in it returned (so nobody is claimed)', async () => {
    const db = makeDb({ tokenError: { message: 'down' } })
    const { reachable, failed } = await readReachableContacts(db, ['a', 'b'], 'cron-streak-risk')
    expect(reachable.size).toBe(0)
    expect(failed).toBe(2)
    expect(logWarn).toHaveBeenCalledWith('cron-streak-risk', 'push-token read failed; these members are skipped this run and retried by the next',
      { contacts: 2, err: 'down' })
  })
})
