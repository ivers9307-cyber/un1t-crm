// PMSUPP.1 — behaviour contract for the Postmark Suppressions client.
//
// THE ASYMMETRY THIS FILE EXISTS FOR
// Marketing goes out on the `broadcast` stream. Postmark's own mail-client
// "Unsubscribe" button suppresses the address AT POSTMARK and webhooks us
// (SubscriptionChange). OUR surfaces — /api/unsubscribe/[token], the
// preference centre — wrote only to our database, so for those opt-outs our
// database was the SINGLE gate. That gate has already failed once (mig 544:
// eleven contacts logged as opted out while the column the sender reads still
// said mailable). This module is the second, independent refusal.
//
// The load-bearing test in here is the LAST describe block: a resubscribe must
// NEVER delete a HardBounce suppression. Postmark documents deleting one as
// "reactivating the associated bounce" — i.e. the dead mailbox becomes
// mailable again. This repo already holds that rule on the database side
// (emailStatusNormaliseForOptIn, NOENGSUP.1); an unconditional delete here
// would reintroduce it through a new door.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  suppressAtPostmark,
  unsuppressAtPostmark,
  listPostmarkSuppressions,
} from './postmark-suppressions.js'

// ── fetch stub ──────────────────────────────────────────────────────
// Every test drives `global.fetch`. Nothing here touches the network.
let fetchMock

function stubFetch(handler) {
  fetchMock = vi.fn(handler)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** A Postmark 200 with `body` as the JSON payload. */
const ok = (body) => ({ ok: true, status: 200, json: async () => body })

/** Echo every requested address back with the given Status. */
function echo(status) {
  return async (_url, init) => {
    const sent = JSON.parse(init.body).Suppressions
    return ok({ Suppressions: sent.map(s => ({ EmailAddress: s.EmailAddress, Status: status, Message: null })) })
  }
}

/** The suppression-dump payload for a GET .../suppressions/dump. */
const dump = (rows) => ok({ Suppressions: rows })

const calls = () => fetchMock.mock.calls
const urls = () => calls().map(c => c[0])
const bodyOf = (i) => JSON.parse(calls()[i][1].body)
const emailsOf = (i) => bodyOf(i).Suppressions.map(s => s.EmailAddress)

beforeEach(() => {
  vi.stubEnv('POSTMARK_API_KEY', 'test-server-token')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ────────────────────────────────────────────────────────────────────
describe('suppressAtPostmark', () => {
  it('suppresses a single address passed as a bare string', async () => {
    stubFetch(echo('Suppressed'))
    const res = await suppressAtPostmark('a@x.com')
    expect(res).toEqual({ ok: 1, failed: [] })
    expect(urls()[0]).toBe('https://api.postmarkapp.com/message-streams/broadcast/suppressions')
    expect(calls()[0][1].method).toBe('POST')
    expect(calls()[0][1].headers['X-Postmark-Server-Token']).toBe('test-server-token')
    expect(bodyOf(0)).toEqual({ Suppressions: [{ EmailAddress: 'a@x.com' }] })
  })

  it('accepts an array and honours a non-default stream', async () => {
    stubFetch(echo('Suppressed'))
    const res = await suppressAtPostmark(['a@x.com', 'b@x.com'], { stream: 'outbound' })
    expect(res.ok).toBe(2)
    expect(urls()[0]).toBe('https://api.postmarkapp.com/message-streams/outbound/suppressions')
  })

  it('chunks at Postmark’s 50-per-call limit', async () => {
    stubFetch(echo('Suppressed'))
    const many = Array.from({ length: 120 }, (_, i) => `u${i}@x.com`)
    const res = await suppressAtPostmark(many)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(emailsOf(0)).toHaveLength(50)
    expect(emailsOf(1)).toHaveLength(50)
    expect(emailsOf(2)).toHaveLength(20)
    expect(emailsOf(2)[19]).toBe('u119@x.com')
    expect(res).toEqual({ ok: 120, failed: [] })
  })

  it('reports a per-address Failed status instead of counting it as ok', async () => {
    stubFetch(async () => ok({
      Suppressions: [
        { EmailAddress: 'good@x.com', Status: 'Suppressed', Message: null },
        { EmailAddress: 'bad@x.com', Status: 'Failed', Message: 'SpamComplaint suppressions cannot be deleted.' },
      ],
    }))
    const res = await suppressAtPostmark(['good@x.com', 'bad@x.com'])
    expect(res.ok).toBe(1)
    expect(res.failed).toEqual([
      { email: 'bad@x.com', message: 'SpamComplaint suppressions cannot be deleted.' },
    ])
  })

  it('accounts for every requested address even when Postmark omits one', async () => {
    stubFetch(async () => ok({ Suppressions: [{ EmailAddress: 'a@x.com', Status: 'Suppressed' }] }))
    const res = await suppressAtPostmark(['a@x.com', 'ghost@x.com'])
    expect(res.ok).toBe(1)
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].email).toBe('ghost@x.com')
  })

  it('never throws on a non-2xx — the whole chunk comes back as failed', async () => {
    stubFetch(async () => ({ ok: false, status: 422, json: async () => ({ ErrorCode: 300, Message: 'Invalid stream' }) }))
    const res = await suppressAtPostmark(['a@x.com', 'b@x.com'])
    expect(res.ok).toBe(0)
    expect(res.failed.map(f => f.email)).toEqual(['a@x.com', 'b@x.com'])
    expect(res.failed[0].message).toContain('Invalid stream')
  })

  it('never throws when fetch itself rejects', async () => {
    stubFetch(async () => { throw new Error('ECONNRESET') })
    const res = await suppressAtPostmark('a@x.com')
    expect(res).toEqual({ ok: 0, failed: [{ email: 'a@x.com', message: 'ECONNRESET' }] })
  })

  it('never throws when the response body is not JSON', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token <') } }))
    const res = await suppressAtPostmark('a@x.com')
    expect(res.ok).toBe(0)
    expect(res.failed).toHaveLength(1)
  })

  it('makes no call at all with no token configured, and still returns a usable shape', async () => {
    vi.stubEnv('POSTMARK_API_KEY', '')
    vi.stubEnv('POSTMARK_SERVER_TOKEN', '')
    stubFetch(echo('Suppressed'))
    const res = await suppressAtPostmark('a@x.com')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.ok).toBe(0)
    expect(res.failed).toHaveLength(1)
  })

  it('is a no-op for an empty / junk address list', async () => {
    stubFetch(echo('Suppressed'))
    expect(await suppressAtPostmark([])).toEqual({ ok: 0, failed: [] })
    expect(await suppressAtPostmark(null)).toEqual({ ok: 0, failed: [] })
    expect(await suppressAtPostmark([null, '', '  '])).toEqual({ ok: 0, failed: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('de-duplicates case-insensitively so one address is never sent twice', async () => {
    stubFetch(echo('Suppressed'))
    const res = await suppressAtPostmark(['A@x.com', 'a@x.com', ' a@x.com '])
    expect(emailsOf(0)).toEqual(['A@x.com'])
    expect(res.ok).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────
describe('listPostmarkSuppressions', () => {
  it('dumps the stream and returns the rows', async () => {
    const rows = [{ EmailAddress: 'a@x.com', SuppressionReason: 'ManualSuppression', Origin: 'Recipient', CreatedAt: '2026-08-01T00:00:00Z' }]
    stubFetch(async () => dump(rows))
    const res = await listPostmarkSuppressions()
    expect(urls()[0]).toBe('https://api.postmarkapp.com/message-streams/broadcast/suppressions/dump')
    expect(calls()[0][1].method).toBe('GET')
    expect(res).toEqual({ suppressions: rows, error: null })
  })

  it('passes the optional filters as query parameters', async () => {
    stubFetch(async () => dump([]))
    await listPostmarkSuppressions({ stream: 'broadcast', suppressionReason: 'ManualSuppression', origin: 'Customer' })
    expect(urls()[0]).toContain('SuppressionReason=ManualSuppression')
    expect(urls()[0]).toContain('Origin=Customer')
  })

  it('reports the failure rather than an empty list, so a caller cannot read a dead API as "nothing suppressed"', async () => {
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({ Message: 'Bad token' }) }))
    const res = await listPostmarkSuppressions()
    expect(res.suppressions).toEqual([])
    expect(res.error).toContain('Bad token')
  })

  it('never throws when fetch rejects', async () => {
    stubFetch(async () => { throw new Error('ETIMEDOUT') })
    const res = await listPostmarkSuppressions()
    expect(res).toEqual({ suppressions: [], error: 'ETIMEDOUT' })
  })
})

// ────────────────────────────────────────────────────────────────────
// THE SAFETY RULE. A resubscribe click may lift OUR OWN suppression and
// nothing else.
describe('unsuppressAtPostmark', () => {
  /** list → dump rows; delete → every requested address Deleted. */
  function stubListThenDelete(rows, deleteHandler) {
    return stubFetch(async (url, init) => {
      if (String(url).includes('/suppressions/dump')) return dump(rows)
      return deleteHandler ? deleteHandler(url, init) : echo('Deleted')(url, init)
    })
  }

  const deleteCalls = () => calls().filter(c => String(c[0]).endsWith('/suppressions/delete'))

  it('deletes a ManualSuppression', async () => {
    stubListThenDelete([{ EmailAddress: 'a@x.com', SuppressionReason: 'ManualSuppression', Origin: 'Recipient' }])
    const res = await unsuppressAtPostmark('a@x.com')
    expect(res).toEqual({ ok: 1, failed: [], skipped: [] })
    expect(deleteCalls()).toHaveLength(1)
    expect(deleteCalls()[0][0]).toBe('https://api.postmarkapp.com/message-streams/broadcast/suppressions/delete')
    expect(JSON.parse(deleteCalls()[0][1].body)).toEqual({ Suppressions: [{ EmailAddress: 'a@x.com' }] })
  })

  it('REFUSES to delete a HardBounce — deleting one reactivates the bounce', async () => {
    stubListThenDelete([{ EmailAddress: 'dead@x.com', SuppressionReason: 'HardBounce', Origin: 'Recipient' }])
    const res = await unsuppressAtPostmark('dead@x.com')
    expect(res.ok).toBe(0)
    expect(res.skipped).toEqual([{ email: 'dead@x.com', reason: 'HardBounce' }])
    expect(deleteCalls()).toHaveLength(0)
  })

  it('REFUSES to delete a SpamComplaint', async () => {
    stubListThenDelete([{ EmailAddress: 'angry@x.com', SuppressionReason: 'SpamComplaint', Origin: 'Recipient' }])
    const res = await unsuppressAtPostmark('angry@x.com')
    expect(res.ok).toBe(0)
    expect(res.skipped).toEqual([{ email: 'angry@x.com', reason: 'SpamComplaint' }])
    expect(deleteCalls()).toHaveLength(0)
  })

  it('deletes only the manual ones out of a mixed batch', async () => {
    stubListThenDelete([
      { EmailAddress: 'manual@x.com', SuppressionReason: 'ManualSuppression' },
      { EmailAddress: 'dead@x.com', SuppressionReason: 'HardBounce' },
      { EmailAddress: 'angry@x.com', SuppressionReason: 'SpamComplaint' },
    ])
    const res = await unsuppressAtPostmark(['manual@x.com', 'dead@x.com', 'angry@x.com'])
    expect(res.ok).toBe(1)
    expect(res.skipped).toEqual([
      { email: 'dead@x.com', reason: 'HardBounce' },
      { email: 'angry@x.com', reason: 'SpamComplaint' },
    ])
    expect(JSON.parse(deleteCalls()[0][1].body).Suppressions).toEqual([{ EmailAddress: 'manual@x.com' }])
  })

  it('matches the suppression case-insensitively (contacts are stored mixed-case)', async () => {
    stubListThenDelete([{ EmailAddress: 'Dead@X.com', SuppressionReason: 'HardBounce' }])
    const res = await unsuppressAtPostmark('dead@x.com')
    expect(res.skipped).toEqual([{ email: 'dead@x.com', reason: 'HardBounce' }])
    expect(deleteCalls()).toHaveLength(0)
  })

  it('skips an address that is not suppressed at all, without calling delete', async () => {
    stubListThenDelete([])
    const res = await unsuppressAtPostmark('nobody@x.com')
    expect(res).toEqual({ ok: 0, failed: [], skipped: [{ email: 'nobody@x.com', reason: 'NotSuppressed' }] })
    expect(deleteCalls()).toHaveLength(0)
  })

  it('deletes NOTHING when the list call failed — an unverifiable reason is never assumed manual', async () => {
    stubFetch(async (url) => {
      if (String(url).includes('/suppressions/dump')) return { ok: false, status: 500, json: async () => ({ Message: 'Postmark down' }) }
      return echo('Deleted')(url, { body: '{"Suppressions":[]}' })
    })
    const res = await unsuppressAtPostmark('a@x.com')
    expect(res.ok).toBe(0)
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].message).toContain('Postmark down')
    expect(deleteCalls()).toHaveLength(0)
  })

  it('chunks the delete at 50 per call', async () => {
    const many = Array.from({ length: 120 }, (_, i) => `u${i}@x.com`)
    stubListThenDelete(many.map(EmailAddress => ({ EmailAddress, SuppressionReason: 'ManualSuppression' })))
    const res = await unsuppressAtPostmark(many)
    expect(deleteCalls()).toHaveLength(3)
    expect(JSON.parse(deleteCalls()[2][1].body).Suppressions).toHaveLength(20)
    expect(res.ok).toBe(120)
  })

  it('reports a Failed delete status', async () => {
    stubListThenDelete(
      [{ EmailAddress: 'a@x.com', SuppressionReason: 'ManualSuppression' }],
      async () => ok({ Suppressions: [{ EmailAddress: 'a@x.com', Status: 'Failed', Message: 'Nope' }] }),
    )
    const res = await unsuppressAtPostmark('a@x.com')
    expect(res.ok).toBe(0)
    expect(res.failed).toEqual([{ email: 'a@x.com', message: 'Nope' }])
  })

  it('never throws when fetch rejects mid-flight', async () => {
    stubFetch(async (url) => {
      if (String(url).includes('/suppressions/dump')) return dump([{ EmailAddress: 'a@x.com', SuppressionReason: 'ManualSuppression' }])
      throw new Error('ECONNRESET')
    })
    const res = await unsuppressAtPostmark('a@x.com')
    expect(res.ok).toBe(0)
    expect(res.failed).toEqual([{ email: 'a@x.com', message: 'ECONNRESET' }])
  })

  it('is a no-op for an empty address list', async () => {
    stubFetch(echo('Deleted'))
    expect(await unsuppressAtPostmark([])).toEqual({ ok: 0, failed: [], skipped: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
