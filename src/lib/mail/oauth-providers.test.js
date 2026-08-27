// MAILBOX-OAUTH.1 — the provider registry and the signed round trip.
//
// This file is pure, so its tests are too: no fetch, no DB, no clock beyond an
// injected one. What it pins:
//
//   1. 🔴 GOOGLE IS PRESENT AND REFUSING, WITH THE REAL REASON. The whole
//      product decision lives in one string, and the string has to keep naming
//      app verification and the CASA assessment — a refusal that degrades to
//      "not supported" sends an operator to an engineer instead of to a
//      purchase decision. Pinned by content, not by a boolean.
//   2. MICROSOFT ASKS FOR EXCHANGE ONLINE'S SCOPES, NOT GRAPH'S. Microsoft
//      issues a token for ONE resource per request; a Graph spelling here
//      fails the token call outright, and it fails it long after the operator
//      has granted consent.
//   3. THE THREE REFUSALS STAY APART. `unknown_provider`, `provider_unavailable`
//      and `not_configured` have three different fixes and one symptom.
//   4. THE STATE IS A CAPABILITY, so it must be unforgeable, unreplayable past
//      its TTL, and refused outright when it carries no expiry at all.
//   5. NO SECRET REACHES THE AUTHORIZE URL. The client id does (it is public by
//      construction); the client secret never does — that URL is a browser
//      navigation, a provider log line and a screenshot.

import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import {
  OAUTH_PROVIDERS,
  OAUTH_CALLBACK_PATH,
  STATE_COOKIE,
  STATE_TTL_MS,
  oauthProviderCatalogue,
  resolveOAuthProvider,
  callbackUrl,
  buildAuthorizeUrl,
  signState,
  verifyState,
} from './oauth-providers'

const SECRET = 'test-cron-secret-not-a-real-one'

/** An env with Microsoft configured and nothing else. */
const CONFIGURED = Object.freeze({
  MAILBOX_OAUTH_MICROSOFT_CLIENT_ID: 'client-id-1234',
  MAILBOX_OAUTH_MICROSOFT_CLIENT_SECRET: 'client-secret-shhh',
})

describe('the catalogue — what a browser is told', () => {
  it('names every provider with a usable status', () => {
    const cat = oauthProviderCatalogue()
    expect(cat.map(p => p.key).sort()).toEqual(['google', 'microsoft'])
    for (const entry of cat) {
      expect(typeof entry.label).toBe('string')
      expect(['available', 'unavailable']).toContain(entry.status)
    }
  })

  it('carries no client id, no secret and no env var value', () => {
    const serialised = JSON.stringify(oauthProviderCatalogue())
    expect(serialised).not.toContain('clientId')
    expect(serialised).not.toContain('clientSecret')
    expect(serialised).not.toContain('CLIENT_SECRET')
    // Nor the env var NAMES, which belong in a 503 an engineer reads, not in a
    // payload every settings page renders.
    expect(serialised).not.toContain('MAILBOX_OAUTH_')
  })

  it('is a table of product facts — the same answer whatever the environment', () => {
    // Deliberately not env-injectable: an operator on a deployment missing the
    // Microsoft client id must still be told Microsoft is the supported path,
    // because the fix belongs to us and the SHAPE of the product has not
    // changed. `not_configured` is a separate, 503-shaped answer from ../start.
    expect(oauthProviderCatalogue()).toEqual(oauthProviderCatalogue())
  })

  it('says nothing about why an AVAILABLE provider is unavailable', () => {
    const microsoft = oauthProviderCatalogue().find(p => p.key === 'microsoft')
    expect(microsoft.status).toBe('available')
    expect(microsoft.unavailableReason).toBeNull()
  })
})

describe('🔴 Google — present, refusing, and naming the real blocker', () => {
  const google = () => oauthProviderCatalogue().find(p => p.key === 'google')

  it('is in the registry rather than absent from it', () => {
    // Absence would read as "we never thought about Gmail". An operator who
    // cannot find Google concludes the connector is broken; one who is told
    // why has something to escalate.
    expect(OAUTH_PROVIDERS.google).toBeTruthy()
    expect(google()).toBeTruthy()
  })

  it('is unavailable, and says so as a status rather than by omission', () => {
    expect(google().status).toBe('unavailable')
  })

  // 🔴 THE SENTENCE IS THE DELIVERABLE. Softening it to "not supported" is the
  // regression this test exists to catch: the difference between a decision a
  // business can take and a dead end.
  it('names OAuth app verification AND the annual CASA Tier 2 assessment', () => {
    const reason = google().unavailableReason
    expect(reason).toMatch(/verification/i)
    expect(reason).toMatch(/CASA/)
    expect(reason).toMatch(/Tier 2/i)
    expect(reason).toMatch(/annual/i)
  })

  it('names the restricted scope that forces all of it', () => {
    expect(google().unavailableReason).toContain('https://mail.google.com/')
  })

  it('closes off the "just leave it in Testing" workaround, with the 7 days', () => {
    // The single most likely wrong idea anyone reading this will have.
    expect(google().unavailableReason).toMatch(/7 days/)
  })

  it('points at the app-password path, which works today', () => {
    expect(google().unavailableReason).toMatch(/app password/i)
  })

  it('refuses a start attempt with `provider_unavailable`, not `not_configured`', () => {
    // Even with a Google client id sitting in the environment. The blocker is
    // not a missing env var, and telling an operator it is would have them ask
    // an engineer to set something that will not help.
    const verdict = resolveOAuthProvider('google', {
      env: {
        ...CONFIGURED,
        MAILBOX_OAUTH_GOOGLE_CLIENT_ID: 'a-google-client-id',
        MAILBOX_OAUTH_GOOGLE_CLIENT_SECRET: 'a-google-secret',
      },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('provider_unavailable')
    expect(verdict.error).toMatch(/CASA/)
  })

  // 🔴 THE TRAP WAITING FOR WHOEVER TURNS GOOGLE ON.
  //
  // `email_mailbox_credentials.provider` is CHECK-constrained to
  // ('gmail','microsoft','custom') — verified against the live database
  // 2026-08-27 — and the callback writes `provider.config.key` into it. This
  // entry's key is 'google', which that CHECK does NOT accept. Inert today,
  // because an `unavailable` provider can never reach a write. The moment the
  // status flips it becomes a 23514 at the LAST step of the flow: after
  // consent, with a live grant standing at Google that nothing on our side
  // refers to — the precise failure the whole route is ordered to avoid.
  //
  // Stated as a test rather than only as a comment, because the change that
  // triggers it is a one-word edit somebody will make months from now.
  it('🔴 needs a migration (or a rename to `gmail`) before its status can flip', () => {
    const COLUMN_ACCEPTS = ['gmail', 'microsoft', 'custom']
    expect(OAUTH_PROVIDERS.google.status).toBe('unavailable')
    expect(COLUMN_ACCEPTS).not.toContain(OAUTH_PROVIDERS.google.key)
  })

  it('keeps its endpoints and scopes correct for the day verification lands', () => {
    // The entry is not a placeholder. Flipping `status` plus supplying a client
    // id is meant to be the whole change, so the values are pinned now, while
    // somebody has the documentation open.
    expect(OAUTH_PROVIDERS.google.scopes).toEqual(['https://mail.google.com/'])
    expect(OAUTH_PROVIDERS.google.tokenUrl()).toBe('https://oauth2.googleapis.com/token')
    expect(OAUTH_PROVIDERS.google.imap_host).toBe('imap.gmail.com')
  })
})

describe('Microsoft — the one that ships', () => {
  it('resolves when the deployment has a client id and secret', () => {
    const verdict = resolveOAuthProvider('microsoft', { env: CONFIGURED })
    expect(verdict.ok).toBe(true)
    expect(verdict.config.clientId).toBe('client-id-1234')
  })

  // 🔴 EXCHANGE ONLINE'S SCOPES, NOT GRAPH'S. A token is issued for ONE
  // resource; a Graph spelling mixed in here fails the token request, and it
  // fails it AFTER the operator has already granted consent.
  it('asks for outlook.office.com IMAP and SMTP scopes, never Graph', () => {
    const { config } = resolveOAuthProvider('microsoft', { env: CONFIGURED })
    expect(config.scopes).toContain('https://outlook.office.com/IMAP.AccessAsUser.All')
    expect(config.scopes).toContain('https://outlook.office.com/SMTP.Send')
    expect(config.scopes.join(' ')).not.toMatch(/graph\.microsoft\.com/)
  })

  // Without this the mailbox works for one access-token lifetime and then
  // stops, which looks exactly like a bug in our poller and is not.
  it('asks for offline_access, or there would be no refresh token at all', () => {
    const { config } = resolveOAuthProvider('microsoft', { env: CONFIGURED })
    expect(config.scopes).toContain('offline_access')
  })

  // SMTP.Send is requested up front even for a receive-only mailbox: an
  // incremental-consent prompt on a settings screen months after connecting
  // reads as the app having been compromised.
  it('asks for send permission at the first consent, not at the first reply', () => {
    const { config } = resolveOAuthProvider('microsoft', { env: CONFIGURED })
    expect(config.scopes).toContain('https://outlook.office.com/SMTP.Send')
  })

  it('defaults to the `common` tenant so personal Outlook accounts work', () => {
    const { config } = resolveOAuthProvider('microsoft', { env: CONFIGURED })
    expect(config.authorizeUrl).toContain('/common/oauth2/v2.0/authorize')
    expect(config.tokenUrl).toContain('/common/oauth2/v2.0/token')
  })

  it('honours a pinned tenant when the deployment sets one', () => {
    const { config } = resolveOAuthProvider('microsoft', {
      env: { ...CONFIGURED, MAILBOX_OAUTH_MICROSOFT_TENANT: 'contoso.onmicrosoft.com' },
    })
    expect(config.authorizeUrl).toContain('/contoso.onmicrosoft.com/oauth2/v2.0/authorize')
  })

  it('falls back to `common` for a tenant env var that is present but blank', () => {
    const { config } = resolveOAuthProvider('microsoft', {
      env: { ...CONFIGURED, MAILBOX_OAUTH_MICROSOFT_TENANT: '   ' },
    })
    expect(config.authorizeUrl).toContain('/common/')
  })

  // 🔴 465 is implicit TLS, 587 is STARTTLS. Pairing 587 with secure:true fails
  // as an opaque connect timeout rather than as a TLS error, which is why the
  // pair is asserted together and never typed apart.
  it('pairs 993/TLS for IMAP and 587/STARTTLS for SMTP', () => {
    const { config } = resolveOAuthProvider('microsoft', { env: CONFIGURED })
    expect(config.imap_host).toBe('outlook.office365.com')
    expect(config.imap_port).toBe(993)
    expect(config.imap_secure).toBe(true)
    expect(config.smtp_host).toBe('smtp.office365.com')
    expect(config.smtp_port).toBe(587)
    expect(config.smtp_secure).toBe(false)
  })

  it('knows the Sent folder the coexistence lane polls', () => {
    const { config } = resolveOAuthProvider('microsoft', { env: CONFIGURED })
    expect(config.sent_folder).toBe('Sent Items')
  })

  it('hands back a COPY, so a caller cannot edit the module table', () => {
    const a = resolveOAuthProvider('microsoft', { env: CONFIGURED })
    a.config.scopes.push('https://graph.microsoft.com/Mail.Read')
    const b = resolveOAuthProvider('microsoft', { env: CONFIGURED })
    expect(b.config.scopes).not.toContain('https://graph.microsoft.com/Mail.Read')
  })
})

describe('every WRITABLE provider key is one the credentials column accepts', () => {
  // The callback writes `config.key` into
  // `email_mailbox_credentials.provider`, whose CHECK is
  // ('gmail','microsoft','custom'). A provider that can complete a flow and
  // then cannot be stored is a grant issued at the provider for nothing.
  const COLUMN_ACCEPTS = ['gmail', 'microsoft', 'custom']

  it('holds for every provider marked available', () => {
    const writable = Object.values(OAUTH_PROVIDERS).filter(p => p.status === 'available')
    // Guard against the assertion silently covering nothing.
    expect(writable.length).toBeGreaterThan(0)
    for (const p of writable) expect(COLUMN_ACCEPTS).toContain(p.key)
  })
})

describe('the three refusals stay apart — three fixes, one symptom', () => {
  it('`unknown_provider` for a key nothing in this build knows', () => {
    const verdict = resolveOAuthProvider('yahoo', { env: CONFIGURED })
    expect(verdict).toMatchObject({ ok: false, reason: 'unknown_provider' })
  })

  it('`not_configured` for a known, available provider with no client id', () => {
    const verdict = resolveOAuthProvider('microsoft', { env: {} })
    expect(verdict.reason).toBe('not_configured')
  })

  it('`not_configured` when the id is present but the secret is not', () => {
    const verdict = resolveOAuthProvider('microsoft', {
      env: { MAILBOX_OAUTH_MICROSOFT_CLIENT_ID: 'id-only' },
    })
    expect(verdict.reason).toBe('not_configured')
  })

  it('treats a whitespace-only client id as absent', () => {
    const verdict = resolveOAuthProvider('microsoft', {
      env: { MAILBOX_OAUTH_MICROSOFT_CLIENT_ID: '  ', MAILBOX_OAUTH_MICROSOFT_CLIENT_SECRET: 'x' },
    })
    expect(verdict.reason).toBe('not_configured')
  })

  // The env var NAMES turn "it does not work" into a ticket somebody can
  // close. The VALUES are never touched.
  it('names the env vars in the not_configured sentence, never their values', () => {
    const verdict = resolveOAuthProvider('microsoft', {
      env: { MAILBOX_OAUTH_MICROSOFT_CLIENT_ID: '', MAILBOX_OAUTH_MICROSOFT_CLIENT_SECRET: 'super-secret' },
    })
    expect(verdict.error).toContain('MAILBOX_OAUTH_MICROSOFT_CLIENT_ID')
    expect(verdict.error).not.toContain('super-secret')
  })

  it('never throws, whatever it is handed', () => {
    for (const junk of [null, undefined, 0, '', {}, [], NaN, Symbol.iterator.toString()]) {
      expect(() => resolveOAuthProvider(junk, { env: CONFIGURED })).not.toThrow()
      expect(resolveOAuthProvider(junk, { env: CONFIGURED }).ok).toBe(false)
    }
  })

  it('normalises case and surrounding whitespace', () => {
    expect(resolveOAuthProvider('  MICROSOFT ', { env: CONFIGURED }).ok).toBe(true)
  })

  // A key like `constructor` or `toString` finds a function on Object.prototype
  // in a naive lookup, and `provider.status !== 'available'` on a function is
  // true — so it would land on `provider_unavailable` with an undefined reason
  // rather than on `unknown_provider`.
  it('does not mistake an Object.prototype key for a provider', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(resolveOAuthProvider(key, { env: CONFIGURED }).reason).toBe('unknown_provider')
    }
  })
})

describe('the redirect URI — one static path for the whole estate', () => {
  it('is a fixed path with no tenant in it', () => {
    // Every location and every mailbox would otherwise need its own registered
    // URI, which no identity provider will do.
    expect(OAUTH_CALLBACK_PATH).toBe('/api/email/oauth/callback')
    expect(OAUTH_CALLBACK_PATH).not.toMatch(/\[|locations|mailboxes/)
  })

  it('builds an absolute URL from the app origin', () => {
    expect(callbackUrl('https://crm.repset.ie')).toBe('https://crm.repset.ie/api/email/oauth/callback')
  })

  it('tolerates a trailing slash without doubling it', () => {
    // A double slash is a different string to the provider, and a byte
    // difference in a redirect_uri is an `invalid_grant` that reads exactly
    // like a revoked consent.
    expect(callbackUrl('https://crm.repset.ie/')).toBe('https://crm.repset.ie/api/email/oauth/callback')
    expect(callbackUrl('https://crm.repset.ie///')).toBe('https://crm.repset.ie/api/email/oauth/callback')
  })
})

describe('the authorize URL', () => {
  const build = (extra = {}) => new URL(buildAuthorizeUrl({
    config: resolveOAuthProvider('microsoft', { env: CONFIGURED }).config,
    state: 'STATE-VALUE',
    redirectUri: 'https://crm.repset.ie/api/email/oauth/callback',
    ...extra,
  }))

  it('carries the client id, the code response type and the exact redirect', () => {
    const u = build()
    expect(u.searchParams.get('client_id')).toBe('client-id-1234')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('redirect_uri')).toBe('https://crm.repset.ie/api/email/oauth/callback')
    expect(u.searchParams.get('response_mode')).toBe('query')
  })

  it('space-joins the scopes the way the spec requires', () => {
    expect(build().searchParams.get('scope'))
      .toBe('https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access')
  })

  // Without prompt=consent, a user who authorised under an older scope list is
  // re-issued a token carrying the PREVIOUS scopes — so adding SMTP.Send later
  // appears to work and then fails at the first reply. It is also what
  // guarantees a refresh token comes back at all.
  it('forces a consent prompt', () => {
    expect(build().searchParams.get('prompt')).toBe('consent')
  })

  it('pre-fills the account picker when a hint is supplied, and omits it otherwise', () => {
    expect(build({ loginHint: 'hello@theirgym.ie' }).searchParams.get('login_hint')).toBe('hello@theirgym.ie')
    expect(build({ loginHint: undefined }).searchParams.has('login_hint')).toBe(false)
    expect(build({ loginHint: '' }).searchParams.has('login_hint')).toBe(false)
  })

  // 🔴 THIS URL IS A BROWSER NAVIGATION, A PROVIDER LOG LINE AND A SCREENSHOT.
  it('never carries the client secret', () => {
    expect(build().toString()).not.toContain('client-secret-shhh')
    expect(build().searchParams.has('client_secret')).toBe(false)
  })
})

describe('the state — a signed, expiring capability', () => {
  const payload = () => ({
    nonce: 'abcd', locationId: 'loc-1', mailboxId: 'mb-1',
    provider: 'microsoft', profileId: 'user-1', ts: Date.now(),
  })

  it('round-trips a payload intact', () => {
    const p = payload()
    expect(verifyState(signState(p, SECRET), SECRET)).toEqual(p)
  })

  it('refuses a payload signed with a different key', () => {
    expect(verifyState(signState(payload(), 'another-secret'), SECRET)).toBeNull()
  })

  it('refuses a tampered payload — the mailbox id cannot be swapped', () => {
    // The attack this stops: complete a consent flow with YOUR mailbox and
    // rewrite the state so it binds to somebody else's studio.
    const signed = signState(payload(), SECRET)
    const [raw, sig] = signed.split('.')
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString())
    decoded.mailboxId = 'mb-someone-elses'
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${sig}`
    expect(verifyState(forged, SECRET)).toBeNull()
  })

  it('refuses a tampered signature', () => {
    const [raw] = signState(payload(), SECRET).split('.')
    expect(verifyState(`${raw}.not-the-signature`, SECRET)).toBeNull()
  })

  it('refuses anything malformed, and never throws', () => {
    for (const junk of ['', '.', 'nodot', 'a.b.c.d', null, undefined, 42, {}, 'a.']) {
      expect(() => verifyState(junk, SECRET)).not.toThrow()
      expect(verifyState(junk, SECRET)).toBeNull()
    }
  })

  it('refuses when no signing secret is configured', () => {
    // Otherwise an HMAC keyed on an empty string would verify, which is the
    // same as no signature at all.
    expect(verifyState(signState(payload(), SECRET), '')).toBeNull()
    expect(verifyState(signState(payload(), SECRET), undefined)).toBeNull()
  })

  it('refuses a payload that is valid JSON but not an object', () => {
    const raw = Buffer.from(JSON.stringify('just-a-string')).toString('base64url')
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64url')
    expect(verifyState(`${raw}.${sig}`, SECRET)).toBeNull()
  })

  it('expires on the TTL', () => {
    const now = Date.now()
    const signed = signState({ ...payload(), ts: now }, SECRET)
    expect(verifyState(signed, SECRET, { now: now + STATE_TTL_MS - 1000 })).toBeTruthy()
    expect(verifyState(signed, SECRET, { now: now + STATE_TTL_MS + 1000 })).toBeNull()
  })

  // 🔴 A SIGNED STATE WITH NO EXPIRY WOULD BE A CAPABILITY THAT NEVER DIES,
  // sitting in whatever browser history, proxy log or shared screenshot it
  // landed in. Refused rather than trusted.
  it('refuses a correctly-signed payload that carries no `ts`', () => {
    const { ts, ...noTs } = payload()
    expect(ts).toBeTruthy()
    expect(verifyState(signState(noTs, SECRET), SECRET)).toBeNull()
  })

  it('refuses a `ts` that is not a finite number', () => {
    for (const bad of ['soon', null, {}, Infinity, NaN]) {
      expect(verifyState(signState({ ...payload(), ts: bad }, SECRET), SECRET)).toBeNull()
    }
  })

  it('refuses a state stamped far in the future', () => {
    // Clock skew big enough that the TTL means nothing.
    const now = Date.now()
    const signed = signState({ ...payload(), ts: now + STATE_TTL_MS * 5 }, SECRET)
    expect(verifyState(signed, SECRET, { now })).toBeNull()
  })

  it('holds the TTL at ten minutes and the cookie name stable', () => {
    // Both halves of the flow read these; a change to either without the other
    // makes the signature and the cookie disagree about staleness.
    expect(STATE_TTL_MS).toBe(10 * 60_000)
    expect(STATE_COOKIE).toBe('mailbox_oauth_state')
  })

  it('produces a different value for two flows started in the same millisecond', () => {
    // The nonce is what makes the cookie comparison a comparison of THIS flow.
    const now = Date.now()
    const a = signState({ ...payload(), nonce: 'aaa', ts: now }, SECRET)
    const b = signState({ ...payload(), nonce: 'bbb', ts: now }, SECRET)
    expect(a).not.toBe(b)
  })
})
