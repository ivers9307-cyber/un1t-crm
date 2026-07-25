import { describe, it, expect } from 'vitest'
import { buildSuggestionInstruction, sanitizeSuggestion } from './approval-suggest.js'

describe('buildSuggestionInstruction', () => {
  it('includes the kind and outcome', () => {
    const instr = buildSuggestionInstruction('pause', 'approved', {})
    expect(instr).toMatch(/pause their membership/)
    expect(instr).toMatch(/approved/)
  })

  it('includes the customer first name when given', () => {
    const instr = buildSuggestionInstruction('cancellation', 'saved', { firstName: 'Aoife' })
    expect(instr).toMatch(/Aoife/)
  })

  it('includes the decision reason when given', () => {
    const instr = buildSuggestionInstruction('class_cancellation', 'approved', { reason: 'injured knee' })
    expect(instr).toMatch(/injured knee/)
  })

  it('includes membership status and next class when given', () => {
    const instr = buildSuggestionInstruction('class_booking', 'actioned', {
      membershipStatus: 'active',
      nextClassName: 'HYROX',
      nextClassTime: '2026-07-10T09:00:00.000Z',
    })
    expect(instr).toMatch(/active/)
    expect(instr).toMatch(/HYROX/)
    expect(instr).toMatch(/2026-07-10T09:00:00.000Z/)
  })

  it('omits optional context lines when absent', () => {
    const instr = buildSuggestionInstruction('pause', 'declined', {})
    expect(instr).not.toMatch(/Their stated reason/)
    expect(instr).not.toMatch(/Their first name/)
    expect(instr).not.toMatch(/next booked class/)
  })

  it('asks for a short, warm, first-person, ≤2 sentence follow-up with [[SKIP]] escape', () => {
    const instr = buildSuggestionInstruction('cancellation', 'declined', {})
    expect(instr).toMatch(/first person/)
    expect(instr).toMatch(/≤2 sentences/)
    expect(instr).toMatch(/\[\[SKIP\]\]/)
    expect(instr).toMatch(/No placeholders or brackets/)
  })

  it('handles an unknown kind/outcome gracefully (falls back to the raw string)', () => {
    const instr = buildSuggestionInstruction('mystery_kind', 'mystery_outcome', {})
    expect(instr).toMatch(/mystery_kind/)
    expect(instr).toMatch(/mystery_outcome/)
  })
})

describe('sanitizeSuggestion', () => {
  it('returns null for falsy input', () => {
    expect(sanitizeSuggestion(null)).toBeNull()
    expect(sanitizeSuggestion(undefined)).toBeNull()
    expect(sanitizeSuggestion('')).toBeNull()
  })

  it('returns null for whitespace-only text', () => {
    expect(sanitizeSuggestion('   \n\t  ')).toBeNull()
  })

  it('returns null when the text contains [[SKIP]]', () => {
    expect(sanitizeSuggestion('[[SKIP]]')).toBeNull()
    expect(sanitizeSuggestion('  [[SKIP]]  ')).toBeNull()
    expect(sanitizeSuggestion('Some preamble [[SKIP]] trailing')).toBeNull()
    // …and its near misses, matched as leniently as the other sentinels.
    expect(sanitizeSuggestion('[[skip]]')).toBeNull()
    expect(sanitizeSuggestion('[[ SKIP ]]')).toBeNull()
  })

  // HUMANIZE.1 — staff click this straight into the composer and usually send
  // it unedited, so it gets the same deterministic treatment as a live reply.
  it('scrubs em dashes the model emitted', () => {
    expect(sanitizeSuggestion("All sorted — you're back on for Saturday."))
      .toBe("All sorted, you're back on for Saturday.")
  })
  it('strips a stray [[OPTIONS]] line instead of prefilling the raw sentinel', () => {
    expect(sanitizeSuggestion('Want another slot?\n[[OPTIONS]] Yes | No'))
      .toBe('Want another slot?')
  })
  it('returns null for a suggestion that is really a handoff', () => {
    expect(sanitizeSuggestion('[[HANDOFF]] wants to talk to a person')).toBeNull()
    expect(sanitizeSuggestion('Sorry about that. [[HANDOFF]] upset customer')).toBeNull()
  })

  it('trims surrounding whitespace on an otherwise good message', () => {
    expect(sanitizeSuggestion('  Great news! See you soon.  ')).toBe('Great news! See you soon.')
  })

  it('strips surrounding straight quotes when the whole message is quoted', () => {
    expect(sanitizeSuggestion('"Great news! See you soon."')).toBe('Great news! See you soon.')
  })

  it('strips surrounding curly quotes when the whole message is quoted', () => {
    expect(sanitizeSuggestion('“Great news! See you soon.”')).toBe('Great news! See you soon.')
  })

  it('does not strip quotes that are not surrounding the entire message', () => {
    const text = 'She said "hi" to me'
    expect(sanitizeSuggestion(text)).toBe(text)
  })

  it('caps at 500 chars, truncating at the last word boundary', () => {
    const long = 'word '.repeat(200).trim() // 999 chars
    const out = sanitizeSuggestion(long)
    expect(out.length).toBeLessThanOrEqual(500)
    // truncated at a word boundary — no partial word at the end
    expect(long.startsWith(out)).toBe(true)
    expect(out.endsWith(' ')).toBe(false)
  })

  it('leaves short text under the cap untouched', () => {
    expect(sanitizeSuggestion('Short and sweet.')).toBe('Short and sweet.')
  })
})
