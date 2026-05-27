// STUDIO-PIN.1 — coverage for CIDR membership + client-IP extraction.
// The match itself is a security gate, so the cases that matter:
// v4 + v6, host-and-subnet masks, malformed input, and the header
// fallback for the client IP.

import { describe, it, expect } from 'vitest'
import {
  ipInCidr,
  extractClientIp,
  isTrustedIpForLocation,
} from './trusted-ips'

describe('ipInCidr — IPv4', () => {
  it('matches single-host /32', () => {
    expect(ipInCidr('192.168.1.10', '192.168.1.10/32')).toBe(true)
    expect(ipInCidr('192.168.1.11', '192.168.1.10/32')).toBe(false)
  })

  it('treats no-mask as /32 for v4', () => {
    expect(ipInCidr('192.168.1.10', '192.168.1.10')).toBe(true)
    expect(ipInCidr('192.168.1.11', '192.168.1.10')).toBe(false)
  })

  it('matches /24 subnet', () => {
    expect(ipInCidr('192.168.1.5',   '192.168.1.0/24')).toBe(true)
    expect(ipInCidr('192.168.1.255', '192.168.1.0/24')).toBe(true)
    expect(ipInCidr('192.168.2.5',   '192.168.1.0/24')).toBe(false)
  })

  it('matches non-byte-aligned masks (e.g. /20)', () => {
    expect(ipInCidr('10.0.0.5',  '10.0.0.0/20')).toBe(true)
    expect(ipInCidr('10.0.15.5', '10.0.0.0/20')).toBe(true)
    expect(ipInCidr('10.0.16.5', '10.0.0.0/20')).toBe(false)
  })

  it('rejects malformed v4 input', () => {
    expect(ipInCidr('not-an-ip', '192.168.1.0/24')).toBe(false)
    expect(ipInCidr('192.168.1', '192.168.1.0/24')).toBe(false)
    expect(ipInCidr('192.168.1.256', '192.168.1.0/24')).toBe(false)
    expect(ipInCidr('192.168.01.1', '192.168.1.0/24')).toBe(false) // octets can't have leading zeros
  })

  it('rejects malformed mask', () => {
    expect(ipInCidr('192.168.1.10', '192.168.1.0/33')).toBe(false)
    expect(ipInCidr('192.168.1.10', '192.168.1.0/-1')).toBe(false)
    expect(ipInCidr('192.168.1.10', '192.168.1.0/abc')).toBe(false)
  })
})

describe('ipInCidr — IPv6', () => {
  it('matches a single host /128', () => {
    expect(ipInCidr('2001:db8::1', '2001:db8::1/128')).toBe(true)
    expect(ipInCidr('2001:db8::2', '2001:db8::1/128')).toBe(false)
  })

  it('matches /64 prefix', () => {
    expect(ipInCidr('2001:db8::1234:abcd', '2001:db8::/64')).toBe(true)
    expect(ipInCidr('2001:db8:0:1::',      '2001:db8::/64')).toBe(false)
  })

  it('handles :: compression at start, middle, end', () => {
    expect(ipInCidr('::1', '::1/128')).toBe(true)
    expect(ipInCidr('2001:db8::', '2001:db8::/64')).toBe(true)
    expect(ipInCidr('fe80::1234', 'fe80::/16')).toBe(true)
  })

  it('rejects invalid v6 input', () => {
    expect(ipInCidr('2001:db8:::1', '2001:db8::/64')).toBe(false) // triple-colon
    expect(ipInCidr('::xyz',        '::/0')).toBe(false)
    expect(ipInCidr('2001:db8::1::', '2001:db8::/64')).toBe(false) // double ::
  })
})

describe('ipInCidr — type checks', () => {
  it('returns false on non-string input', () => {
    expect(ipInCidr(null, '0.0.0.0/0')).toBe(false)
    expect(ipInCidr('1.2.3.4', null)).toBe(false)
    expect(ipInCidr(123, '0.0.0.0/0')).toBe(false)
  })
})

describe('extractClientIp', () => {
  const buildReq = (headers) => ({
    headers: {
      get(name) { return headers[name.toLowerCase()] ?? null },
    },
  })

  it('returns the first XFF entry', () => {
    expect(extractClientIp(buildReq({
      'x-forwarded-for': '203.0.113.5, 10.0.0.1, 10.0.0.2',
    }))).toBe('203.0.113.5')
  })

  it('handles a single-entry XFF', () => {
    expect(extractClientIp(buildReq({
      'x-forwarded-for': '198.51.100.10',
    }))).toBe('198.51.100.10')
  })

  it('trims whitespace', () => {
    expect(extractClientIp(buildReq({
      'x-forwarded-for': '   203.0.113.5  ,10.0.0.1',
    }))).toBe('203.0.113.5')
  })

  it('falls back to x-real-ip when XFF is absent', () => {
    expect(extractClientIp(buildReq({
      'x-real-ip': '198.51.100.99',
    }))).toBe('198.51.100.99')
  })

  it('returns null when no headers present', () => {
    expect(extractClientIp(buildReq({}))).toBe(null)
  })

  it('returns null for a request without a headers.get', () => {
    expect(extractClientIp(null)).toBe(null)
    expect(extractClientIp({})).toBe(null)
  })
})

describe('isTrustedIpForLocation', () => {
  const buildDb = (rows) => ({
    from() { return this },
    select() { return this },
    eq() {
      return Promise.resolve({ data: rows, error: null })
    },
  })

  it('returns true when source IP is inside one of the location CIDRs', async () => {
    const db = buildDb([
      { ip_cidr: '203.0.113.0/24' },
      { ip_cidr: '198.51.100.10/32' },
    ])
    expect(await isTrustedIpForLocation({
      db, locationId: 'loc1', sourceIp: '203.0.113.42',
    })).toBe(true)
  })

  it('returns false when source IP is outside every CIDR', async () => {
    const db = buildDb([
      { ip_cidr: '203.0.113.0/24' },
    ])
    expect(await isTrustedIpForLocation({
      db, locationId: 'loc1', sourceIp: '8.8.8.8',
    })).toBe(false)
  })

  it('returns false when location has no trusted IPs', async () => {
    const db = buildDb([])
    expect(await isTrustedIpForLocation({
      db, locationId: 'loc1', sourceIp: '1.2.3.4',
    })).toBe(false)
  })

  it('returns false on malformed input', async () => {
    const db = buildDb([])
    expect(await isTrustedIpForLocation({
      db, locationId: null, sourceIp: '1.2.3.4',
    })).toBe(false)
    expect(await isTrustedIpForLocation({
      db, locationId: 'loc1', sourceIp: '',
    })).toBe(false)
  })

  it('surfaces db errors', async () => {
    const db = {
      from() { return this },
      select() { return this },
      eq() {
        return Promise.resolve({ data: null, error: { message: 'db down' } })
      },
    }
    await expect(isTrustedIpForLocation({
      db, locationId: 'loc1', sourceIp: '1.2.3.4',
    })).rejects.toThrow('db down')
  })
})
