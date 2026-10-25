// W0.14 — Instagram webhook retry contract.
//
// The route claims a per-message dedup row (webhook_events) BEFORE calling
// handleInstagramInbound. If the handler then fails (e.g. the
// channel_connections lookup errored), the claim must be released and the
// route must answer non-2xx so Meta retries; otherwise the retry
// short-circuits on `seen` and the message is lost for good. A handler
// that succeeds keeps the claim and answers 200. Parse-level failures
// (parseInstagramEvents throwing) still answer 200.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// Real parser, mocked handler — the route + dedup lib pair is the contract
// under test, not the handler's IO.
vi.mock('@/lib/agent/instagram', async (importOriginal) => ({
  ...(await importOriginal()),
  handleInstagramInbound: vi.fn(),
}))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { handleInstagramInbound } from '@/lib/agent/instagram'

const SECRET = 'test-app-secret'

// Recording fake supabase client. webhook-events (REAL) does
//   db.from('webhook_events').insert({...})              → awaited builder
//   db.from('webhook_events').delete().eq(..).eq(..)     → awaited builder
// so every terminal await is recorded with the ops chain that led to it.
function makeDb(handlers = {}) {
  const calls = []
  const from = vi.fn((table) => {
    const ops = []
    const finish = (terminal) => {
      calls.push({ table, ops, terminal })
      const h = handlers[table]
      return (typeof h === 'function' ? h(ops, terminal) : h) || { data: null, error: null }
    }
    const b = {}
    for (const m of ['select', 'eq', 'limit', 'insert', 'update', 'upsert', 'delete']) {
      b[m] = (...args) => { ops.push([m, ...args]); return b }
    }
    b.single = async () => finish('single')
    b.maybeSingle = async () => finish('maybeSingle')
    b.then = (onFulfilled, onRejected) => Promise.resolve(finish('await')).then(onFulfilled, onRejected)
    return b
  })
  const db = { from, calls }
  db.opsOn = (table, op) => calls.filter((c) => c.table === table && c.ops.some(([m]) => m === op))
  return db
}

function signedRequest(body) {
  const raw = JSON.stringify(body)
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex')
  return { text: async () => raw, headers: { get: (h) => (h === 'x-hub-signature-256' ? sig : null) } }
}

function igEnvelope(mid, { accountId = 'ig-acct-1', senderId = 'cust-1', text = 'hi' } = {}) {
  return {
    object: 'instagram',
    entry: [{
      id: accountId,
      time: 1770000000,
      messaging: [{
        sender: { id: senderId },
        recipient: { id: accountId },
        timestamp: 1770000000,
        message: { mid, text },
      }],
    }],
  }
}

let db
let errSpy

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INSTAGRAM_APP_SECRET = SECRET
  db = makeDb()
  createServerClient.mockReturnValue(db)
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errSpy.mockRestore()
  delete process.env.INSTAGRAM_APP_SECRET
})

describe('Instagram webhook — handler failure releases the dedup claim', () => {
  it('handler throws → 500, dedup row for msg:<mid> deleted, envelope not marked handled', async () => {
    handleInstagramInbound.mockRejectedValueOnce(new Error('channel_connections lookup failed: boom'))

    const res = await POST(signedRequest(igEnvelope('mid-fail')))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'retry' })

    // The claim was taken…
    const inserts = db.opsOn('webhook_events', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].ops).toContainEqual(['insert', { provider: 'instagram', event_id: 'msg:mid-fail' }])

    // …and then released for exactly that (provider, event_id).
    const deletes = db.opsOn('webhook_events', 'delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].ops).toEqual([
      ['delete'],
      ['eq', 'provider', 'instagram'],
      ['eq', 'event_id', 'msg:mid-fail'],
    ])
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('releasing dedup for retry'),
      expect.stringContaining('lookup failed'),
    )
  })

  it('handler succeeds → 200 and the claim is kept (no delete)', async () => {
    handleInstagramInbound.mockResolvedValueOnce({ handled: true })

    const res = await POST(signedRequest(igEnvelope('mid-ok')))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(handleInstagramInbound).toHaveBeenCalledTimes(1)
    expect(db.opsOn('webhook_events', 'insert')).toHaveLength(1)
    expect(db.opsOn('webhook_events', 'delete')).toHaveLength(0)
  })

  it('handler returns unmatched_account (genuinely unknown account) → 200, claim kept', async () => {
    handleInstagramInbound.mockResolvedValueOnce({ handled: false, reason: 'unmatched_account' })

    const res = await POST(signedRequest(igEnvelope('mid-unknown')))

    expect(res.status).toBe(200)
    expect(db.opsOn('webhook_events', 'delete')).toHaveLength(0)
  })

  it('a failure on the second of two messages releases only that message and stops', async () => {
    handleInstagramInbound
      .mockResolvedValueOnce({ handled: true })
      .mockRejectedValueOnce(new Error('channel_connections lookup failed: boom'))

    const body = igEnvelope('mid-1')
    body.entry[0].messaging.push({
      sender: { id: 'cust-2' }, recipient: { id: 'ig-acct-1' }, timestamp: 1770000001,
      message: { mid: 'mid-2', text: 'second' },
    })
    const res = await POST(signedRequest(body))

    expect(res.status).toBe(500)
    expect(handleInstagramInbound).toHaveBeenCalledTimes(2)
    expect(db.opsOn('webhook_events', 'insert')).toHaveLength(2)
    const deletes = db.opsOn('webhook_events', 'delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].ops).toContainEqual(['eq', 'event_id', 'msg:mid-2'])
  })

  it('already-seen message → handler skipped, 200, nothing released', async () => {
    db = makeDb({
      webhook_events: (ops) => (ops.some(([m]) => m === 'insert')
        ? { data: null, error: { code: '23505', message: 'duplicate key' } }
        : { data: null, error: null }),
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(signedRequest(igEnvelope('mid-dupe')))

    expect(res.status).toBe(200)
    expect(handleInstagramInbound).not.toHaveBeenCalled()
    expect(db.opsOn('webhook_events', 'delete')).toHaveLength(0)
  })

  it('parse-level failure still answers 200 (no retry storm)', async () => {
    // A body whose `entry` is not iterable makes the (real) parser throw;
    // the outer try/catch must keep the 200 posture.
    const res = await POST(signedRequest({ object: 'instagram', entry: 42 }))
    expect(res.status).toBe(200)
    expect(handleInstagramInbound).not.toHaveBeenCalled()
    expect(db.opsOn('webhook_events', 'delete')).toHaveLength(0)
  })

  it('bad signature → 403, nothing touched', async () => {
    const raw = JSON.stringify(igEnvelope('mid-x'))
    const req = { text: async () => raw, headers: { get: () => 'sha256=' + '0'.repeat(64) } }
    const res = await POST(req)
    expect(res.status).toBe(403)
    expect(db.calls).toHaveLength(0)
    expect(handleInstagramInbound).not.toHaveBeenCalled()
  })
})
