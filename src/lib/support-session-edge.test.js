// SUPPORT-ACCESS (Repset Phase 3) — the read-only enforcement DECISION +
// the signed-cookie sign/verify round-trip, tested in isolation. The
// decision here is the security crux mirrored by src/proxy.js.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SUPPORT_COOKIE,
  SUPPORT_MODES,
  SUPPORT_CONTROL_PATHS,
  signSupportPayload,
  verifySupportCookie,
  readSupportModeEdge,
  decideSupportWriteBlock,
} from './support-session-edge.js'

beforeEach(() => {
  vi.stubEnv('SUPPORT_SESSION_SECRET', 'test-support-secret-0123456789')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const reqWithCookie = (value) => ({
  cookies: { get: (name) => (name === SUPPORT_COOKIE && value != null ? { value } : undefined) },
})

describe('decideSupportWriteBlock — the read-only write block (fail closed)', () => {
  const RO = { active: true, mode: SUPPORT_MODES.READ_ONLY }
  const AOB = { active: true, mode: SUPPORT_MODES.ACT_ON_BEHALF }

  it('read-only session + mutating method → BLOCK', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
      expect(decideSupportWriteBlock(RO, m, '/api/contacts').block).toBe(true)
    }
  })

  it('read-only session + safe method → allow', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(decideSupportWriteBlock(RO, m, '/api/contacts').block).toBe(false)
    }
  })

  it('read-only session + server-action POST to a PAGE route → BLOCK (covers server actions)', () => {
    expect(decideSupportWriteBlock(RO, 'POST', '/portfolio').block).toBe(true)
    expect(decideSupportWriteBlock(RO, 'POST', '/settings/staff').block).toBe(true)
  })

  it('act-on-behalf session + mutating method → allow (scoped writes)', () => {
    expect(decideSupportWriteBlock(AOB, 'POST', '/api/contacts').block).toBe(false)
    expect(decideSupportWriteBlock(AOB, 'DELETE', '/api/contacts/1').block).toBe(false)
  })

  it('no active support session → allow (normal traffic untouched)', () => {
    expect(decideSupportWriteBlock({ active: false }, 'POST', '/api/contacts').block).toBe(false)
    expect(decideSupportWriteBlock(null, 'POST', '/api/contacts').block).toBe(false)
  })

  it('read-only session + control route → allow (exit / switch / stop always reachable)', () => {
    for (const p of SUPPORT_CONTROL_PATHS) {
      expect(decideSupportWriteBlock(RO, 'POST', p).block).toBe(false)
    }
    // nested under a control prefix too
    expect(decideSupportWriteBlock(RO, 'POST', '/api/support-session/exit').block).toBe(false)
  })

  it('FAIL CLOSED — an active session whose mode is NOT exactly act_on_behalf blocks writes', () => {
    for (const mode of ['read_only', 'unknown', '', undefined, null, 'ACT_ON_BEHALF']) {
      expect(decideSupportWriteBlock({ active: true, mode }, 'POST', '/api/contacts').block).toBe(true)
    }
  })
})

describe('sign / verify round-trip', () => {
  it('a signed payload verifies back to the same object', async () => {
    const payload = { sid: 's1', org: 'org-a', mode: 'read_only', master: 'm1', imp: 'o1', iat: 1, exp: 9e15 }
    const cookie = await signSupportPayload(payload)
    expect(cookie).toContain('.')
    const back = await verifySupportCookie(cookie)
    expect(back).toMatchObject(payload)
  })

  it('a tampered payload fails verification', async () => {
    const cookie = await signSupportPayload({ org: 'org-a', mode: 'read_only', exp: 9e15 })
    const [p, s] = cookie.split('.')
    // Flip the payload but keep the old signature.
    const forged = await signSupportPayload({ org: 'org-a', mode: 'act_on_behalf', exp: 9e15 })
    const forgedPayload = forged.split('.')[0]
    expect(await verifySupportCookie(`${forgedPayload}.${s}`)).toBeNull()
    expect(await verifySupportCookie(`${p}.deadbeef`)).toBeNull()
    expect(await verifySupportCookie('garbage')).toBeNull()
  })

  it('a cookie signed with a different secret does not verify', async () => {
    const cookie = await signSupportPayload({ org: 'org-a', mode: 'act_on_behalf', exp: 9e15 })
    vi.stubEnv('SUPPORT_SESSION_SECRET', 'a-completely-different-secret')
    expect(await verifySupportCookie(cookie)).toBeNull()
  })
})

describe('readSupportModeEdge — resolve state from the request (fail closed)', () => {
  it('no cookie → inactive', async () => {
    expect(await readSupportModeEdge(reqWithCookie(null))).toEqual({ active: false, mode: null })
    expect(await readSupportModeEdge({})).toEqual({ active: false, mode: null })
  })

  it('valid read_only cookie → active read_only', async () => {
    const cookie = await signSupportPayload({ org: 'org-a', mode: 'read_only', exp: Date.now() + 1e6 })
    const state = await readSupportModeEdge(reqWithCookie(cookie))
    expect(state.active).toBe(true)
    expect(state.mode).toBe('read_only')
    expect(state.org).toBe('org-a')
  })

  it('valid act_on_behalf cookie → active act_on_behalf', async () => {
    const cookie = await signSupportPayload({ org: 'org-a', mode: 'act_on_behalf', exp: Date.now() + 1e6 })
    const state = await readSupportModeEdge(reqWithCookie(cookie))
    expect(state.mode).toBe('act_on_behalf')
  })

  it('FAIL CLOSED — a present but unverifiable cookie resolves to read_only', async () => {
    const state = await readSupportModeEdge(reqWithCookie('tampered.cookie'))
    expect(state.active).toBe(true)
    expect(state.mode).toBe('read_only')
    expect(state.reason).toBe('unverified')
  })

  it('a validly-signed but EXPIRED cookie → inactive (does not block the master’s own writes)', async () => {
    const cookie = await signSupportPayload({ org: 'org-a', mode: 'act_on_behalf', exp: Date.now() - 1000 })
    const state = await readSupportModeEdge(reqWithCookie(cookie))
    expect(state.active).toBe(false)
    expect(state.reason).toBe('expired')
  })

  it('end-to-end: an unverifiable cookie + POST → BLOCK (tamper cannot upgrade to act_on_behalf)', async () => {
    const state = await readSupportModeEdge(reqWithCookie('forged'))
    expect(decideSupportWriteBlock(state, 'POST', '/api/contacts').block).toBe(true)
  })
})
