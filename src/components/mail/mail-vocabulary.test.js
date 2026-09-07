// MAIL-REPLY-QUOTE.1 — the collapsed line previews what the person WROTE.
//
// A reply is mostly the mail it is replying to. A snippet built from the raw
// body therefore reads back the previous message, so every line in a long
// thread previews the same words — the list stops telling you anything.
import { describe, it, expect } from 'vitest'
import { messageSnippet } from './mail-vocabulary'

describe('messageSnippet — quoted text excluded (MAIL-REPLY-QUOTE.1)', () => {
  it('previews only the words above the quote', () => {
    expect(messageSnippet({
      text_body: 'Yes, 7 is fine.\n\nOn Mon 7 Sep 2026 at 13:34, A <a@b.c> wrote:\n> can I move',
    })).toBe('Yes, 7 is fine.')
  })

  it('is unchanged for a body with nothing quoted', () => {
    expect(messageSnippet({ text_body: 'Plain enough.' })).toBe('Plain enough.')
  })

  it('is empty for a message with no text at all', () => {
    expect(messageSnippet({})).toBe('')
  })
})
