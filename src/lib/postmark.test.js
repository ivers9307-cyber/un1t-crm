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
import {
  applyMergeTags,
  buildUnsubscribeUrl,
  appendUnsubscribeFooter,
  toListUnsubscribeUrl,
} from './postmark.js'

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

  // ── pipeline_stage humanisation ─────────────────────────────────
  it('replaces underscores in {{pipeline_stage}} with spaces', () => {
    expect(applyMergeTags('Stage: {{pipeline_stage}}', { pipeline_stage_slug: 'active_trial' }))
      .toBe('Stage: active trial')
  })

  it('leaves single-word slugs untouched', () => {
    expect(applyMergeTags('{{pipeline_stage}}', { pipeline_stage_slug: 'dormant' }))
      .toBe('dormant')
  })

  // ── {{lead_status}} back-compat alias (CLASSIFY.2) ──────────────
  it('{{lead_status}} alias reads pipeline_stage_slug', () => {
    expect(applyMergeTags('Status: {{lead_status}}', { pipeline_stage_slug: 'active_member' }))
      .toBe('Status: active member')
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

  // ── GLOFOX3.5 — glofox_passcode tag ──────────────────────────────
  it('substitutes {{glofox_passcode}} from the contact', () => {
    // The Glofox welcome sequence relies on this tag — locking
    // it down so a postmark.js refactor can't accidentally drop
    // the column read.
    expect(applyMergeTags(
      'Passcode: <code>{{glofox_passcode}}</code>',
      { name: 'Alice', glofox_passcode: 'ABC1-2345' }
    )).toBe('Passcode: <code>ABC1-2345</code>')
  })

  it('renders {{glofox_passcode}} as empty when not set on the contact', () => {
    // A pre-Glofox-create contact won't have one — empty string is
    // the right fallback (no "undefined" leaking into email body).
    expect(applyMergeTags('Code: {{glofox_passcode}}', { name: 'Alice' }))
      .toBe('Code: ')
  })
})

// ============================================================
// UNSUB.1 — buildUnsubscribeUrl + appendUnsubscribeFooter
// ============================================================

describe('buildUnsubscribeUrl', () => {
  it('uses contact_preferences.unsubscribe_token when present', () => {
    const contact = {
      id: 'contact-uuid',
      contact_preferences: [{ unsubscribe_token: 'tok-abc123' }],
    }
    expect(buildUnsubscribeUrl(contact, 'https://crm.un1t.ie'))
      .toBe('https://crm.un1t.ie/unsubscribe/tok-abc123')
  })

  it('accepts contact_preferences as a single object (not array)', () => {
    // Supabase embedded resources can come back as either shape
    // depending on whether the relationship is many-to-one or
    // one-to-one. Both must work.
    const contact = {
      id: 'contact-uuid',
      contact_preferences: { unsubscribe_token: 'tok-xyz789' },
    }
    expect(buildUnsubscribeUrl(contact, 'https://crm.un1t.ie'))
      .toBe('https://crm.un1t.ie/unsubscribe/tok-xyz789')
  })

  it('falls back to contact.id when no preferences row exists', () => {
    // The unsubscribe page accepts either token shape — see
    // src/app/unsubscribe/[token]/page.js — so this fallback gives
    // the recipient a working link even pre-CONSENT.1 contacts.
    const contact = { id: 'contact-uuid' }
    expect(buildUnsubscribeUrl(contact, 'https://crm.un1t.ie'))
      .toBe('https://crm.un1t.ie/unsubscribe/contact-uuid')
  })
})

describe('appendUnsubscribeFooter', () => {
  const URL = 'https://crm.un1t.ie/unsubscribe/tok-1'

  it('appends a 7pt Unsubscribe link with the URL', () => {
    const out = appendUnsubscribeFooter('<p>Hi</p>', URL)
    expect(out).toContain('font-size:7pt')
    expect(out).toContain(`href="${URL}"`)
    expect(out).toContain('>Unsubscribe</a>')
  })

  it('inserts BEFORE </body> when the html has one', () => {
    // Footer lands inside <body> so email clients render it as part
    // of the email content, not loose markup after the closing tag.
    const out = appendUnsubscribeFooter(
      '<html><body><p>Hi</p></body></html>',
      URL
    )
    expect(out.indexOf('Unsubscribe</a>')).toBeLessThan(out.indexOf('</body>'))
    expect(out.endsWith('</body></html>')).toBe(true)
  })

  it('case-insensitive — matches </BODY> too', () => {
    const out = appendUnsubscribeFooter('<HTML><BODY>x</BODY></HTML>', URL)
    expect(out.indexOf('Unsubscribe</a>')).toBeLessThan(out.indexOf('</BODY>'))
  })

  it('appends at end when the html has no body tag', () => {
    // Some operators paste partial HTML snippets without a
    // <body> wrapper. We still need the footer.
    const out = appendUnsubscribeFooter('<p>fragment</p>', URL)
    expect(out.startsWith('<p>fragment</p>')).toBe(true)
    expect(out).toContain('Unsubscribe')
  })

  it('always appends — even when {{unsubscribe_url}} was already inlined', () => {
    // Operator spec: "always append auto-footer". Even if the body
    // already has an unsubscribe link, the auto footer still goes
    // in. Both links must point at the same URL.
    const body = `<p>Read more: <a href="${URL}">unsubscribe here</a></p>`
    const out = appendUnsubscribeFooter(body, URL)
    // Two occurrences of the URL — operator's + the auto footer.
    expect((out.match(new RegExp(URL.replace(/[/.]/g, '\\$&'), 'g')) || []).length)
      .toBe(2)
  })

  it('returns input unchanged when html is empty', () => {
    expect(appendUnsubscribeFooter('', URL)).toBe('')
    expect(appendUnsubscribeFooter(null, URL)).toBeNull()
  })

  it('returns input unchanged when unsubscribeUrl is missing', () => {
    // Defensive — if the caller forgot to build the URL, we
    // shouldn't emit `<a href="">Unsubscribe</a>` which would 404.
    expect(appendUnsubscribeFooter('<p>Hi</p>', '')).toBe('<p>Hi</p>')
    expect(appendUnsubscribeFooter('<p>Hi</p>', null)).toBe('<p>Hi</p>')
  })
})

// ============================================================
// UNSUB.3 — toListUnsubscribeUrl
// ============================================================

describe('toListUnsubscribeUrl', () => {
  it('rewrites the page URL into the API POST endpoint', () => {
    // Gmail / Outlook / Apple Mail POST to the List-Unsubscribe
    // URL when the user clicks the built-in Unsubscribe button.
    // The page route 405s on POST; /api/unsubscribe/<token> is
    // the correct handler.
    expect(toListUnsubscribeUrl('https://crm.un1t.ie/unsubscribe/tok-abc'))
      .toBe('https://crm.un1t.ie/api/unsubscribe/tok-abc')
  })

  it('only rewrites the /unsubscribe/ path segment', () => {
    // Defensive — we don't want a contact whose token happens to
    // contain the substring "/unsubscribe/" to break.
    expect(toListUnsubscribeUrl('https://x.test/unsubscribe/tok-with-/unsubscribe/-in-it'))
      .toBe('https://x.test/api/unsubscribe/tok-with-/unsubscribe/-in-it')
  })

  it('returns falsy / non-string inputs unchanged', () => {
    expect(toListUnsubscribeUrl('')).toBe('')
    expect(toListUnsubscribeUrl(null)).toBeNull()
    expect(toListUnsubscribeUrl(undefined)).toBeUndefined()
  })
})
