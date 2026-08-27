// MAILBOX-UNREACHABLE.1 — the two properties this module lives or dies on.
//
//   1. It MUST say `stillorgan@un1t.com` cannot receive. That is the live
//      defect; a version of this that stays quiet about it is worthless.
//   2. It MUST NOT say anything about a healthy mailbox that simply had no
//      mail. That is how warnings get ignored, and the first property is
//      worth nothing once nobody reads the screen.
//
// Both are asserted against the REAL MX answers observed on 2026-08-26, named
// in the fixtures below, so a reader can re-run `dig MX un1t.com` and check
// the premise rather than trusting the test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:dns/promises', () => ({ resolveMx: vi.fn() }))

import { resolveMx } from 'node:dns/promises'
import {
  classifyMailboxReachability,
  reachabilityNotice,
  resolveDeliveryMx,
  assessMailboxReachability,
  mailboxDomain,
  isPostmarkMx,
  _resetMxCache,
  POSTMARK_INBOUND_MX,
} from './mailbox-reachability'

// Observed live, 2026-08-26.
const GOOGLE_MX = [
  { priority: 10, exchange: 'aspmx.l.google.com' },
  { priority: 20, exchange: 'alt1.aspmx.l.google.com' },
  { priority: 50, exchange: 'aspmx3.googlemail.com' },
]
const POSTMARK_MX = [{ priority: 10, exchange: 'inbound.postmarkapp.com' }]

const STILLORGAN = { id: 'mb-still', address: 'stillorgan@un1t.com', is_default: true, ingress: 'postmark' }
const HATCH = { id: 'mb-hatch', address: 'accounts@hatchstreetfitness.com', is_default: true, ingress: 'postmark' }

beforeEach(() => {
  vi.clearAllMocks()
  _resetMxCache()
})
afterEach(() => { _resetMxCache() })

describe('mailboxDomain / isPostmarkMx', () => {
  it('splits on the LAST @ and normalises', () => {
    expect(mailboxDomain('Stillorgan@UN1T.com')).toBe('un1t.com')
    expect(mailboxDomain('a@b@example.com.')).toBe('example.com')
  })

  it('refuses anything it cannot split rather than guessing', () => {
    for (const bad of ['', 'no-at-sign', '@nolocal.com', 'trailing@', null, 42, 'has space@x.com']) {
      expect(mailboxDomain(bad)).toBeNull()
    }
  })

  it('recognises Postmark inbound however it is spelled', () => {
    expect(isPostmarkMx(POSTMARK_INBOUND_MX)).toBe(true)
    expect(isPostmarkMx('Inbound.PostmarkApp.com.')).toBe(true)
    expect(isPostmarkMx('aspmx.l.google.com')).toBe(false)
    // Not a suffix match on the bare word — a lookalike domain must not pass.
    expect(isPostmarkMx('inbound.postmarkapp.com.evil.test')).toBe(false)
  })
})

describe('classifyMailboxReachability — the four states', () => {
  it('un1t.com (Google MX, nothing ever arrived) is UNREACHABLE', () => {
    const v = classifyMailboxReachability({
      address: STILLORGAN.address, ingress: 'postmark',
      mxHosts: GOOGLE_MX.map(r => r.exchange), hasReceived: false,
    })
    expect(v.state).toBe('unreachable')
    expect(v.deliversTo).toBe('aspmx.l.google.com')
  })

  it('hatchstreetfitness.com (Postmark MX) is OK — with ZERO arrivals', () => {
    // THE ANTI-CRY-WOLF CASE. A studio address that had no mail this week, this
    // month, ever, still reads healthy: nothing in this verdict looks at volume.
    const v = classifyMailboxReachability({
      address: HATCH.address, ingress: 'postmark',
      mxHosts: ['inbound.postmarkapp.com'], hasReceived: false,
    })
    expect(v.state).toBe('ok')
    expect(reachabilityNotice(v, HATCH)).toBeNull()
  })

  it('a foreign MX that HAS received is INDIRECT, not unreachable', () => {
    const v = classifyMailboxReachability({
      address: STILLORGAN.address, ingress: 'postmark',
      mxHosts: GOOGLE_MX.map(r => r.exchange), hasReceived: true,
    })
    expect(v.state).toBe('indirect')
    expect(reachabilityNotice(v, STILLORGAN).tone).toBe('info')
  })

  it('a connected (imap) account is never graded on MX', () => {
    const v = classifyMailboxReachability({
      address: STILLORGAN.address, ingress: 'imap',
      mxHosts: GOOGLE_MX.map(r => r.exchange), hasReceived: false,
    })
    expect(v.state).toBe('connected')
    expect(reachabilityNotice(v, STILLORGAN)).toBeNull()
  })

  it('an unreadable lookup is UNKNOWN and says nothing at all', () => {
    const v = classifyMailboxReachability({
      address: STILLORGAN.address, ingress: 'postmark', mxHosts: null, hasReceived: false,
    })
    expect(v.state).toBe('unknown')
    expect(reachabilityNotice(v, STILLORGAN)).toBeNull()
  })

  it('a domain with NO MX at all is answerable, not unknown', () => {
    const v = classifyMailboxReachability({
      address: 'x@nomx.test', ingress: 'postmark', mxHosts: [], hasReceived: false,
    })
    expect(v.state).toBe('unreachable')
    expect(reachabilityNotice(v, {}).detail).toMatch(/publishes no mail exchanger/)
  })
})

describe('reachabilityNotice — what an owner reads', () => {
  const verdict = classifyMailboxReachability({
    address: STILLORGAN.address, ingress: 'postmark',
    mxHosts: GOOGLE_MX.map(r => r.exchange), hasReceived: false,
  })

  it('names the domain and the exchange, so the claim is checkable', () => {
    const n = reachabilityNotice(verdict, STILLORGAN)
    expect(n.detail).toContain('un1t.com')
    expect(n.detail).toContain('aspmx.l.google.com')
  })

  it('says the default account is answering members with nobody', () => {
    const n = reachabilityNotice(verdict, { ...STILLORGAN, is_default: true })
    expect(n.tone).toBe('error')
    expect(n.chip).toBe('Cannot receive')
    expect(n.detail).toMatch(/DEFAULT account/)
    expect(n.detail).toMatch(/answered by nobody/i)
  })

  it('offers BOTH remedies on the default — connect it, or move the default', () => {
    const n = reachabilityNotice(verdict, { ...STILLORGAN, is_default: true })
    expect(n.remedy).toMatch(/mailbox login/)
    expect(n.remedy).toMatch(/make that the default/)
  })

  it('drops the campaign sentence on a non-default account', () => {
    const n = reachabilityNotice(verdict, { ...STILLORGAN, is_default: false })
    expect(n.detail).not.toMatch(/DEFAULT account/)
    expect(n.remedy).toMatch(/remove this account/)
  })
})

describe('resolveDeliveryMx', () => {
  it('sorts by preference and normalises case + trailing dot', async () => {
    resolveMx.mockResolvedValue([
      { priority: 50, exchange: 'ASPMX3.googlemail.com.' },
      { priority: 10, exchange: 'aspmx.l.google.com.' },
    ])
    expect(await resolveDeliveryMx('un1t.com')).toEqual(['aspmx.l.google.com', 'aspmx3.googlemail.com'])
  })

  it('treats ENOTFOUND / ENODATA as "no MX", not as "could not tell"', async () => {
    for (const code of ['ENOTFOUND', 'ENODATA']) {
      _resetMxCache()
      resolveMx.mockRejectedValue(Object.assign(new Error(code), { code }))
      expect(await resolveDeliveryMx('nomx.test')).toEqual([])
    }
  })

  it('returns null on any other failure — the only "unknown"', async () => {
    resolveMx.mockRejectedValue(Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' }))
    expect(await resolveDeliveryMx('broken.test')).toBeNull()
  })

  it('memoises inside the TTL, including the null answer', async () => {
    resolveMx.mockRejectedValue(Object.assign(new Error('x'), { code: 'ESERVFAIL' }))
    await resolveDeliveryMx('broken.test')
    await resolveDeliveryMx('broken.test')
    expect(resolveMx).toHaveBeenCalledTimes(1)
  })

  it('re-asks once the TTL has passed', async () => {
    resolveMx.mockResolvedValue(POSTMARK_MX)
    await resolveDeliveryMx('a.test', { now: 0 })
    await resolveDeliveryMx('a.test', { now: 11 * 60 * 1000 })
    expect(resolveMx).toHaveBeenCalledTimes(2)
  })
})

describe('assessMailboxReachability — the live Stillorgan / Hatch pair', () => {
  // Minimal supabase double: only the one probe this function makes.
  function makeDb(inboundRows) {
    const q = {
      select: () => q,
      eq: () => q,
      ilike: () => q,
      limit: () => Promise.resolve({ data: inboundRows, error: null }),
    }
    return { from: () => q, _probes: 0 }
  }

  it('flags Stillorgan and leaves Hatch Street alone', async () => {
    resolveMx.mockImplementation(async (domain) =>
      domain === 'hatchstreetfitness.com' ? POSTMARK_MX : GOOGLE_MX)

    const out = await assessMailboxReachability(makeDb([]), 'loc-1', [STILLORGAN, HATCH])

    expect(out[STILLORGAN.id].state).toBe('unreachable')
    expect(out[STILLORGAN.id].notice.chip).toBe('Cannot receive')
    expect(out[HATCH.id].state).toBe('ok')
    expect(out[HATCH.id].notice).toBeNull()
  })

  it('does NOT probe the database when DNS already cleared every mailbox', async () => {
    resolveMx.mockResolvedValue(POSTMARK_MX)
    let probes = 0
    const db = { from: () => { probes += 1; return { select: () => ({}) } } }
    const out = await assessMailboxReachability(db, 'loc-1', [HATCH])
    expect(probes).toBe(0)
    expect(out[HATCH.id].state).toBe('ok')
  })

  it('asks DNS once per DISTINCT domain', async () => {
    resolveMx.mockResolvedValue(POSTMARK_MX)
    await assessMailboxReachability(makeDb([]), 'loc-1', [
      { id: 'a', address: 'studio@one.test', ingress: 'postmark' },
      { id: 'b', address: 'sales@one.test', ingress: 'postmark' },
      { id: 'c', address: 'x@two.test', ingress: 'postmark' },
    ])
    expect(resolveMx).toHaveBeenCalledTimes(2)
  })

  it('downgrades to indirect when the probe finds mail really did arrive', async () => {
    resolveMx.mockResolvedValue(GOOGLE_MX)
    const out = await assessMailboxReachability(makeDb([{ id: 'msg-1' }]), 'loc-1', [STILLORGAN])
    expect(out[STILLORGAN.id].state).toBe('indirect')
    expect(out[STILLORGAN.id].notice.tone).toBe('info')
  })

  it('stays SILENT rather than crying wolf when the probe itself errors', async () => {
    resolveMx.mockResolvedValue(GOOGLE_MX)
    const q = {
      select: () => q, eq: () => q, ilike: () => q,
      limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
    }
    const out = await assessMailboxReachability({ from: () => q }, 'loc-1', [STILLORGAN])
    expect(out[STILLORGAN.id].state).toBe('indirect')
  })

  it('returns {} for a location with no mailboxes and never touches DNS', async () => {
    expect(await assessMailboxReachability(makeDb([]), 'loc-1', [])).toEqual({})
    expect(resolveMx).not.toHaveBeenCalled()
  })
})
