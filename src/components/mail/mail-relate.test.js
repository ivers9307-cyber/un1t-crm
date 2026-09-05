// MAIL-REFINE.1 (03) — relating conversations: the pure half.
//
// The related endpoint, the nudge copy, the merge picker's candidate lines and
// the sequential merge/unmerge executors all live in mail-relate.js so the
// component (MailThread) stays thin and every decision an operator feels is
// unit-tested without rendering anything.
//
// 🔴 THE TWO RULES THAT MUST NEVER REGRESS, both pinned hard here:
//   • a FAILED related read must never look like "no related conversations" —
//     parseRelated answers null for anything malformed, and null renders no
//     banner rather than a confidently-empty one;
//   • a FAILED merge must never look merged — the executor stops on the first
//     failure, reports exactly which ids DID merge, and names the one that
//     did not.

import { describe, it, expect, vi } from 'vitest'
import {
  relatedUrl,
  parseRelated,
  isOpenRelated,
  newestOpenRelated,
  relatedNudge,
  candidateLine,
  mergeButtonLabel,
  mergeConversations,
  unmergeConversations,
} from './mail-relate'

const NOW = Date.parse('2026-08-31T12:00:00Z')

const REL = (over = {}) => ({
  id: 'r-1',
  subject: 'RE: Meter reading — urgent',
  status: 'open',
  message_count: 2,
  last_message_at: '2026-08-28T12:00:00Z', // 3d before NOW
  requester_name: 'Jordan Sample',
  ...over,
})

describe('relatedUrl', () => {
  it('builds the pinned route for a conversation', () => {
    expect(relatedUrl('abc-123')).toBe('/api/email/mail/abc-123/related')
  })

  it('encodes the id — it is interpolated into a path', () => {
    expect(relatedUrl('a/b?c')).toBe('/api/email/mail/a%2Fb%3Fc/related')
  })
})

describe('parseRelated — a failure is never an empty list', () => {
  it('accepts the contract shape', () => {
    const body = { success: true, data: { related: [REL()], open_count: 1 } }
    expect(parseRelated(body)).toEqual({ related: [REL()], openCount: 1 })
  })

  it('accepts an honest empty answer', () => {
    expect(parseRelated({ success: true, data: { related: [], open_count: 0 } }))
      .toEqual({ related: [], openCount: 0 })
  })

  // Every malformed shape collapses to null — the caller renders NOTHING for
  // null, which is the only honest render for "we do not know".
  it('answers null for a failed response', () => {
    expect(parseRelated({ success: false, error: 'nope' })).toBeNull()
    // …including one that carries a data payload beside its failure flag —
    // the flag is the verdict, not the shape.
    expect(parseRelated({ success: false, data: { related: [REL()], open_count: 1 } })).toBeNull()
  })

  it('answers null when data or the list is missing or not a list', () => {
    expect(parseRelated(null)).toBeNull()
    expect(parseRelated({})).toBeNull()
    expect(parseRelated({ success: true })).toBeNull()
    expect(parseRelated({ success: true, data: {} })).toBeNull()
    expect(parseRelated({ success: true, data: { related: 'no', open_count: 1 } })).toBeNull()
  })

  it('drops list entries with no id rather than rendering unopenable rows', () => {
    const body = { success: true, data: { related: [REL(), null, { subject: 'x' }], open_count: 1 } }
    expect(parseRelated(body).related).toEqual([REL()])
  })

  it('treats a non-numeric open_count as 0 — an unknown count must never nudge', () => {
    expect(parseRelated({ success: true, data: { related: [REL()], open_count: 'many' } }).openCount).toBe(0)
  })
})

describe('newestOpenRelated — where View goes', () => {
  it('picks the first open item — the list arrives newest-first per the contract', () => {
    const older = REL({ id: 'r-old' })
    const newest = REL({ id: 'r-new' })
    expect(newestOpenRelated([newest, older])).toBe(newest)
  })

  it('skips archived rows — View targets an OPEN conversation', () => {
    const archived = REL({ id: 'r-arch', status: 'closed' })
    const open = REL({ id: 'r-open' })
    expect(newestOpenRelated([archived, open])).toBe(open)
    expect(isOpenRelated(archived)).toBe(false)
    expect(isOpenRelated(open)).toBe(true)
  })

  it('answers null when nothing open is left', () => {
    expect(newestOpenRelated([REL({ status: 'closed' })])).toBeNull()
    expect(newestOpenRelated([])).toBeNull()
    expect(newestOpenRelated(undefined)).toBeNull()
  })
})

describe('relatedNudge — when the banner earns its place', () => {
  it('nudges when at least one related conversation is open', () => {
    const parsed = { related: [REL()], openCount: 1 }
    expect(relatedNudge(parsed, 'Jordan Sample')).toEqual({
      name: 'Jordan Sample',
      count: 1,
      label: '1 other open conversation',
      viewId: 'r-1',
    })
  })

  it('pluralises', () => {
    const parsed = { related: [REL({ id: 'a' }), REL({ id: 'b' })], openCount: 2 }
    expect(relatedNudge(parsed, 'Jordan Sample').label).toBe('2 other open conversations')
  })

  it('stays quiet with zero open — archived-only relatives are picker material, not a nudge', () => {
    expect(relatedNudge({ related: [REL({ status: 'closed' })], openCount: 0 }, 'C')).toBeNull()
  })

  it('stays quiet on a failed read (null parse)', () => {
    expect(relatedNudge(null, 'C')).toBeNull()
  })

  it('never renders a nameless nudge', () => {
    expect(relatedNudge({ related: [REL()], openCount: 1 }, '').name).toBe('This sender')
  })
})

describe('candidateLine — the picker row description', () => {
  it('describes an open conversation', () => {
    expect(candidateLine(REL(), NOW)).toBe('Jordan Sample · 2 messages · opened 3d')
  })

  it('describes an archived one as archived — the surface never says closed', () => {
    expect(candidateLine(REL({ status: 'closed', message_count: 5, last_message_at: '2026-08-12T10:00:00Z' }), NOW))
      .toBe('Jordan Sample · 5 messages · archived 12 Aug')
  })

  it('singularises one message', () => {
    expect(candidateLine(REL({ message_count: 1 }), NOW)).toContain('1 message ·')
  })

  it('degrades honestly with no name, no count, no timestamp', () => {
    expect(candidateLine({ id: 'x', status: 'open' }, NOW)).toBe('Unknown sender · opened')
  })
})

describe('mergeButtonLabel', () => {
  it('counts what it is about to do', () => {
    expect(mergeButtonLabel(1)).toBe('Merge 1 conversation')
    expect(mergeButtonLabel(2)).toBe('Merge 2 conversations')
  })
  it('says just Merge with nothing selected (the button is disabled anyway)', () => {
    expect(mergeButtonLabel(0)).toBe('Merge')
  })
})

// ── the executors ─────────────────────────────────────────────────────

const okResponse = { ok: true, json: async () => ({ success: true }) }
const failBody = (error) => ({ ok: true, json: async () => ({ success: false, error }) })

describe('mergeConversations — sequential, stop on first failure', () => {
  it('POSTs each id to the merge route with {into}, in order', async () => {
    const fetchImpl = vi.fn(async () => okResponse)
    const result = await mergeConversations({ ids: ['a', 'b'], into: 'target', fetchImpl })
    expect(result).toEqual({ merged: ['a', 'b'], failed: null })
    expect(fetchImpl.mock.calls.map(c => c[0])).toEqual([
      '/api/email/tickets/a/merge',
      '/api/email/tickets/b/merge',
    ])
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body)).toEqual({ into: 'target' })
      expect(init.headers['Content-Type']).toBe('application/json')
    }
  })

  // 🔴 A failed merge must never look merged.
  it('stops at the first failure and names it, keeping what genuinely merged', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okResponse)
      .mockResolvedValueOnce(failBody('That conversation is already merged'))
    const result = await mergeConversations({ ids: ['a', 'b', 'c'], into: 't', fetchImpl })
    expect(result.merged).toEqual(['a'])
    expect(result.failed).toEqual({ id: 'b', error: 'That conversation is already merged' })
    // c was never attempted — stopping IS the contract.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('treats a non-ok HTTP status as the failure it is', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    const result = await mergeConversations({ ids: ['a'], into: 't', fetchImpl })
    expect(result.merged).toEqual([])
    expect(result.failed.id).toBe('a')
    expect(result.failed.error).toBeTruthy()
  })

  it('needs BOTH halves of the verdict — a non-ok status with a success body is still a failure', async () => {
    // An error page that happens to echo success-shaped JSON (a proxy's 502
    // body, a cached response) must not count as a merge.
    const fetchImpl = vi.fn(async () => ({ ok: false, json: async () => ({ success: true }) }))
    const result = await mergeConversations({ ids: ['a'], into: 't', fetchImpl })
    expect(result.merged).toEqual([])
    expect(result.failed.id).toBe('a')
  })

  it('treats a network throw as a failure, not a success and not an exception', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline') })
    const result = await mergeConversations({ ids: ['a', 'b'], into: 't', fetchImpl })
    expect(result.merged).toEqual([])
    expect(result.failed.id).toBe('a')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('treats an unreadable success body as a failure — a 200 with no verdict proves nothing', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => { throw new Error('bad json') } }))
    const result = await mergeConversations({ ids: ['a'], into: 't', fetchImpl })
    expect(result.failed.id).toBe('a')
  })

  it('encodes ids into the path', async () => {
    const fetchImpl = vi.fn(async () => okResponse)
    await mergeConversations({ ids: ['a/b'], into: 't', fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/email/tickets/a%2Fb/merge')
  })

  it('merges nothing when handed nothing', async () => {
    const fetchImpl = vi.fn()
    expect(await mergeConversations({ ids: [], into: 't', fetchImpl })).toEqual({ merged: [], failed: null })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('unmergeConversations — the toast Undo', () => {
  it('DELETEs each merge, in order', async () => {
    const fetchImpl = vi.fn(async () => okResponse)
    const result = await unmergeConversations({ ids: ['a', 'b'], fetchImpl })
    expect(result).toEqual({ unmerged: ['a', 'b'], failed: null })
    expect(fetchImpl.mock.calls.map(c => [c[0], c[1].method])).toEqual([
      ['/api/email/tickets/a/merge', 'DELETE'],
      ['/api/email/tickets/b/merge', 'DELETE'],
    ])
  })

  it('stops on the first failure and says which ids DID come back', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okResponse)
      .mockResolvedValueOnce(failBody('gone'))
    const result = await unmergeConversations({ ids: ['a', 'b', 'c'], fetchImpl })
    expect(result.unmerged).toEqual(['a'])
    expect(result.failed).toEqual({ id: 'b', error: 'gone' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
