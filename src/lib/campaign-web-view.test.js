// WEBVIEW.1 — the hosted copy of a campaign email.
//
// WHY: Gmail clips a message over roughly 102KB, showing "[Message clipped]"
// and hiding everything past the cut — which is the FOOTER, and therefore the
// unsubscribe link. Unlayer designs pass 102KB easily. There was no hosted
// fallback, so a clipped recipient had no way to read the rest and no way to
// opt out from the message itself.
//
// TWO THINGS MAKE THIS SAFE:
//   • The link must not be enumerable. It carries a signed token, not a
//     campaign id, on the same HMAC pattern as the host-unsubscribe and
//     event-checkin tokens.
//   • It must not leak recipient PII. The token names ONLY the campaign, so
//     there is no recipient to leak — and the merge tags are rendered against
//     an empty contact so no personal data can appear even if the design
//     inlines {{email}}.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const ORIGINAL_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY

beforeEach(() => { process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-signing-secret' })
afterEach(() => { process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_SECRET })

const {
  signCampaignViewToken,
  verifyCampaignViewToken,
  buildCampaignViewUrl,
  renderCampaignWebView,
  prependViewInBrowserLink,
  DEFAULT_VIEW_IN_BROWSER_LABEL,
  DEFAULT_HOSTED_COPY_NOTE,
  resolveEmailCopy,
} = await import('./campaign-web-view.js')

const CAMPAIGN_ID = '11111111-2222-4333-8444-555555555555'

describe('the token names a campaign and nothing else', () => {
  it('round-trips', () => {
    const t = signCampaignViewToken(CAMPAIGN_ID)
    expect(verifyCampaignViewToken(t)).toEqual({ campaignId: CAMPAIGN_ID })
  })

  it('is not the campaign id — the URL must not be enumerable', () => {
    expect(signCampaignViewToken(CAMPAIGN_ID)).not.toContain(CAMPAIGN_ID)
  })

  it('is URL-safe with no escaping', () => {
    const t = signCampaignViewToken(CAMPAIGN_ID)
    expect(encodeURIComponent(t)).toBe(t)
  })

  it('rejects a tampered payload', () => {
    const [payload, sig] = signCampaignViewToken(CAMPAIGN_ID).split('.')
    const other = Buffer.from(JSON.stringify({ c: 'aaaaaaaa-2222-4333-8444-555555555555' })).toString('base64url')
    expect(verifyCampaignViewToken(`${other}.${sig}`)).toBeNull()
    expect(verifyCampaignViewToken(`${payload}.${'A'.repeat(sig.length)}`)).toBeNull()
  })

  it('rejects a token signed under a different secret', () => {
    const t = signCampaignViewToken(CAMPAIGN_ID)
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'a-different-secret'
    expect(verifyCampaignViewToken(t)).toBeNull()
  })

  it.each([null, undefined, '', 'nope', 'a.b.c', '.', 'onlyonepart'])('rejects %p', (bad) => {
    expect(verifyCampaignViewToken(bad)).toBeNull()
  })

  it('carries NO contact identity, so the link is safe to forward', () => {
    const [payload] = signCampaignViewToken(CAMPAIGN_ID).split('.')
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    expect(Object.keys(decoded)).toEqual(['c'])
  })
})

describe('buildCampaignViewUrl', () => {
  it('builds an absolute URL under /view-email/', () => {
    const url = buildCampaignViewUrl(CAMPAIGN_ID, 'https://crm.example')
    expect(url.startsWith('https://crm.example/view-email/')).toBe(true)
    expect(verifyCampaignViewToken(url.split('/view-email/')[1])).toEqual({ campaignId: CAMPAIGN_ID })
  })

  it('returns null without a base url rather than emitting a relative link', () => {
    expect(buildCampaignViewUrl(CAMPAIGN_ID, '')).toBeNull()
    expect(buildCampaignViewUrl(null, 'https://crm.example')).toBeNull()
  })
})

describe('prependViewInBrowserLink — it goes at the TOP', () => {
  const HTML = '<html><body><h1>Sale</h1></body></html>'

  it('inserts after <body>, not before </body>', () => {
    // The entire point is surviving Gmail's clip, which cuts the BOTTOM of the
    // message. A view-in-browser link in the footer is clipped along with the
    // footer it exists to rescue.
    const out = prependViewInBrowserLink(HTML, 'https://crm.example/view-email/tok')
    expect(out.indexOf('view-email')).toBeLessThan(out.indexOf('<h1>Sale</h1>'))
  })

  it('links to the given url and uses the shared label', () => {
    const out = prependViewInBrowserLink(HTML, 'https://crm.example/view-email/tok')
    expect(out).toContain('href="https://crm.example/view-email/tok"')
    expect(out).toContain(DEFAULT_VIEW_IN_BROWSER_LABEL)
  })

  it('is idempotent — a second pass adds nothing', () => {
    const once = prependViewInBrowserLink(HTML, 'https://crm.example/view-email/tok')
    expect(prependViewInBrowserLink(once, 'https://crm.example/view-email/tok')).toBe(once)
  })

  it('handles html with no <body> tag by prepending', () => {
    const out = prependViewInBrowserLink('<h1>Sale</h1>', 'https://crm.example/view-email/tok')
    expect(out.indexOf('view-email')).toBeLessThan(out.indexOf('<h1>'))
  })

  it('returns the html untouched when there is no url', () => {
    expect(prependViewInBrowserLink(HTML, null)).toBe(HTML)
    expect(prependViewInBrowserLink(HTML, '')).toBe(HTML)
  })

  it('uses no em-dash in the label', () => {
    expect(DEFAULT_VIEW_IN_BROWSER_LABEL).not.toContain('—')
  })
})

describe('renderCampaignWebView — no recipient PII, ever', () => {
  const PERSONAL = [
    '<html><body>',
    'Hi {{first_name}} {{last_name}} ({{name}}),',
    'we have {{email}} and {{phone}} on file.',
    'Stage: {{pipeline_stage}}. Passcode: {{glofox_passcode}}.',
    '</body></html>',
  ].join('')

  const CAMPAIGN = {
    id: CAMPAIGN_ID,
    html_content: PERSONAL,
    locations: { name: 'UN1T Stillorgan' },
  }

  it('resolves every contact-derived tag to empty', () => {
    const out = renderCampaignWebView(CAMPAIGN)
    for (const tag of ['{{first_name}}', '{{last_name}}', '{{name}}', '{{email}}',
      '{{phone}}', '{{pipeline_stage}}', '{{lead_status}}', '{{glofox_passcode}}']) {
      expect(out).not.toContain(tag)
    }
    // And nothing was invented in their place.
    expect(out).toContain('Hi   (),')
  })

  it('still resolves the non-personal tags', () => {
    const out = renderCampaignWebView({
      ...CAMPAIGN,
      html_content: '<html><body>{{location_name}} {{current_year}}</body></html>',
    })
    expect(out).toContain('UN1T Stillorgan')
    expect(out).toContain(String(new Date().getFullYear()))
  })

  it('sends the unsubscribe and preference tags to the preference centre, not to an empty href', () => {
    const out = renderCampaignWebView({
      ...CAMPAIGN,
      html_content: '<html><body><a href="{{unsubscribe_url}}">Stop</a><a href="{{preference_url}}">Prefs</a></body></html>',
    }, { baseUrl: 'https://crm.example' })
    expect(out).not.toContain('{{unsubscribe_url}}')
    expect(out).not.toContain('{{preference_url}}')
  })

  it('does not re-add the view-in-browser strip to the hosted copy itself', () => {
    const out = renderCampaignWebView(CAMPAIGN)
    expect(out).not.toContain(DEFAULT_VIEW_IN_BROWSER_LABEL)
  })

  it('returns null for a campaign with no html', () => {
    expect(renderCampaignWebView({ id: CAMPAIGN_ID, html_content: null })).toBeNull()
  })
})

// A missing signing secret must degrade the FEATURE, not the send. Signing
// runs inside campaign-sender's per-recipient loop, so a throw there would
// fail the whole chunk and mark real recipients as errored.
describe('missing SUPABASE_SERVICE_ROLE_KEY degrades softly', () => {
  beforeEach(() => { delete process.env.SUPABASE_SERVICE_ROLE_KEY })

  it('signs to null instead of throwing', () => {
    expect(signCampaignViewToken(CAMPAIGN_ID)).toBeNull()
  })

  it('builds no url instead of an "/view-email/null" one', () => {
    expect(buildCampaignViewUrl(CAMPAIGN_ID, 'https://crm.example')).toBeNull()
  })

  it('verifies nothing rather than throwing', () => {
    expect(verifyCampaignViewToken('anything.here')).toBeNull()
  })

  it('and the email simply carries no strip', () => {
    const html = '<html><body><h1>Sale</h1></body></html>'
    expect(prependViewInBrowserLink(html, buildCampaignViewUrl(CAMPAIGN_ID, 'https://crm.example'))).toBe(html)
  })
})

// ─── K7: the copy is operator-editable, with the default as fallback ──
//
// Both strings were hard-coded, against the standing rule that customer-facing
// copy lives on a settings field with a default fallback. They are now backed
// by two NULLABLE company_settings columns (mig 530) where NULL means "use the
// default", so a location that never opens the settings card is byte-identical
// to before — which is what the "falls back" cases below pin.

describe('resolveEmailCopy', () => {
  it('falls back to both defaults for a missing row', () => {
    for (const raw of [null, undefined, {}, 'nonsense']) {
      expect(resolveEmailCopy(raw)).toEqual({
        viewInBrowserLabel: DEFAULT_VIEW_IN_BROWSER_LABEL,
        hostedCopyNote: DEFAULT_HOSTED_COPY_NOTE,
      })
    }
  })

  it('falls back per FIELD, so a half-written row cannot blank the other', () => {
    const out = resolveEmailCopy({ view_in_browser_label: 'Read it online' })
    expect(out.viewInBrowserLabel).toBe('Read it online')
    expect(out.hostedCopyNote).toBe(DEFAULT_HOSTED_COPY_NOTE)
  })

  it('treats an empty or whitespace-only value as unset', () => {
    // An operator clearing the box means "back to the default". Honouring ''
    // literally would render <a></a>: an invisible, unclickable link, on the
    // exact feature that exists so a clipped recipient can still read the mail.
    expect(resolveEmailCopy({ view_in_browser_label: '   ' }).viewInBrowserLabel)
      .toBe(DEFAULT_VIEW_IN_BROWSER_LABEL)
    expect(resolveEmailCopy({ hosted_copy_note: '' }).hostedCopyNote)
      .toBe(DEFAULT_HOSTED_COPY_NOTE)
  })

  it('accepts the camelCase shape the client hands back, and trims', () => {
    expect(resolveEmailCopy({ viewInBrowserLabel: '  Open in browser  ' }).viewInBrowserLabel)
      .toBe('Open in browser')
  })
})

describe('the operator copy actually reaches the recipient', () => {
  const HTML_DOC = '<html><body><h1>Sale</h1></body></html>'

  it('renders the operator label in the view-in-browser strip', () => {
    const out = prependViewInBrowserLink(HTML_DOC, 'https://crm.example/view-email/tok', {
      view_in_browser_label: 'Read this online',
    })
    expect(out).toContain('Read this online')
    expect(out).not.toContain(DEFAULT_VIEW_IN_BROWSER_LABEL)
  })

  it('renders the operator note on the hosted copy', () => {
    const out = renderCampaignWebView(
      { id: CAMPAIGN_ID, html_content: HTML_DOC },
      { copy: { hosted_copy_note: 'This page is a copy of an email we sent.' } },
    )
    expect(out).toContain('This page is a copy of an email we sent.')
    expect(out).not.toContain(DEFAULT_HOSTED_COPY_NOTE)
  })

  it('is unchanged when no copy is supplied', () => {
    expect(prependViewInBrowserLink(HTML_DOC, 'https://x/y'))
      .toBe(prependViewInBrowserLink(HTML_DOC, 'https://x/y', null))
  })

  it('escapes operator copy — it is interpolated into markup, not rendered by React', () => {
    // This copy lands in a public page AND in every recipient's inbox. An
    // operator must not be able to close the surrounding tag, let alone
    // inject one.
    const out = prependViewInBrowserLink(HTML_DOC, 'https://x/y', {
      view_in_browser_label: '</a><script>alert(1)</script>',
    })
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')

    const page = renderCampaignWebView(
      { id: CAMPAIGN_ID, html_content: HTML_DOC },
      { copy: { hosted_copy_note: '<img src=x onerror=alert(1)>' } },
    )
    expect(page).not.toContain('<img src=x')
    expect(page).toContain('&lt;img')
  })

  it('keeps the customer-copy conventions on both defaults', () => {
    for (const s of [DEFAULT_VIEW_IN_BROWSER_LABEL, DEFAULT_HOSTED_COPY_NOTE]) {
      expect(s).not.toContain('—')
    }
  })
})
