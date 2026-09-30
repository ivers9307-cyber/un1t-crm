import { describe, it, expect } from 'vitest'
import { normaliseChatTurns } from './assistant-turns'

describe('normaliseChatTurns (STAFFASSISTPREFILL.1)', () => {
  it('keeps a well-formed alternating list as it is', () => {
    const turns = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]
    expect(normaliseChatTurns(turns)).toEqual({ messages: turns, reason: null })
  })

  it('drops leading assistant turns', () => {
    expect(normaliseChatTurns([
      { role: 'assistant', content: 'greeting' },
      { role: 'user', content: 'q' },
    ]).messages).toEqual([{ role: 'user', content: 'q' }])
  })

  it('merges consecutive same-role string turns', () => {
    expect(normaliseChatTurns([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]).messages).toEqual([{ role: 'user', content: 'a\n\nb' }])
  })

  it('merges block-array content by concatenating blocks', () => {
    expect(normaliseChatTurns([
      { role: 'user', content: 'a' },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
    ]).messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }])
  })

  it('drops empty and whitespace-only turns, and empty block arrays', () => {
    expect(normaliseChatTurns([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: [] },
      { role: 'user', content: 'b' },
    ]).messages).toEqual([{ role: 'user', content: 'a\n\nb' }])
  })

  it('a list ending on an assistant turn has nothing to answer', () => {
    expect(normaliseChatTurns([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ])).toEqual({ messages: [], reason: 'nothing_to_answer' })
  })

  it('a list with no user turn at all has nothing to answer', () => {
    expect(normaliseChatTurns([{ role: 'assistant', content: 'b' }])).toEqual({ messages: [], reason: 'nothing_to_answer' })
    expect(normaliseChatTurns([])).toEqual({ messages: [], reason: 'nothing_to_answer' })
    expect(normaliseChatTurns(null)).toEqual({ messages: [], reason: 'nothing_to_answer' })
  })

  it('never mutates its input', () => {
    const turns = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]
    const copy = JSON.parse(JSON.stringify(turns))
    normaliseChatTurns(turns)
    expect(turns).toEqual(copy)
  })
})
