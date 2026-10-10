// W1.E2 — the platform sender is read from the env and never spelled; the
// display name on a pre-domain send is the tenant's brand, never the env's.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
import { logError } from './log.js'
import {
  parseAddressHeader,
  formatAddressHeader,
  platformFromAddress,
  platformFromHeader,
  wireFrom,
  resolvedFromOf,
} from './platform-sender.js'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('POSTMARK_FROM_EMAIL', 'hello@platform.test')
})
afterEach(() => vi.unstubAllEnvs())

describe('parseAddressHeader / formatAddressHeader', () => {
  it('splits "Name <addr>", "\"Name\" <addr>" and a bare address', () => {
    expect(parseAddressHeader('Gym A <hi@gyma.ie>')).toEqual({ name: 'Gym A', address: 'hi@gyma.ie' })
    expect(parseAddressHeader('"Gym A, Dublin" <hi@gyma.ie>')).toEqual({ name: 'Gym A, Dublin', address: 'hi@gyma.ie' })
    expect(parseAddressHeader('hi@gyma.ie')).toEqual({ name: '', address: 'hi@gyma.ie' })
    expect(parseAddressHeader('')).toEqual({ name: '', address: '' })
    expect(parseAddressHeader(null)).toEqual({ name: '', address: '' })
  })
  it('formats a name + address, a bare address, and null with no address', () => {
    expect(formatAddressHeader('Gym A', 'hi@gyma.ie')).toBe('Gym A <hi@gyma.ie>')
    expect(formatAddressHeader('', 'hi@gyma.ie')).toBe('hi@gyma.ie')
    expect(formatAddressHeader(null, 'hi@gyma.ie')).toBe('hi@gyma.ie')
    expect(formatAddressHeader('Gym A', '')).toBeNull()
  })
  it('quotes a display name that reads as address syntax, and strips line breaks', () => {
    expect(formatAddressHeader('Gym A, Dublin', 'hi@gyma.ie')).toBe('"Gym A, Dublin" <hi@gyma.ie>')
    expect(formatAddressHeader('Gym <A>', 'hi@gyma.ie')).toBe('"Gym <A>" <hi@gyma.ie>')
    expect(formatAddressHeader('Gym\r\nA', 'hi@gyma.ie')).toBe('Gym A <hi@gyma.ie>')
    // quotes + backslashes inside the name are dropped, the rest is quoted whole
    expect(formatAddressHeader(`O'Brien's "Gym" <Dublin>`, 'hi@gyma.ie')).toBe(`"O'Brien's Gym <Dublin>" <hi@gyma.ie>`)
    expect(formatAddressHeader('Back\\slash', 'hi@gyma.ie')).toBe('"Backslash" <hi@gyma.ie>')
  })
})

describe('platformFromAddress / platformFromHeader — env-driven, never spelled', () => {
  it('reads the bare address from either env form', () => {
    expect(platformFromAddress()).toBe('hello@platform.test')
    vi.stubEnv('POSTMARK_FROM_EMAIL', 'Legacy Name <hello@platform.test>')
    expect(platformFromAddress()).toBe('hello@platform.test')
  })
  it('puts the caller display name on the platform address, PLATFORM_NAME when none', () => {
    expect(platformFromHeader('Gym A')).toBe('Gym A <hello@platform.test>')
    expect(platformFromHeader()).toBe('Repset <hello@platform.test>')
    expect(platformFromHeader('  ')).toBe('Repset <hello@platform.test>')
  })
  it("never uses the env's own display name", () => {
    vi.stubEnv('POSTMARK_FROM_EMAIL', 'UN1T <hello@platform.test>')
    expect(platformFromHeader('Gym A')).toBe('Gym A <hello@platform.test>')
    expect(platformFromHeader()).toBe('Repset <hello@platform.test>')
  })
  it('env unset → null + one structured error, no invented address', () => {
    vi.stubEnv('POSTMARK_FROM_EMAIL', '')
    expect(platformFromAddress()).toBeNull()
    expect(platformFromHeader('Gym A')).toBeNull()
    expect(logError).toHaveBeenCalledWith('platform-sender', expect.stringContaining('POSTMARK_FROM_EMAIL'))
  })
})

describe('wireFrom — the resolved address always wins, the explicit display name is kept', () => {
  const resolved = 'Gym A <hello@platform.test>'
  it('resolved only → the resolved header', () => {
    expect(wireFrom({ resolvedFrom: resolved })).toBe(resolved)
  })
  it('fromName + resolved → that name on the resolved address', () => {
    expect(wireFrom({ fromName: 'Garrett at Gym A', resolvedFrom: resolved })).toBe('Garrett at Gym A <hello@platform.test>')
  })
  it('an explicit full `from` + resolved → ITS display name, the resolved address (never its own)', () => {
    expect(wireFrom({ from: 'Garrett <ops@gyma.ie>', resolvedFrom: resolved })).toBe('Garrett <hello@platform.test>')
    expect(wireFrom({ from: 'ops@gyma.ie', resolvedFrom: resolved })).toBe(resolved)
  })
  it('fromName beats the display name inside `from`', () => {
    expect(wireFrom({ from: 'Old <ops@gyma.ie>', fromName: 'New', resolvedFrom: resolved })).toBe('New <hello@platform.test>')
    expect(wireFrom({ from: 'Old <ops@gyma.ie>', fromName: 'New' })).toBe('New <ops@gyma.ie>')
  })
  it('no resolved sender → an explicit `from` passes through byte-for-byte', () => {
    expect(wireFrom({ from: '"Dean Nolan" <dean@x.com>' })).toBe('"Dean Nolan" <dean@x.com>')
    expect(wireFrom({ from: 'dean@x.com' })).toBe('dean@x.com')
  })
  it('nothing at all → the platform header; with a fromName → that name on it', () => {
    expect(wireFrom({})).toBe('Repset <hello@platform.test>')
    expect(wireFrom({ fromName: 'Gym A' })).toBe('Gym A <hello@platform.test>')
  })
  it('env unset and nothing resolved → null (loud at Postmark), never a literal', () => {
    vi.stubEnv('POSTMARK_FROM_EMAIL', '')
    expect(wireFrom({ fromName: 'Gym A' })).toBeNull()
  })
})

describe('resolvedFromOf', () => {
  it('builds the header from a resolved sender, null without an address', () => {
    expect(resolvedFromOf({ fromEmail: 'hello@platform.test', fromName: 'Gym A' })).toBe('Gym A <hello@platform.test>')
    expect(resolvedFromOf({ fromEmail: 'hello@platform.test', fromName: null })).toBe('hello@platform.test')
    expect(resolvedFromOf({ fromEmail: null, fromName: 'Gym A' })).toBeNull()
    expect(resolvedFromOf(null)).toBeNull()
  })
})
