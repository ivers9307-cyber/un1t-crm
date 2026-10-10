// EVENT-MOVE.6 — the signed link that lets the person who booked an entry
// manage it (/event/entry/[token]). Round-trip, tamper, expiry, wrong secret,
// and that no other token signed with the same key passes as one.

import { describe, it, expect, vi, afterEach } from 'vitest'
import crypto from 'node:crypto'
import {
  signEntryManageToken,
  verifyEntryManageToken,
  entryManageUrl,
  ENTRY_MANAGE_TOKEN_TTL_MS,
} from './entry-manage-tokens.js'
import { signCheckinToken } from './event-checkin-tokens.js'
import { signHostOnboardingToken } from './host-onboarding-tokens.js'

const SECRET = 'test-secret-123'
const REG = '80000000-0000-0000-0000-000000000001'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (payload, secret = SECRET) => crypto.createHmac('sha256', secret).update(payload).digest('base64url')

afterEach(() => { vi.unstubAllEnvs() })

describe('entry manage tokens', () => {
  it('round-trips a registration id as base64url payload.sig', () => {
    const t = signEntryManageToken({ registrationId: REG }, SECRET)
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(verifyEntryManageToken(t, SECRET)).toEqual({ registrationId: REG })
  })

  it('is valid for 90 days', () => {
    expect(ENTRY_MANAGE_TOKEN_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000)
  })

  it('rejects a payload re-pointed at another entry under the old signature', () => {
    const t = signEntryManageToken({ registrationId: REG }, SECRET)
    const sig = t.split('.')[1]
    const forged = b64({ r: 'someone-else', k: 'entry_manage', iat: Date.now() })
    expect(verifyEntryManageToken(`${forged}.${sig}`, SECRET)).toBeNull()
  })

  it('rejects a bad signature, a wrong secret and an empty secret', () => {
    const t = signEntryManageToken({ registrationId: REG }, SECRET)
    expect(verifyEntryManageToken(`${t.split('.')[0]}.deadbeef`, SECRET)).toBeNull()
    expect(verifyEntryManageToken(t, 'another-secret')).toBeNull()
    expect(verifyEntryManageToken(t, '')).toBeNull()
    expect(verifyEntryManageToken(t, null)).toBeNull()
  })

  it.each([
    ['empty', ''],
    ['not a string', 42],
    ['one part', 'abc'],
    ['three parts', 'a.b.c'],
    ['an empty half', '.sig'],
  ])('rejects a malformed token (%s)', (_w, token) => {
    expect(verifyEntryManageToken(token, SECRET)).toBeNull()
  })

  it('expires after the TTL, and accepts it just before', () => {
    const now = Date.UTC(2026, 9, 9)
    const t = signEntryManageToken({ registrationId: REG }, SECRET, { nowMs: now })
    expect(verifyEntryManageToken(t, SECRET, { nowMs: now + ENTRY_MANAGE_TOKEN_TTL_MS - 1 })).toEqual({ registrationId: REG })
    expect(verifyEntryManageToken(t, SECRET, { nowMs: now + ENTRY_MANAGE_TOKEN_TTL_MS + 1 })).toBeNull()
  })

  it('rejects a token stamped in the future and one with no iat (fail closed)', () => {
    const now = Date.UTC(2026, 9, 9)
    const future = b64({ r: REG, k: 'entry_manage', iat: now + 10 * 60_000 })
    expect(verifyEntryManageToken(`${future}.${sign(future)}`, SECRET, { nowMs: now })).toBeNull()
    const unstamped = b64({ r: REG, k: 'entry_manage' })
    expect(verifyEntryManageToken(`${unstamped}.${sign(unstamped)}`, SECRET, { nowMs: now })).toBeNull()
  })

  it('never accepts another kind of token signed with the same key', () => {
    const checkin = signCheckinToken({ eventId: 'e1', registrationId: REG, memberId: 'm1' }, SECRET)
    const host = signHostOnboardingToken({ hostId: REG }, SECRET)
    expect(verifyEntryManageToken(checkin, SECRET)).toBeNull()
    expect(verifyEntryManageToken(host, SECRET)).toBeNull()
  })

  it('refuses to sign with no secret or no id', () => {
    expect(() => signEntryManageToken({ registrationId: REG }, '')).toThrow()
    expect(() => signEntryManageToken({ registrationId: '' }, SECRET)).toThrow()
  })
})

describe('entryManageUrl', () => {
  it('is the app origin + /event/entry/<token>, signed with the service-role key', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.test/')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET)
    const url = entryManageUrl(REG)
    expect(url).toMatch(/^https:\/\/crm\.test\/event\/entry\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(verifyEntryManageToken(url.split('/').pop(), SECRET)).toEqual({ registrationId: REG })
  })

  it('is null (no link) without a key, an app url or an id, and never throws', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.test')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    expect(entryManageUrl(REG)).toBeNull()
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET)
    expect(entryManageUrl(null)).toBeNull()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(entryManageUrl(REG)).toBeNull()
  })
})
