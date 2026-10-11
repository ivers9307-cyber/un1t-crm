// FROMDOMAIN — a campaign or sequence may send from ANY address on the org's
// VERIFIED sending domain, never from a domain the org has not verified.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./tenant-email.js', () => ({ resolveEmailSender: vi.fn() }))

import { resolveEmailSender } from './tenant-email.js'
import {
  pickFromAddress, isOnVerifiedDomain, withRequestedFrom, describeFromAddress, fromAddressReport,
} from './from-address.js'
import { addressDomain, wireFrom, resolvedFromOf } from './platform-sender.js'

// A LIVE tenant sender for un1tdublin.com, as resolveEmailSender hands it back.
const LIVE = Object.freeze({
  serverToken: 'srv-tok',
  fromEmail: 'hello@un1tdublin.com',
  fromName: 'UN1T',
  replyTo: 'hi@un1tdublin.com',
  sendingDomain: 'un1tdublin.com',
})
// The PRE-DOMAIN platform sender: no token, no sendingDomain.
const PLATFORM = Object.freeze({ serverToken: null, fromEmail: 'hello@platform.test', fromName: 'Gym A', replyTo: null })

beforeEach(() => { vi.clearAllMocks() })

describe('addressDomain', () => {
  it('lower-cases the domain of a bare address or a Name <addr> header', () => {
    expect(addressDomain('garrett@UN1TDublin.com')).toBe('un1tdublin.com')
    expect(addressDomain('Garrett <garrett@Mail.UN1TDublin.com>')).toBe('mail.un1tdublin.com')
  })
  it('null for anything that is not a plausible address', () => {
    for (const v of [null, undefined, '', 'garrett', 'garrett@', '@un1tdublin.com', 'a b@un1tdublin.com',
      'garrett@localhost', 'garrett@un1tdublin..com', 'x@y@un1tdublin.com', 'garrett@-un1tdublin.com']) {
      expect(addressDomain(v)).toBeNull()
    }
  })
})

describe('pickFromAddress', () => {
  it('a requested address on the live verified domain is used', () => {
    expect(pickFromAddress({ requested: 'garrett@un1tdublin.com', sender: LIVE })).toBe('garrett@un1tdublin.com')
  })

  it('an address on another domain falls back to the tenant fromEmail', () => {
    expect(pickFromAddress({ requested: 'x@other.com', sender: LIVE })).toBe('hello@un1tdublin.com')
  })

  it('with no live tenant domain the platform address goes out whatever was requested', () => {
    expect(pickFromAddress({ requested: 'garrett@un1tdublin.com', sender: PLATFORM })).toBe('hello@platform.test')
    expect(pickFromAddress({ requested: 'hello@platform.test', sender: PLATFORM })).toBe('hello@platform.test')
    // even an address on the PLATFORM's own domain is not borrowed
    expect(pickFromAddress({ requested: 'ceo@platform.test', sender: PLATFORM })).toBe('hello@platform.test')
  })

  it('a subdomain does not match its parent, and the parent does not match a subdomain', () => {
    expect(pickFromAddress({ requested: 'garrett@mail.un1tdublin.com', sender: LIVE })).toBe('hello@un1tdublin.com')
    const sub = { ...LIVE, fromEmail: 'hello@mail.un1tdublin.com', sendingDomain: 'mail.un1tdublin.com' }
    expect(pickFromAddress({ requested: 'garrett@un1tdublin.com', sender: sub })).toBe('hello@mail.un1tdublin.com')
    expect(pickFromAddress({ requested: 'garrett@mail.un1tdublin.com', sender: sub })).toBe('garrett@mail.un1tdublin.com')
  })

  it('a look-alike suffix does not match (evilun1tdublin.com, un1tdublin.com.evil.io)', () => {
    expect(pickFromAddress({ requested: 'g@evilun1tdublin.com', sender: LIVE })).toBe('hello@un1tdublin.com')
    expect(pickFromAddress({ requested: 'g@un1tdublin.com.evil.io', sender: LIVE })).toBe('hello@un1tdublin.com')
  })

  it('is case-insensitive on the domain and returns the address lower-cased', () => {
    expect(pickFromAddress({ requested: 'Garrett@UN1TDUBLIN.COM', sender: LIVE })).toBe('garrett@un1tdublin.com')
    expect(pickFromAddress({ requested: 'Sam@un1tdublin.com', sender: { ...LIVE, sendingDomain: 'UN1TDublin.com' } }))
      .toBe('sam@un1tdublin.com')
  })

  it('accepts a Name <addr> requested value but returns only the bare address', () => {
    expect(pickFromAddress({ requested: 'Alex <Alex@un1tdublin.com>', sender: LIVE })).toBe('alex@un1tdublin.com')
  })

  it('empty / invalid requested values fall back', () => {
    for (const requested of [null, undefined, '', '   ', 'garrett', 'garrett@un1tdublin', 'a b@un1tdublin.com']) {
      expect(pickFromAddress({ requested, sender: LIVE })).toBe('hello@un1tdublin.com')
    }
  })

  it('a live-looking sender with no server token (never a tenant sender) never matches', () => {
    expect(pickFromAddress({ requested: 'garrett@un1tdublin.com', sender: { ...LIVE, serverToken: null } })).toBe('hello@un1tdublin.com')
  })

  it('a live sender with no sendingDomain never matches', () => {
    expect(pickFromAddress({ requested: 'garrett@un1tdublin.com', sender: { ...LIVE, sendingDomain: null } })).toBe('hello@un1tdublin.com')
  })

  it('no sender → null (nothing to fall back to)', () => {
    expect(pickFromAddress({ requested: 'garrett@un1tdublin.com', sender: null })).toBeNull()
    expect(pickFromAddress()).toBeNull()
  })
})

describe('isOnVerifiedDomain', () => {
  it('true only for the live verified domain', () => {
    expect(isOnVerifiedDomain({ requested: 'garrett@un1tdublin.com', sender: LIVE })).toBe(true)
    expect(isOnVerifiedDomain({ requested: 'garrett@un1tdublin.com', sender: PLATFORM })).toBe(false)
    expect(isOnVerifiedDomain({ requested: 'x@other.com', sender: LIVE })).toBe(false)
  })
})

describe('withRequestedFrom', () => {
  it('swaps only fromEmail; token, name, reply-to and domain are the resolver\'s; the input is not mutated', () => {
    const out = withRequestedFrom(LIVE, 'garrett@un1tdublin.com')
    expect(out).toEqual({ ...LIVE, fromEmail: 'garrett@un1tdublin.com' })
    expect(out).not.toBe(LIVE)
    expect(LIVE.fromEmail).toBe('hello@un1tdublin.com')
  })

  it('falls back to the resolver address off the verified domain', () => {
    expect(withRequestedFrom(LIVE, 'x@other.com').fromEmail).toBe('hello@un1tdublin.com')
    expect(withRequestedFrom(PLATFORM, 'garrett@un1tdublin.com').fromEmail).toBe('hello@platform.test')
  })

  it('null/undefined sender passes through', () => {
    expect(withRequestedFrom(null, 'garrett@un1tdublin.com')).toBeNull()
    expect(withRequestedFrom(undefined, 'garrett@un1tdublin.com')).toBeUndefined()
  })

  it('composes with W1.E2\'s From-name rule: "Garrett Ivers <garrett@un1tdublin.com>" on the wire', () => {
    const sender = withRequestedFrom(LIVE, 'garrett@un1tdublin.com')
    expect(wireFrom({ fromName: 'Garrett Ivers', resolvedFrom: resolvedFromOf(sender) })).toBe('Garrett Ivers <garrett@un1tdublin.com>')
    // no from_name → the resolver's own name on the requested address
    expect(wireFrom({ resolvedFrom: resolvedFromOf(sender) })).toBe('UN1T <garrett@un1tdublin.com>')
  })
})

describe('describeFromAddress / fromAddressReport', () => {
  it('reports the address it will send as, the verified domain, and never the server token', async () => {
    resolveEmailSender.mockResolvedValue({ ...LIVE })
    const r = await describeFromAddress({ db: 1 }, 'loc-1', 'garrett@un1tdublin.com')
    expect(resolveEmailSender).toHaveBeenCalledWith({ db: 1 }, 'loc-1')
    expect(r).toEqual({ requested: 'garrett@un1tdublin.com', sends_as: 'garrett@un1tdublin.com', on_verified_domain: true, verified_domain: 'un1tdublin.com' })
    expect(JSON.stringify(r)).not.toContain('srv-tok')
  })

  it('off the verified domain: stored value echoed, sends_as is the resolver address', async () => {
    resolveEmailSender.mockResolvedValue({ ...LIVE })
    expect(await describeFromAddress({}, 'loc-1', 'x@other.com'))
      .toEqual({ requested: 'x@other.com', sends_as: 'hello@un1tdublin.com', on_verified_domain: false, verified_domain: 'un1tdublin.com' })
  })

  it('no live domain: the platform address, verified_domain null', async () => {
    resolveEmailSender.mockResolvedValue({ ...PLATFORM })
    expect(await describeFromAddress({}, 'loc-1', 'garrett@un1tdublin.com'))
      .toEqual({ requested: 'garrett@un1tdublin.com', sends_as: 'hello@platform.test', on_verified_domain: false, verified_domain: null })
  })

  it('fromAddressReport is undefined (no lookup) when the body carried no from_email or there is no location', async () => {
    expect(await fromAddressReport({}, 'loc-1', {})).toBeUndefined()
    expect(await fromAddressReport({}, 'loc-1', { from_email: null })).toBeUndefined()
    expect(await fromAddressReport({}, 'loc-1', { from_email: '  ' })).toBeUndefined()
    expect(await fromAddressReport({}, null, { from_email: 'garrett@un1tdublin.com' })).toBeUndefined()
    expect(resolveEmailSender).not.toHaveBeenCalled()
  })

  it('fromAddressReport describes a carried from_email', async () => {
    resolveEmailSender.mockResolvedValue({ ...LIVE })
    expect((await fromAddressReport({}, 'loc-1', { from_email: 'alex@un1tdublin.com' })).sends_as).toBe('alex@un1tdublin.com')
  })
})
