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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// sendMarketingEmail logs to email_sends via createServerClient —
// mock the supabase seam so the tests below can observe the insert.
vi.mock('./supabase', () => ({ createServerClient: vi.fn() }))

import {
  applyMergeTags,
  buildUnsubscribeUrl,
  appendUnsubscribeFooter,
  toListUnsubscribeUrl,
  buildAudienceQuery,
  consentFieldForStream,
  sendBatch,
  sendEmail,
  isTransientSendError,
  sendMarketingEmail,
  sendTransactionalEmail,
  getLocationInboxReplyTo,
  getDefaultMailboxAddress,
} from './postmark.js'
import { createServerClient } from './supabase'
// EMAIL-MAILBOX-ADMIN.1 — the Reply-To resolution reads two tables in
// sequence, which the fluent recorder above cannot model. Reuse the shared
// ticket-suite fake, which honours eq/limit/maybeSingle for real.
import { makeDb } from '@/app/api/email/tickets/_test-db'

// Fluent fake recording method calls (mirrors sms.test.js).
function makeFakeQuery() {
  const calls = []
  const builder = new Proxy({}, {
    get(_, method) {
      if (method === 'then') return undefined
      return (...args) => { calls.push({ method, args }); return builder }
    },
  })
  return { builder, calls }
}

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

  // UNSUBTOKEN.2 — the old behaviour here was `|| contact.id`, justified by a
  // comment claiming the unsubscribe page "accepts either token shape". It
  // never did: /api/unsubscribe/[token] has resolved
  // `.eq('unsubscribe_token', token)` and nothing else since the table was
  // created (mig 005 / commit 98a0fabb), the page is a pass-through, and
  // contacts.id / contact_preferences.unsubscribe_token are independently
  // generated UUIDs. So the fallback minted a link that could only ever 404 —
  // in the visible footer AND in the RFC 8058 List-Unsubscribe header built
  // from the same URL. Returning null instead lets each caller refuse the
  // send loudly; a dead opt-out link must never leave the building.
  it('returns null when no preferences row exists — a contact id is NOT a token', () => {
    expect(buildUnsubscribeUrl({ id: 'contact-uuid' }, 'https://crm.un1t.ie')).toBeNull()
  })

  it('returns null for a preferences row with no token at all', () => {
    expect(buildUnsubscribeUrl({ id: 'c1', contact_preferences: [{}] }, 'https://crm.un1t.ie')).toBeNull()
  })

  it('returns null regardless of the location/campaign scope params', () => {
    // The scope params decorate a URL; they can never manufacture one.
    expect(buildUnsubscribeUrl({ id: 'c1' }, 'https://crm.example', 'loc-hatch', 'camp-1')).toBeNull()
  })

  it('returns null for a missing contact rather than throwing', () => {
    expect(buildUnsubscribeUrl(null, 'https://crm.un1t.ie')).toBeNull()
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

  it('does NOT append when the body already links to the unsubscribe URL', () => {
    // Idempotent: if the operator placed a {{unsubscribe_url}} link in
    // the template body, adding the auto-footer would render two
    // "Unsubscribe" links (looks broken to recipients). We skip the
    // footer — the operator's link already satisfies compliance.
    const body = `<p>Read more: <a href="${URL}">unsubscribe here</a></p>`
    const out = appendUnsubscribeFooter(body, URL)
    // Exactly one occurrence of the URL — the operator's link only.
    expect((out.match(new RegExp(URL.replace(/[/.]/g, '\\$&'), 'g')) || []).length)
      .toBe(1)
    // And no second 7pt auto-footer was added.
    expect(out).not.toContain('font-size:7pt')
    expect(out).toBe(body)
  })

  it('still appends when the body has other links but no unsubscribe link', () => {
    // Only an unrelated link present → the compliance footer is still
    // guaranteed for templates that forgot to add one.
    const body = `<p>See our <a href="https://un1t.ie/classes">classes</a></p>`
    const out = appendUnsubscribeFooter(body, URL)
    expect(out).toContain('font-size:7pt')
    expect(out).toContain(`href="${URL}"`)
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

describe('consentFieldForStream', () => {
  it('maps outbound → email_administrative, everything else → email_marketing', () => {
    expect(consentFieldForStream('outbound')).toBe('email_administrative')
    expect(consentFieldForStream('broadcast')).toBe('email_marketing')
    expect(consentFieldForStream(undefined)).toBe('email_marketing')
  })
})

describe('buildAudienceQuery — consent gate', () => {
  it('defaults to gating on the PER-LOCATION email consent column', () => {
    // LOCCOMMS.3 — marketing consent moved to contact_location_audience
    // (mig 491). email_administrative stays GLOBAL — see the next test, which
    // is the guard that the mapping did not over-apply.
    const { builder, calls } = makeFakeQuery()
    const db = { from: () => builder }
    buildAudienceQuery(db, { logic: 'and', filters: [] }, 'loc-uuid')
    expect(calls).toContainEqual({ method: 'eq', args: ['loc_email_marketing', true] })
    expect(calls).not.toContainEqual({ method: 'eq', args: ['email_marketing', true] })
    expect(calls).toContainEqual({ method: 'not', args: ['email_status', 'in', '("bounced","complained")'] })
  })

  it('gates on email_administrative when consentField is passed', () => {
    const { builder, calls } = makeFakeQuery()
    const db = { from: () => builder }
    buildAudienceQuery(db, { logic: 'and', filters: [] }, 'loc-uuid', { consentField: 'email_administrative' })
    expect(calls).toContainEqual({ method: 'eq', args: ['email_administrative', true] })
    expect(calls).not.toContainEqual({ method: 'eq', args: ['email_marketing', true] })
  })

  it('rejects an unknown consentField (no arbitrary columns)', () => {
    const { builder } = makeFakeQuery()
    const db = { from: () => builder }
    expect(() => buildAudienceQuery(db, { logic: 'and', filters: [] }, 'loc-uuid', { consentField: 'profiles.role' }))
      .toThrow(/consentField/)
  })
})

describe('sendBatch — failure handling (COMMS-AUDIT batch 3)', () => {
  const two = [
    { to: 'a@x.ie', subject: 'S', htmlBody: '<p>a</p>' },
    { to: 'b@x.ie', subject: 'S', htmlBody: '<p>b</p>' },
  ]

  beforeEach(() => {
    process.env.POSTMARK_API_KEY = 'test-token'
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns one result PER email on success (passes the array through)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { ErrorCode: 0, MessageID: 'm1' },
        { ErrorCode: 0, MessageID: 'm2' },
      ],
    })
    const results = await sendBatch(two)
    expect(results).toHaveLength(2)
    expect(results[0].MessageID).toBe('m1')
  })

  it('emits one error result PER email when the batch HTTP call is non-2xx (not one for the whole chunk)', async () => {
    // Postmark returns a single { ErrorCode, Message } object on auth/rate
    // errors — the old code pushed it once, silently dropping email #2.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ ErrorCode: 300, Message: 'Invalid batch' }),
    })
    const results = await sendBatch(two)
    expect(results).toHaveLength(2)
    expect(results.every(r => r.ErrorCode === 300)).toBe(true)
  })

  it('emits one error result PER email when the request throws (network/JSON failure)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'))
    const results = await sendBatch(two)
    expect(results).toHaveLength(2)
    expect(results.every(r => r.ErrorCode === -1)).toBe(true)
    expect(results[0].Message).toMatch(/ECONNRESET/)
  })

  it('carries the HTTP status on synthetic whole-batch failures so callers can classify', async () => {
    // A 429/5xx on the whole batch call is TRANSIENT (retry); a 422
    // with a real Postmark ErrorCode may be permanent. The synthetic
    // per-email results need the status for that call to be possible.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ ErrorCode: 429, Message: 'Rate limit exceeded' }),
    })
    const results = await sendBatch(two)
    expect(results).toHaveLength(2)
    expect(results.every(r => r.HttpStatus === 429)).toBe(true)
  })

  it('sends a TextBody derived from the html when none is provided (CAMPAIGN-REL.4)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ ErrorCode: 0, MessageID: 'm1' }],
    })
    await sendBatch([{ to: 'a@x.ie', subject: 'S', htmlBody: '<p>Hello <a href="https://un1t.ie/b">book</a></p>' }])
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(sent[0].TextBody).toBe('Hello book (https://un1t.ie/b)')
  })

  it('respects an explicit textBody over the derived one', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ ErrorCode: 0, MessageID: 'm1' }],
    })
    await sendBatch([{ to: 'a@x.ie', subject: 'S', htmlBody: '<p>Hello</p>', textBody: 'Custom text' }])
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(sent[0].TextBody).toBe('Custom text')
  })
})

describe('isTransientSendError (CAMPAIGN-REL.1)', () => {
  it('classifies the synthetic -1 (network / unparseable response) as transient', () => {
    expect(isTransientSendError({ ErrorCode: -1, Message: 'ECONNRESET' })).toBe(true)
  })

  it('classifies whole-batch HTTP 429 / 5xx as transient', () => {
    expect(isTransientSendError({ ErrorCode: 429, Message: 'Rate limit exceeded', HttpStatus: 429 })).toBe(true)
    expect(isTransientSendError({ ErrorCode: 0, Message: 'Bad gateway', HttpStatus: 502 })).toBe(true)
    expect(isTransientSendError({ ErrorCode: 100, Message: 'Maintenance', HttpStatus: 503 })).toBe(true)
  })

  it('classifies Postmark rate-limit / maintenance codes as transient even without HttpStatus', () => {
    expect(isTransientSendError({ ErrorCode: 429, Message: 'Rate limit exceeded' })).toBe(true)
    expect(isTransientSendError({ ErrorCode: 100, Message: 'Maintenance' })).toBe(true)
  })

  it('classifies real Postmark rejections as permanent', () => {
    // 300 invalid email, 406 inactive recipient, 400 signature not
    // found — retrying these can never succeed.
    expect(isTransientSendError({ ErrorCode: 300, Message: 'Invalid email request' })).toBe(false)
    expect(isTransientSendError({ ErrorCode: 406, Message: 'Inactive recipient' })).toBe(false)
    expect(isTransientSendError({ ErrorCode: 400, Message: 'Sender signature not found' })).toBe(false)
  })

  it('a 4xx whole-batch failure with a permanent ErrorCode stays permanent', () => {
    expect(isTransientSendError({ ErrorCode: 300, Message: 'Invalid batch', HttpStatus: 422 })).toBe(false)
  })

  it('treats success / missing input as not transient', () => {
    expect(isTransientSendError({ ErrorCode: 0, MessageID: 'm1' })).toBe(false)
    expect(isTransientSendError(null)).toBe(false)
    expect(isTransientSendError(undefined)).toBe(false)
  })
})

// ── sendMarketingEmail (COMMS-AUDIT 2026-07-10, SEQ batch) ────────
//
// Sequence step emails are marketing (welcome / nurture / win-back) and
// must ride Postmark's broadcast stream — sendEmail only attaches the
// RFC 8058 List-Unsubscribe / List-Unsubscribe-Post one-click headers
// when stream === 'broadcast', so the old sendTransactionalEmail path
// shipped marketing mail with no header unsubscribe at all.
describe('sendMarketingEmail — broadcast stream + one-click unsubscribe headers', () => {
  beforeEach(() => {
    process.env.POSTMARK_API_KEY = 'test-token'
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function okFetch() {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ MessageID: 'pm-msg-1', To: 'a@x.ie', SubmittedAt: '2026-07-10T10:00:00Z' }),
    })
  }

  it('sends on the broadcast stream with RFC 8058 one-click unsubscribe headers (POST endpoint, not the page)', async () => {
    const fetchSpy = okFetch()
    const result = await sendMarketingEmail({
      to: 'a@x.ie',
      subject: 'Welcome',
      htmlBody: '<p>hi</p>',
      unsubscribeUrl: 'https://crm.test/unsubscribe/tok-1',
    })
    expect(result.messageId).toBe('pm-msg-1')
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.MessageStream).toBe('broadcast')
    expect(body.Headers).toContainEqual({
      Name: 'List-Unsubscribe',
      Value: '<https://crm.test/api/unsubscribe/tok-1>',
    })
    expect(body.Headers).toContainEqual({
      Name: 'List-Unsubscribe-Post',
      Value: 'List-Unsubscribe=One-Click',
    })
  })

  it('logs to email_sends with postmark_stream=broadcast + atomic sequence attribution', async () => {
    okFetch()
    const insertSpy = vi.fn().mockResolvedValue({ error: null })
    createServerClient.mockReturnValue({ from: vi.fn(() => ({ insert: insertSpy })) })

    await sendMarketingEmail({
      to: 'a@x.ie',
      subject: 'Welcome',
      htmlBody: '<p>hi</p>',
      contactId: 'c1',
      locationId: 'loc-1',
      tag: 'seq-s1',
      unsubscribeUrl: 'https://crm.test/unsubscribe/tok-1',
      sourceType: 'sequence',
      sequenceId: 'seq-1',
      sequenceStepId: 'st-1',
    })

    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      contact_id: 'c1',
      location_id: 'loc-1',
      source_type: 'sequence',
      sequence_id: 'seq-1',
      sequence_step_id: 'st-1',
      to_email: 'a@x.ie',
      postmark_message_id: 'pm-msg-1',
      postmark_stream: 'broadcast',
      status: 'sent',
    }))
  })

  it('skips the email_sends insert when there is no contactId (parity with sendTransactionalEmail)', async () => {
    okFetch()
    createServerClient.mockClear()
    await sendMarketingEmail({
      to: 'a@x.ie',
      subject: 'S',
      htmlBody: '<p>x</p>',
      unsubscribeUrl: 'https://crm.test/unsubscribe/tok-1',
    })
    expect(createServerClient).not.toHaveBeenCalled()
  })
})

// LOCCOMMS.4 — the unsubscribe URL carries the SENDING location, so opting out
// of a Hatch Street email does not silently remove someone from Stillorgan's
// list. Stillorgan has 3,364 reachable contacts against Hatch's 82, so a global
// unsubscribe fired from a Hatch campaign strips members off the list of the
// gym they actually attend.
describe('LOCCOMMS.4 — unsubscribe URL carries the sending location', () => {
  const contact = { contact_preferences: [{ unsubscribe_token: 'tok' }] }

  it('appends ?l= when a location is supplied', () => {
    expect(buildUnsubscribeUrl(contact, 'https://crm.example', 'loc-hatch'))
      .toBe('https://crm.example/unsubscribe/tok?l=loc-hatch')
  })

  it('omits ?l= when no location is supplied — that means GLOBAL unsubscribe', () => {
    // BACK-COMPAT: emails already delivered carry the old, location-less URL.
    // Those must keep working, and with no `l` they unsubscribe from EVERY
    // location — today's exact behaviour, and the only direction that cannot
    // generate a spam complaint.
    expect(buildUnsubscribeUrl(contact, 'https://crm.example'))
      .toBe('https://crm.example/unsubscribe/tok')
  })

  it('survives the List-Unsubscribe transform with the param intact', () => {
    const page = buildUnsubscribeUrl(contact, 'https://crm.example', 'loc-hatch')
    expect(toListUnsubscribeUrl(page))
      .toBe('https://crm.example/api/unsubscribe/tok?l=loc-hatch')
  })

  it('returns null — not a location-scoped dead link — when there is no token', () => {
    // UNSUBTOKEN.2: `?l=` scopes an opt-out, it does not make one resolvable.
    expect(buildUnsubscribeUrl({ id: 'c1' }, 'https://crm.example', 'loc-hatch')).toBeNull()
  })
})

// COMMSFIX.C.4 — campaigns.total_unsubscribed only ever moved on Postmark's own
// SubscriptionChange webhook, which fires for POSTMARK-side suppressions (spam
// complaint, hard bounce, manual). The primary unsubscribe path — the footer
// link and Gmail/Apple's one-click button, both resolving to our
// /api/unsubscribe/[token] — carried no campaign id at all, so the counter sat
// near zero and an operator could never see which campaign burned the list.
describe('COMMSFIX.C.4 — unsubscribe URL carries the sending campaign', () => {
  const contact = { contact_preferences: [{ unsubscribe_token: 'tok' }] }

  it('appends &c= alongside ?l= when a campaign is supplied', () => {
    expect(buildUnsubscribeUrl(contact, 'https://crm.example', 'loc-hatch', 'camp-1'))
      .toBe('https://crm.example/unsubscribe/tok?l=loc-hatch&c=camp-1')
  })

  it('uses ?c= when there is a campaign but no location', () => {
    expect(buildUnsubscribeUrl(contact, 'https://crm.example', null, 'camp-1'))
      .toBe('https://crm.example/unsubscribe/tok?c=camp-1')
  })

  it('omits the campaign entirely for a non-campaign send (sequence step)', () => {
    expect(buildUnsubscribeUrl(contact, 'https://crm.example', 'loc-hatch'))
      .toBe('https://crm.example/unsubscribe/tok?l=loc-hatch')
  })

  it('survives the List-Unsubscribe transform with both params intact', () => {
    const page = buildUnsubscribeUrl(contact, 'https://crm.example', 'loc-hatch', 'camp-1')
    expect(toListUnsubscribeUrl(page))
      .toBe('https://crm.example/api/unsubscribe/tok?l=loc-hatch&c=camp-1')
  })
})

describe('EMAIL-MAILBOX-ADMIN.1 — where a studio’s replies go', () => {
  const LOC = 'loc-1'
  const mailbox = (over = {}) => ({
    id: 'mb-1', location_id: LOC, address: 'studio@un1tdublin.com',
    label: 'Studio', is_default: true, active: true, ...over,
  })

  it('prefers the DEFAULT email account over the deprecated column', async () => {
    // mig 485 documented is_default as the Reply-To source from the start,
    // but nothing could set it until the accounts editor shipped — so this
    // path kept reading a column no operator can edit any more.
    const db = makeDb({
      mailboxes: [mailbox()],
      locations: [{ id: LOC, email_inbox_reply_to: 'legacy@un1tdublin.com' }],
    })
    createServerClient.mockReturnValue(db)
    expect(await getLocationInboxReplyTo(LOC)).toBe('studio@un1tdublin.com')
  })

  it('ignores a DEACTIVATED default — its mail dead-letters', async () => {
    const db = makeDb({
      mailboxes: [mailbox({ active: false })],
      locations: [{ id: LOC, email_inbox_reply_to: 'legacy@un1tdublin.com' }],
    })
    createServerClient.mockReturnValue(db)
    expect(await getLocationInboxReplyTo(LOC)).toBe('legacy@un1tdublin.com')
  })

  it('ignores a non-default account — an address nobody chose is not a Reply-To', async () => {
    const db = makeDb({
      mailboxes: [mailbox({ is_default: false })],
      locations: [{ id: LOC, email_inbox_reply_to: null }],
    })
    createServerClient.mockReturnValue(db)
    expect(await getLocationInboxReplyTo(LOC)).toBeNull()
  })

  it('falls back to the deprecated column for studios configured before mig 485', async () => {
    const db = makeDb({ mailboxes: [], locations: [{ id: LOC, email_inbox_reply_to: 'legacy@un1tdublin.com' }] })
    createServerClient.mockReturnValue(db)
    expect(await getLocationInboxReplyTo(LOC)).toBe('legacy@un1tdublin.com')
  })

  it('never picks up ANOTHER studio’s default account', async () => {
    const db = makeDb({
      mailboxes: [mailbox({ location_id: 'loc-other', address: 'studio@hatch.ie' })],
      locations: [{ id: LOC, email_inbox_reply_to: null }],
    })
    createServerClient.mockReturnValue(db)
    expect(await getLocationInboxReplyTo(LOC)).toBeNull()
  })

  it('is null rather than throwing when the lookup fails — the send still goes', async () => {
    const db = makeDb({ errors: { email_mailboxes: { message: 'boom' }, locations: { message: 'boom' } } })
    createServerClient.mockReturnValue(db)
    expect(await getLocationInboxReplyTo(LOC)).toBeNull()
    expect(await getDefaultMailboxAddress(db, LOC)).toBeNull()
  })

  it('getDefaultMailboxAddress needs both a client and a location', async () => {
    expect(await getDefaultMailboxAddress(null, LOC)).toBeNull()
    expect(await getDefaultMailboxAddress(makeDb({ mailboxes: [mailbox()] }), null)).toBeNull()
  })
})

// ── sendEmail Cc / Bcc (EMAIL-CC.1) ───────────────────────────────
//
// THE WIRE IS WHERE THE CONFIDENTIALITY GUARANTEE IS EITHER KEPT OR LOST.
// Postmark strips the Bcc header from every delivered message, so a Bcc passed
// in its own API field is genuinely invisible to the other recipients — but
// that is only true of the `Bcc` FIELD. The same address written into
// `body.Headers` would ride out on the message itself, visible to everyone.
// These tests pin the request body, which is the last thing this codebase
// controls before the provider takes over.
describe('sendEmail — Cc and Bcc on the wire', () => {
  beforeEach(() => {
    process.env.POSTMARK_API_KEY = 'test-token'
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function okFetch() {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ MessageID: 'pm-1', To: 'a@x.ie', SubmittedAt: '2026-08-07T10:00:00Z' }),
    })
  }

  it('sends Cc and Bcc in their own Postmark fields', async () => {
    const fetchSpy = okFetch()
    await sendEmail({
      to: 'a@x.ie, b@x.ie', cc: 'c@x.ie', bcc: 'secret@x.ie',
      subject: 'S', htmlBody: '<p>hi</p>', stream: 'outbound',
    })
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.To).toBe('a@x.ie, b@x.ie')
    expect(body.Cc).toBe('c@x.ie')
    expect(body.Bcc).toBe('secret@x.ie')
  })

  // THE LEAK TEST. A bcc address anywhere but the Bcc field — in To, in Cc, or
  // in a header — reaches the other recipients.
  it('never puts a bcc address in To, Cc or any header', async () => {
    const fetchSpy = okFetch()
    await sendEmail({
      to: 'a@x.ie', cc: 'c@x.ie', bcc: 'secret@x.ie',
      subject: 'S', htmlBody: '<p>hi</p>', stream: 'outbound',
      headers: [{ Name: 'In-Reply-To', Value: '<x@mail>' }],
    })
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.To).not.toContain('secret@x.ie')
    expect(body.Cc).not.toContain('secret@x.ie')
    expect(JSON.stringify(body.Headers)).not.toContain('secret@x.ie')
    expect(body.Bcc).toBe('secret@x.ie')
  })

  // Purely additive: the request body for every pre-EMAIL-CC.1 caller must be
  // shaped exactly as it was, or a Cc/Bcc key with no value goes out on every
  // email the estate sends.
  it('omits Cc and Bcc entirely when the caller passes neither', async () => {
    const fetchSpy = okFetch()
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>hi</p>' })
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.Cc).toBeUndefined()
    expect(body.Bcc).toBeUndefined()
    expect('Cc' in JSON.parse(fetchSpy.mock.calls[0][1].body)).toBe(false)
  })
})

// ── POSTMARK-RACE.1 — the marker must pair EXACTLY with the email_sends row ──
//
// The webhook processor treats `Metadata.crm_send` as a promise that a row is
// coming: a Delivery that finds no row is retried instead of discarded. That
// makes an over-generous marker the one way this design can hurt — marked mail
// that never writes a row would burn the retry budget and land honest noise in
// webhook_dead_letter. These two paths gate their insert on `contactId`, so the
// marker must too, and the pairing is asserted on the ACTUAL Postmark wire
// payload rather than on an intermediate.
describe('POSTMARK-RACE.1 — crm_send marker pairs with the email_sends insert', () => {
  beforeEach(() => { process.env.POSTMARK_API_KEY = 'test-token' })
  afterEach(() => { vi.restoreAllMocks() })

  function okFetch() {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ MessageID: 'pm-msg-1', To: 'a@x.ie', SubmittedAt: '2026-07-10T10:00:00Z' }),
    })
  }
  const wire = (spy) => JSON.parse(spy.mock.calls[0][1].body)

  it('sendMarketingEmail marks the send when a contact will be logged', async () => {
    const fetchSpy = okFetch()
    createServerClient.mockReturnValue({ from: vi.fn(() => ({ insert: vi.fn().mockResolvedValue({ error: null }) })) })

    await sendMarketingEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', contactId: 'c1', locationId: 'loc-1',
      unsubscribeUrl: 'https://crm.test/unsubscribe/tok-1',
    })

    expect(wire(fetchSpy).Metadata).toEqual({ crm_send: '1' })
  })

  it('sendMarketingEmail leaves an unlogged send UNMARKED', async () => {
    const fetchSpy = okFetch()

    await sendMarketingEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      unsubscribeUrl: 'https://crm.test/unsubscribe/tok-1',
    })

    expect(wire(fetchSpy).Metadata).toEqual({})
  })

  it('sendTransactionalEmail marks the send when a contact will be logged', async () => {
    const fetchSpy = okFetch()
    createServerClient.mockReturnValue({ from: vi.fn(() => ({ insert: vi.fn().mockResolvedValue({ error: null }) })) })

    await sendTransactionalEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', contactId: 'c1', locationId: 'loc-1',
    })

    expect(wire(fetchSpy).Metadata).toEqual({ crm_send: '1' })
  })

  it('sendTransactionalEmail leaves an unlogged send UNMARKED', async () => {
    // This is the whole (b) population on the transactional stream: alert
    // crons, staff notices, a race confirmation for a payer with no contact.
    // 378 such Delivery events over 21 days must keep being ignored.
    const fetchSpy = okFetch()

    await sendTransactionalEmail({ to: 'ops@un1t.ie', subject: 'S', htmlBody: '<p>x</p>' })

    expect(wire(fetchSpy).Metadata).toEqual({})
  })
})
