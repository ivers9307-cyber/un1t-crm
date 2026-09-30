// MIAPREFILL.1 — buildReplyTurnMessages: the pure half of "never end a
// request on an assistant turn". The runner-level tests (the bytes that go to
// the API) are in auto-reply-request-shape.test.js.
import { describe, it, expect } from 'vitest'
import { buildReplyTurnMessages, isReplyWorthyInbound } from './core'

const at = (s) => `2026-09-25T08:41:${String(s).padStart(2, '0')}.000+00:00`
const inn = (body, s, type = 'text') => ({ direction: 'inbound', body, message_type: type, created_at: at(s) })
const out = (body, s, type = 'text') => ({ direction: 'outbound', body, message_type: type, created_at: at(s) })
const agentOut = (body, s) => ({ ...out(body, s), source: 'agent' })
// A generic business auto-responder (no real business named: the repo is public).
const AUTO_RESPONDER = 'Thanks for your message. This is an automated reply: we are closed right now and will get back to you as soon as we can.'

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

  it('a business auto-responder is not reply-worthy (the same AGENT-BOTLOOP.1 gate as a live message)', () => {
    expect(isReplyWorthyInbound(inn(AUTO_RESPONDER, 1))).toBe(false)
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
    expect(r).toMatchObject({ messages: [], reason: 'nothing_to_answer' })
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

  it('rerun: the missed message goes right after the FIRST pass\'s reply, so a later Mia reply that already followed it is not answered twice ([A, B, R, R2])', () => {
    const rows = [inn('A', 30), inn('B', 31), agentOut('R', 35), agentOut('R2', 40)]
    expect(buildReplyTurnMessages(rows, { answeredThroughIso: at(30) })).toMatchObject({ messages: [], reason: 'nothing_to_answer' })
  })

  it('rerun: the first pass\'s reply is the first AGENT row after what it answered, not a staff or automation send before it', () => {
    const rows = [inn('A', 30), inn('B', 31), { ...out('staff note', 33), source: 'manual' }, agentOut('R', 35)]
    const { messages, reason } = buildReplyTurnMessages(rows, { answeredThroughIso: at(30) })
    expect(reason).toBeNull()
    expect(messages.at(-2)).toEqual({ role: 'assistant', content: 'staff note\nR' })
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'B' })
  })

  it('rerun: a business auto-responder that landed mid-turn is not moved and is not a reason to answer', () => {
    const rows = [inn('A', 30), inn(AUTO_RESPONDER, 31), agentOut('R', 35)]
    expect(buildReplyTurnMessages(rows, { answeredThroughIso: at(30) })).toMatchObject({ messages: [], reason: 'nothing_to_answer' })
  })

  it('nothing_to_answer names the trailing row by source and type only, never its body', () => {
    const r = buildReplyTurnMessages([inn('STOP', 1), out('You have been unsubscribed.', 2)])
    expect(r.trailing).toEqual({ source: null, message_type: 'text' })
    expect(JSON.stringify(r)).not.toContain('unsubscribed')
    expect(buildReplyTurnMessages([inn('hi', 1), agentOut('hello', 2)]).trailing).toEqual({ source: 'agent', message_type: 'text' })
  })

  it('rerun: a reaction that landed mid-turn is NOT moved and is not a reason to answer', () => {
    const rows = [inn('A', 30), inn('Reacted: 👍', 31, 'reaction'), out('R', 35)]
    expect(buildReplyTurnMessages(rows, { answeredThroughIso: at(30) })).toMatchObject({ messages: [], reason: 'nothing_to_answer' })
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
