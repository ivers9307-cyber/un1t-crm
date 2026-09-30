// MIAPREFILL.1 — buildReplyTurnMessages: the pure half of "never end a
// request on an assistant turn". The runner-level tests (the bytes that go to
// the API) are in auto-reply-request-shape.test.js.
import { describe, it, expect } from 'vitest'
import { buildReplyTurnMessages, isReplyWorthyInbound } from './core'

const at = (s) => `2026-09-25T08:41:${String(s).padStart(2, '0')}.000+00:00`
const inn = (body, s, type = 'text') => ({ direction: 'inbound', body, message_type: type, created_at: at(s) })
const out = (body, s, type = 'text') => ({ direction: 'outbound', body, message_type: type, created_at: at(s) })

// The request invariants the Messages API holds Sonnet 5 to.
function expectValidRequest(messages) {
  expect(messages.length).toBeGreaterThan(0)
  expect(messages[0].role).toBe('user')
  expect(messages.at(-1).role).toBe('user')
  for (let i = 1; i < messages.length; i++) {
    expect(messages[i].role).not.toBe(messages[i - 1].role)
  }
  for (const m of messages) expect(String(m.content).trim()).not.toBe('')
}

describe('isReplyWorthyInbound', () => {
  it('answers text and tapped buttons with content only', () => {
    expect(isReplyWorthyInbound(inn('hi', 1))).toBe(true)
    expect(isReplyWorthyInbound(inn('6pm', 1, 'interactive'))).toBe(true)
    expect(isReplyWorthyInbound(inn('Reacted: 👍', 1, 'reaction'))).toBe(false)
    expect(isReplyWorthyInbound(inn('', 1, 'image'))).toBe(false)
    expect(isReplyWorthyInbound(inn('a caption', 1, 'image'))).toBe(false)
    expect(isReplyWorthyInbound(inn('   ', 1))).toBe(false)
    expect(isReplyWorthyInbound(out('hi', 1))).toBe(false)
    expect(isReplyWorthyInbound(null)).toBe(false)
  })
})

describe('buildReplyTurnMessages', () => {
  it('a normal turn (newest row inbound) is the formatted history, unchanged', () => {
    const { messages, reason } = buildReplyTurnMessages([inn('hi', 1), out('hello', 2), inn('6pm?', 3)])
    expect(reason).toBeNull()
    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: '6pm?' },
    ])
  })

  it('newest row outbound on a first pass → nothing_to_answer, no messages (the STOP acknowledgement)', () => {
    const r = buildReplyTurnMessages([inn('hi', 1), out('hello', 2), inn('STOP', 3), out('You have been unsubscribed.', 4)])
    expect(r).toEqual({ messages: [], reason: 'nothing_to_answer' })
  })

  it('only outbound rows → no_history (unchanged meaning)', () => {
    expect(buildReplyTurnMessages([out('Hi Sam', 1), out('You there?', 2)])).toEqual({ messages: [], reason: 'no_history' })
    expect(buildReplyTurnMessages([])).toEqual({ messages: [], reason: 'no_history' })
  })

  it('rerun: the missed inbound moves after Mia\'s reply (A, B-late, R → A, R, B)', () => {
    const rows = [inn('class at 6pm?', 36), inn('and tomorrow?', 38), out('Yes, 6pm has space.', 42)]
    const { messages, reason } = buildReplyTurnMessages(rows, { answeredThroughIso: at(36) })
    expect(reason).toBeNull()
    expect(messages).toEqual([
      { role: 'user', content: 'class at 6pm?' },
      { role: 'assistant', content: 'Yes, 6pm has space.' },
      { role: 'user', content: 'and tomorrow?' },
    ])
  })

  it('rerun: two missed messages stay in their own order, merged into one user turn', () => {
    const rows = [inn('A', 30), inn('B', 31), inn('C', 32), out('R', 35)]
    const { messages } = buildReplyTurnMessages(rows, { answeredThroughIso: at(30) })
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'B\nC' })
    expect(messages.at(-2)).toEqual({ role: 'assistant', content: 'R' })
  })

  it('rerun: a reaction that landed mid-turn is NOT moved and is not a reason to answer', () => {
    const rows = [inn('A', 30), inn('Reacted: 👍', 31, 'reaction'), out('R', 35)]
    expect(buildReplyTurnMessages(rows, { answeredThroughIso: at(30) })).toEqual({ messages: [], reason: 'nothing_to_answer' })
  })

  it('rerun: sub-millisecond ordering is kept (microsecond created_at strings)', () => {
    const rows = [
      { ...inn('A', 0), created_at: '2026-09-25T08:41:40.123456+00:00' },
      { ...inn('B', 0), created_at: '2026-09-25T08:41:40.123789+00:00' },
      out('R', 45),
    ]
    const { messages } = buildReplyTurnMessages(rows, { answeredThroughIso: '2026-09-25T08:41:40.123456+00:00' })
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'B' })
  })

  it('never returns a request that breaks the invariants, for every history of up to 6 rows', () => {
    const kinds = [
      (s) => inn('hi', s),
      (s) => inn('', s, 'image'),
      (s) => inn('Reacted: 👍', s, 'reaction'),
      (s) => out('reply', s),
      (s) => out('', s, 'template'),
    ]
    let checked = 0
    const walk = (prefix) => {
      if (prefix.length) {
        for (const answeredThroughIso of [null, at(prefix.length > 1 ? 1 : 0)]) {
          const { messages, reason } = buildReplyTurnMessages(prefix, { answeredThroughIso })
          if (reason) expect(messages).toEqual([])
          else expectValidRequest(messages)
          checked++
        }
      }
      if (prefix.length === 6) return
      for (const k of kinds) walk([...prefix, k(prefix.length + 1)])
    }
    walk([])
    expect(checked).toBeGreaterThan(19000)
  })
})
