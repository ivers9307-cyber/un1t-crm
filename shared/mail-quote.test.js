import { describe, it, expect } from 'vitest'
import { splitQuotedText } from './mail-quote.js'

describe('splitQuotedText', () => {
  it('returns the whole text as body when nothing is quoted', () => {
    expect(splitQuotedText('Hello\n\nThanks,\nJordan')).toEqual({ body: 'Hello\n\nThanks,\nJordan', quoted: '' })
  })

  it('splits at a one-line attribution', () => {
    const text = 'Sounds good.\n\nOn Mon 7 Sep 2026 at 13:34, Jordan Sample <jordan@example.test> wrote:\n> test\n> more'
    expect(splitQuotedText(text)).toEqual({
      body: 'Sounds good.',
      quoted: 'On Mon 7 Sep 2026 at 13:34, Jordan Sample <jordan@example.test> wrote:\n> test\n> more',
    })
  })

  it("splits at Gmail's wrapped attribution (address on the next line), with no blank line before it", () => {
    const text = 'Test test 2\nOn Mon 7 Sep 2026 at 13:33 Hatch Street Fitness Accounts <\naccounts@hatchstreetfitness.com> wrote:\n\n> test\n> RI'
    const out = splitQuotedText(text)
    expect(out.body).toBe('Test test 2')
    expect(out.quoted.startsWith('On Mon 7 Sep 2026 at 13:33 Hatch Street Fitness Accounts <\naccounts@')).toBe(true)
  })

  it('does not treat a sentence starting with "On" as an attribution when no "wrote:" follows within two lines', () => {
    const text = 'On Monday we open at 6.\nSee you then.\nCheers'
    expect(splitQuotedText(text)).toEqual({ body: text, quoted: '' })
  })

  it('splits at the first run of > lines when there is no attribution', () => {
    const text = 'Yes.\n\n> can we move to 7?\n> thanks'
    expect(splitQuotedText(text)).toEqual({ body: 'Yes.', quoted: '> can we move to 7?\n> thanks' })
  })

  it('splits at the forwarded-message separator (ours and Gmail\'s)', () => {
    expect(splitQuotedText('FYI\n\n---------- Forwarded message ----------\nFrom: a@b.c').body).toBe('FYI')
    expect(splitQuotedText('FYI\n---------- Forwarded message ---------\nFrom: a@b.c').body).toBe('FYI')
  })

  it("splits at Outlook's Original Message separator", () => {
    expect(splitQuotedText('Ok\n\n-----Original Message-----\nFrom: x').body).toBe('Ok')
  })

  it("splits at Outlook desktop's underscore rule followed by From:", () => {
    const text = 'Ok\n\n________________________________\nFrom: Colm <colm@x.ie>\nSent: Monday'
    expect(splitQuotedText(text).body).toBe('Ok')
    expect(splitQuotedText(text).quoted.startsWith('________________________________\nFrom:')).toBe(true)
  })

  it('does not split at a signature delimiter', () => {
    const text = 'Thanks\n\n-- \nJordan Sample\nUN1T'
    expect(splitQuotedText(text)).toEqual({ body: text, quoted: '' })
  })

  it('keeps the signature in the body when a quote follows it', () => {
    const text = 'Thanks\n\n-- \nJordan\n\nOn Mon 7 Sep 2026 at 13:34, A <a@b.c> wrote:\n> hi'
    expect(splitQuotedText(text).body).toBe('Thanks\n\n-- \nJordan')
  })

  it('normalises CRLF and trims trailing blank lines off the body', () => {
    expect(splitQuotedText('Hi\r\n\r\n> a\r\n')).toEqual({ body: 'Hi', quoted: '> a' })
  })

  it('never throws on non-string input', () => {
    expect(splitQuotedText(null)).toEqual({ body: '', quoted: '' })
    expect(splitQuotedText(undefined)).toEqual({ body: '', quoted: '' })
    expect(splitQuotedText(42)).toEqual({ body: '', quoted: '' })
  })
})

describe('splitQuotedText — a message that is only a quote is not split', () => {
  it('keeps a message whose first line the writer opened with ">" as the body', () => {
    const text = '> checklist item one\nDone, see above.'
    expect(splitQuotedText(text)).toEqual({ body: text, quoted: '' })
  })
  it('keeps a bare quoted chain as the body rather than an empty message', () => {
    const text = 'On Mon 7 Sep 2026 at 13:34, A <a@b.c> wrote:\n> hi'
    expect(splitQuotedText(text)).toEqual({ body: text, quoted: '' })
  })
})
