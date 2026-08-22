// MIA-HYGIENE.6 — Meta rejects a WhatsApp text body over 4096 chars and an
// Instagram DM over 1000. Nothing clamped either: sendTextMessage posted the
// body verbatim. Normal agent replies (max_tokens 600) are far under, but the
// truncation-retry path re-runs at 1000 tokens, and the proactive paths render
// operator-authored copy — either can cross the line, and the failure mode is
// a thrown send, which reads to the customer as dead air.
import { describe, it, expect } from 'vitest'
import { splitMessageText } from './message-split'

describe('splitMessageText', () => {
  it('leaves a short message as a single part', () => {
    expect(splitMessageText('Sure, what day suits?', 4096)).toEqual(['Sure, what day suits?'])
  })

  it('treats an exactly-at-limit message as one part', () => {
    const text = 'x'.repeat(100)
    expect(splitMessageText(text, 100)).toEqual([text])
  })

  it('never emits a part longer than the limit', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} in a long reply.`).join(' ')
    for (const part of splitMessageText(text, 200)) {
      expect(part.length).toBeLessThanOrEqual(200)
    }
  })

  it('prefers a paragraph boundary when one is available', () => {
    const first = 'a'.repeat(120)
    const second = 'b'.repeat(120)
    expect(splitMessageText(`${first}\n\n${second}`, 200)).toEqual([first, second])
  })

  it('falls back to a sentence boundary when there is no paragraph break', () => {
    const first = `${'a'.repeat(118)}.`
    const second = `${'b'.repeat(118)}.`
    const parts = splitMessageText(`${first} ${second}`, 200)
    expect(parts[0]).toBe(first)
    expect(parts[1]).toBe(second)
  })

  it('falls back to a word boundary when there is no sentence break', () => {
    const parts = splitMessageText(`${'a'.repeat(150)} ${'b'.repeat(150)}`, 200)
    expect(parts[0]).toBe('a'.repeat(150))
    expect(parts[1]).toBe('b'.repeat(150))
  })

  it('hard-cuts a single unbroken run rather than exceeding the limit', () => {
    const parts = splitMessageText('z'.repeat(450), 200)
    expect(parts).toHaveLength(3)
    expect(parts[0]).toHaveLength(200)
    expect(parts.join('')).toBe('z'.repeat(450))
  })

  it('loses no words across a split', () => {
    const text = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const rejoined = splitMessageText(text, 150).join(' ')
    expect(rejoined.split(/\s+/)).toEqual(text.split(/\s+/))
  })

  it('handles empty and nullish input without throwing', () => {
    expect(splitMessageText('', 4096)).toEqual([''])
    expect(splitMessageText(null, 4096)).toEqual([''])
    expect(splitMessageText(undefined, 4096)).toEqual([''])
  })
})
