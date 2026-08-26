import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { seal } from './secret-box.js'
import { resolveAuth } from './auth-strategy.js'

const KEY_A = crypto.randomBytes(32).toString('base64')
const KEY_B = crypto.randomBytes(32).toString('base64')

const ORIGINAL = process.env.MAILBOX_SECRET_KEY

function setKey(value) {
  if (value === undefined) delete process.env.MAILBOX_SECRET_KEY
  else process.env.MAILBOX_SECRET_KEY = value
}

const PASSWORD = 'abcd efgh ijkl mnop'
const TOKEN = 'ya29.a0-FAKE-ACCESS-TOKEN-VALUE'
const USER = 'hatchstreet@un1t.com'

beforeEach(() => setKey(KEY_A))
afterEach(() => setKey(ORIGINAL))

/** A credential row as PostgREST would hand it back. */
function passwordRow(overrides = {}) {
  return {
    mailbox_id: '00000000-0000-0000-0000-000000000001',
    provider: 'gmail',
    auth_type: 'password',
    username: USER,
    secret_ciphertext: seal(PASSWORD),
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_secure: true,
    ...overrides,
  }
}

function oauthRow(overrides = {}) {
  return {
    mailbox_id: '00000000-0000-0000-0000-000000000002',
    provider: 'microsoft',
    auth_type: 'oauth',
    username: USER,
    secret_ciphertext: null,
    oauth_access_token_ciphertext: seal(TOKEN),
    oauth_refresh_token_ciphertext: seal('refresh-token'),
    oauth_expires_at: '2999-01-01T00:00:00.000Z',
    imap_host: 'outlook.office365.com',
    imap_port: 993,
    imap_secure: true,
    ...overrides,
  }
}

describe('resolveAuth — password mode', () => {
  it('returns { user, pass } for a password credential', () => {
    const verdict = resolveAuth(passwordRow())
    expect(verdict.ok).toBe(true)
    expect(verdict.auth).toEqual({ user: USER, pass: PASSWORD })
  })

  it('returns EXACTLY { user, pass } — nothing extra rides along to imapflow', () => {
    const verdict = resolveAuth(passwordRow())
    expect(Object.keys(verdict.auth).sort()).toEqual(['pass', 'user'])
    expect(Object.keys(verdict).sort()).toEqual(['auth', 'ok'])
  })

  it('defaults an absent auth_type to password (mirrors the column default)', () => {
    const row = passwordRow()
    delete row.auth_type
    expect(resolveAuth(row)).toEqual({ ok: true, auth: { user: USER, pass: PASSWORD } })
  })

  it('normalises auth_type case and whitespace', () => {
    expect(resolveAuth(passwordRow({ auth_type: '  PASSWORD ' })).ok).toBe(true)
    expect(resolveAuth(oauthRow({ auth_type: 'OAuth' })).ok).toBe(true)
  })

  it('trims the username', () => {
    const verdict = resolveAuth(passwordRow({ username: `  ${USER}  ` }))
    expect(verdict.auth.user).toBe(USER)
  })
})

describe('resolveAuth — oauth mode (the seam)', () => {
  it('returns { user, accessToken } for an oauth credential', () => {
    const verdict = resolveAuth(oauthRow())
    expect(verdict.ok).toBe(true)
    expect(verdict.auth).toEqual({ user: USER, accessToken: TOKEN })
  })

  it('returns EXACTLY { user, accessToken } — never a pass alongside it', () => {
    const verdict = resolveAuth(oauthRow())
    expect(Object.keys(verdict.auth).sort()).toEqual(['accessToken', 'user'])
    expect(verdict.auth.pass).toBeUndefined()
  })

  it('accepts a row with no expiry rather than inventing an outage', () => {
    expect(resolveAuth(oauthRow({ oauth_expires_at: null })).ok).toBe(true)
    expect(resolveAuth(oauthRow({ oauth_expires_at: '' })).ok).toBe(true)
    expect(resolveAuth(oauthRow({ oauth_expires_at: 'not a date' })).ok).toBe(true)
  })

  it('accepts a Date object as well as an ISO string (driver-dependent)', () => {
    expect(resolveAuth(oauthRow({ oauth_expires_at: new Date('2999-01-01') })).ok).toBe(true)
  })
})

describe('resolveAuth — expired oauth', () => {
  const now = Date.parse('2026-08-26T12:00:00.000Z')

  it('reports oauth_expired for a token already past its expiry', () => {
    const verdict = resolveAuth(oauthRow({ oauth_expires_at: '2026-08-26T11:00:00.000Z' }), { now })
    expect(verdict).toEqual({
      ok: false,
      reason: 'oauth_expired',
      error: expect.any(String),
    })
  })

  it('reports oauth_expired for a token inside the 60s skew window', () => {
    const verdict = resolveAuth(oauthRow({ oauth_expires_at: '2026-08-26T12:00:30.000Z' }), { now })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('oauth_expired')
  })

  it('accepts a token comfortably outside the skew window', () => {
    const verdict = resolveAuth(oauthRow({ oauth_expires_at: '2026-08-26T12:30:00.000Z' }), { now })
    expect(verdict.ok).toBe(true)
  })

  it('judges expiry BEFORE decryption — an expired token needs a refresh, not a key', () => {
    // Sealed under KEY_A, resolved under KEY_B: the ciphertext is unopenable,
    // so an expiry check ordered after the decrypt would answer
    // decrypt_failed and send the operator hunting a key problem that is not
    // the reason this mailbox stopped working.
    const row = oauthRow({ oauth_expires_at: '2026-08-26T11:00:00.000Z' })
    setKey(KEY_B)
    expect(resolveAuth(row, { now }).reason).toBe('oauth_expired')
  })
})

describe('resolveAuth — missing credential', () => {
  it('reports not_configured for a null / undefined / non-object row', () => {
    for (const row of [null, undefined, 0, '', 'nope', false]) {
      const verdict = resolveAuth(row)
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toBe('not_configured')
      expect(typeof verdict.error).toBe('string')
    }
  })

  it('reports not_configured when the username is missing or blank', () => {
    expect(resolveAuth(passwordRow({ username: null })).reason).toBe('not_configured')
    expect(resolveAuth(passwordRow({ username: '   ' })).reason).toBe('not_configured')
  })

  it('reports not_configured when the password ciphertext is missing', () => {
    expect(resolveAuth(passwordRow({ secret_ciphertext: null })).reason).toBe('not_configured')
    expect(resolveAuth(passwordRow({ secret_ciphertext: '' })).reason).toBe('not_configured')
  })

  it('reports not_configured when the oauth token ciphertext is missing', () => {
    expect(resolveAuth(oauthRow({ oauth_access_token_ciphertext: null })).reason).toBe('not_configured')
  })

  it('reports not_configured — NOT decrypt_failed — when MAILBOX_SECRET_KEY is unset', () => {
    // The distinction matters operationally: a forgotten env var would
    // otherwise flip every mailbox in the estate to decrypt_failed at once,
    // which reads as a key compromise rather than a deploy mistake.
    const row = passwordRow()
    setKey(undefined)
    const verdict = resolveAuth(row)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('not_configured')
    expect(verdict.error).toMatch(/MAILBOX_SECRET_KEY/)
  })
})

describe('resolveAuth — decrypt failure', () => {
  it('reports decrypt_failed when the ciphertext will not open under the current key', () => {
    const row = passwordRow()
    setKey(KEY_B)
    const verdict = resolveAuth(row)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('decrypt_failed')
  })

  it('reports decrypt_failed for a tampered / garbage ciphertext', () => {
    expect(resolveAuth(passwordRow({ secret_ciphertext: 'v1:aaaa:bbbb:cccc' })).reason).toBe('decrypt_failed')
    expect(resolveAuth(passwordRow({ secret_ciphertext: 'plaintext-password' })).reason).toBe('decrypt_failed')
  })

  it('reports decrypt_failed for an oauth token that will not open', () => {
    const row = oauthRow()
    setKey(KEY_B)
    expect(resolveAuth(row).reason).toBe('decrypt_failed')
  })
})

describe('resolveAuth — unsupported auth type', () => {
  it('refuses an auth type this build cannot satisfy rather than guessing', () => {
    for (const authType of ['ntlm', 'xoauth2', 'gssapi', 'plain']) {
      const verdict = resolveAuth(passwordRow({ auth_type: authType }))
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toBe('unsupported_auth_type')
    }
  })
})

describe('resolveAuth — never throws', () => {
  it('survives a row whose property access throws', () => {
    const hostile = {
      username: USER,
      get auth_type() { throw new Error('boom') },
    }
    expect(() => resolveAuth(hostile)).not.toThrow()
    expect(resolveAuth(hostile).ok).toBe(false)
  })

  it('survives every shape a caller might hand it', () => {
    const shapes = [
      null, undefined, {}, [], 42, 'string', true, Symbol('s'),
      Object.create(null),
      { username: USER },
      { username: USER, auth_type: 'password' },
      { username: USER, auth_type: 'oauth' },
      { username: 123, secret_ciphertext: 456 },
    ]
    for (const shape of shapes) {
      expect(() => resolveAuth(shape)).not.toThrow()
      const verdict = resolveAuth(shape)
      expect(verdict.ok).toBe(false)
      expect(['not_configured', 'decrypt_failed', 'oauth_expired', 'unsupported_auth_type'])
        .toContain(verdict.reason)
    }
  })
})

// ── The guarantee this module exists to provide ──────────────────────────
// Every failure verdict is written to `email_mailbox_ingress.last_error`,
// shown on the connect screen, and fed to logError. One template literal in
// this file would put a customer's mailbox password in the database's error
// column, permanently, and in whatever log sink reads it.
describe('resolveAuth — the secret NEVER appears in a returned error', () => {
  it('holds across every failure path', () => {
    // Every row here carries the real secret somewhere reachable — as a
    // ciphertext, or spliced into a malformed envelope as literal text — so a
    // verdict that echoed any part of the row would be caught.
    const wrongKeyRow = passwordRow()          // sealed under KEY_A
    const wrongKeyOauthRow = oauthRow()        // sealed under KEY_A

    const rows = [
      passwordRow({ secret_ciphertext: `v1:aaaa:bbbb:${PASSWORD}` }),
      passwordRow({ secret_ciphertext: PASSWORD }),
      passwordRow({ auth_type: 'ntlm' }),
      passwordRow({ username: '' }),
      oauthRow({ oauth_expires_at: '2000-01-01T00:00:00.000Z' }),
      oauthRow({ oauth_access_token_ciphertext: TOKEN }),
      null,
    ]

    // Resolve the key-mismatch rows under the WRONG key, everything else
    // under the right one; both directions must stay silent.
    const verdicts = rows.map((row) => [row, resolveAuth(row)])
    setKey(KEY_B)
    verdicts.push([wrongKeyRow, resolveAuth(wrongKeyRow)])
    verdicts.push([wrongKeyOauthRow, resolveAuth(wrongKeyOauthRow)])

    for (const [row, verdict] of verdicts) {
      expect(verdict.ok).toBe(false)
      const blob = JSON.stringify(verdict)
      expect(blob).not.toContain(PASSWORD)
      expect(blob).not.toContain(TOKEN)
      expect(blob).not.toContain(KEY_A)
      expect(blob).not.toContain(KEY_B)
      expect(blob).not.toContain(USER)
      // and no fragment of the row's own stored ciphertext
      for (const field of ['secret_ciphertext', 'oauth_access_token_ciphertext', 'oauth_refresh_token_ciphertext']) {
        const value = row?.[field]
        if (typeof value === 'string' && value) expect(blob).not.toContain(value)
      }
    }
  })

  it('failure verdicts carry only ok / reason / error — never the row', () => {
    const verdict = resolveAuth(passwordRow({ auth_type: 'ntlm' }))
    expect(Object.keys(verdict).sort()).toEqual(['error', 'ok', 'reason'])
    expect(verdict.auth).toBeUndefined()
  })
})
