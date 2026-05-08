// Postmark merge-tag tests. The `applyMergeTags` function is one
// of the highest-traffic pure functions in the codebase — every
// transactional email + every campaign + every sequence step renders
// through it. The audit (item 4.2) flagged postmark.js as a top-
// priority untested integration boundary; the merge-tag function is
// the safest piece to lock down first because:
//   - it's pure (string in, string out, no side effects)
//   - a regression here corrupts every email we send
//   - the supported tags are documented in the function's header
//     comment so the test surface is well-bounded
//
// The HTTP wrappers (sendEmail / sendBatch / sendCampaign) need a
// fetch mock + a Supabase mock to test meaningfully and live in a
// follow-up commit.

import { describe, it, expect } from 'vitest'
import { applyMergeTags } from './postmark.js'

describe('applyMergeTags', () => {
  // ── falsy / pass-through ────────────────────────────────────────
  it('returns the input unchanged when html is empty / null', () => {
    expect(applyMergeTags('', { name: 'Alice' })).toBe('')
    expect(applyMergeTags(null, { name: 'Alice' })).toBeNull()
    expect(applyMergeTags(undefined, { name: 'Alice' })).toBeUndefined()
  })

  it('leaves html with no tags untouched', () => {
    const html = '<p>Hello there!</p>'
    expect(applyMergeTags(html, { name: 'Alice' })).toBe(html)
  })

  // ── name / first-name handling ──────────────────────────────────
  it('substitutes {{name}}', () => {
    expect(applyMergeTags('Hi {{name}}', { name: 'Alice Murphy' }))
      .toBe('Hi Alice Murphy')
  })

  it('uses contact.first_name when present', () => {
    expect(applyMergeTags('Hi {{first_name}}', { first_name: 'Alice', name: 'Alice Murphy' }))
      .toBe('Hi Alice')
  })

  it('falls back to the first word of name when first_name is missing', () => {
    // The Glofox imports often have name + email but no first_name —
    // pin the fallback so re-derivation stays consistent.
    expect(applyMergeTags('Hi {{first_name}}', { name: 'Alice Murphy' }))
      .toBe('Hi Alice')
  })

  it('renders empty string when both first_name and name are missing', () => {
    expect(applyMergeTags('Hi {{first_name}}!', {}))
      .toBe('Hi !')
  })

  it('substitutes {{last_name}} when present', () => {
    expect(applyMergeTags('{{last_name}}, {{first_name}}', {
      first_name: 'Alice', last_name: 'Murphy',
    })).toBe('Murphy, Alice')
  })

  // ── email / phone ───────────────────────────────────────────────
  it('substitutes {{email}} and {{phone}}', () => {
    expect(applyMergeTags(
      'Reach you at {{email}} or {{phone}}.',
      { email: 'a@b.com', phone: '+353 1 234 5678' }
    )).toBe('Reach you at a@b.com or +353 1 234 5678.')
  })

  it('renders empty for missing email/phone', () => {
    expect(applyMergeTags('{{email}}|{{phone}}', {})).toBe('|')
  })

  // ── lead_status humanisation ────────────────────────────────────
  it('replaces underscore in lead_status with space', () => {
    expect(applyMergeTags('Status: {{lead_status}}', { lead_status: 'active_trial' }))
      .toBe('Status: active trial')
  })

  it('leaves lead_status without underscores untouched', () => {
    expect(applyMergeTags('{{lead_status}}', { lead_status: 'member' }))
      .toBe('member')
  })

  // ── extras ──────────────────────────────────────────────────────
  it('substitutes {{location_name}} from extras', () => {
    expect(applyMergeTags(
      '{{location_name}}',
      { name: 'A' },
      { location_name: 'UN1T Dublin' }
    )).toBe('UN1T Dublin')
  })

  it('substitutes {{unsubscribe_url}} + {{preference_url}} from extras', () => {
    expect(applyMergeTags(
      '<a href="{{unsubscribe_url}}">Unsub</a> · <a href="{{preference_url}}">Prefs</a>',
      { name: 'A' },
      {
        unsubscribe_url: 'https://crm.un1tdublin.com/u/abc',
        preference_url: 'https://crm.un1tdublin.com/p/abc',
      }
    )).toBe('<a href="https://crm.un1tdublin.com/u/abc">Unsub</a> · <a href="https://crm.un1tdublin.com/p/abc">Prefs</a>')
  })

  it('renders empty when extras keys are missing', () => {
    // No extras at all → tags resolve to ''.
    expect(applyMergeTags('{{location_name}}|{{unsubscribe_url}}', { name: 'A' }))
      .toBe('|')
  })

  // ── current_year is dynamic ─────────────────────────────────────
  it('substitutes {{current_year}} with this calendar year', () => {
    const out = applyMergeTags('© {{current_year}} UN1T', { name: 'A' })
    expect(out).toBe(`© ${new Date().getFullYear()} UN1T`)
  })

  // ── multiple occurrences ────────────────────────────────────────
  it('replaces every occurrence of the same tag', () => {
    // replaceAll is the contract — campaigns frequently repeat
    // {{first_name}} in subject + opening + footer.
    expect(applyMergeTags(
      'Hi {{first_name}}, {{first_name}}? Yes, {{first_name}}.',
      { first_name: 'Alice' }
    )).toBe('Hi Alice, Alice? Yes, Alice.')
  })

  // ── doesn't mangle look-alike strings ───────────────────────────
  it('does not touch text that looks like-but-is-not a merge tag', () => {
    // Single braces, three braces, mismatched — all should pass
    // through. Only exact `{{tag}}` is replaced.
    const html = '{first_name} or {{{first_name}}} (literal)'
    expect(applyMergeTags(html, { first_name: 'Alice' }))
      .toBe('{first_name} or {Alice} (literal)')
  })

  it('leaves unknown tags as-is (no template engine confusion)', () => {
    // {{whatever}} that isn't in the supported list is left
    // untouched, not stripped — better to ship a visible bug than
    // silently delete content.
    expect(applyMergeTags('Unknown {{not_a_real_tag}} stays', { name: 'A' }))
      .toBe('Unknown {{not_a_real_tag}} stays')
  })
})
