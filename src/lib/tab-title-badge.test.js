// TABTITLE.1 — the two string rules behind the Sidebar's "(n) " tab prefix.
import { describe, it, expect } from 'vitest'
import { stripTitleBadge, withTitleBadge } from './tab-title-badge.js'

describe('tab title badge', () => {
  it('prefixes a count and caps it at 99+', () => {
    expect(withTitleBadge('UN1T Stillorgan', 3)).toBe('(3) UN1T Stillorgan')
    expect(withTitleBadge('UN1T Stillorgan', 150)).toBe('(99+) UN1T Stillorgan')
  })

  it('is idempotent: re-applying never stacks prefixes', () => {
    const once = withTitleBadge('Schedule · UN1T Stillorgan', 3)
    expect(withTitleBadge(once, 3)).toBe(once)
    expect(withTitleBadge(once, 12)).toBe('(12) Schedule · UN1T Stillorgan')
    expect(withTitleBadge('(99+) X', 2)).toBe('(2) X')
  })

  it('zero, negative and junk counts leave the bare title', () => {
    expect(withTitleBadge('(3) UN1T Stillorgan', 0)).toBe('UN1T Stillorgan')
    expect(withTitleBadge('UN1T Stillorgan', -1)).toBe('UN1T Stillorgan')
    expect(withTitleBadge('UN1T Stillorgan', undefined)).toBe('UN1T Stillorgan')
  })

  it('strips only a LEADING badge', () => {
    expect(stripTitleBadge('(3) Week (2) plan')).toBe('Week (2) plan')
    expect(stripTitleBadge('Week (2) plan')).toBe('Week (2) plan')
    expect(stripTitleBadge(null)).toBe('')
  })

  // document.title's GETTER trims, so "(3) " + "" reads back as "(3)". A strip
  // rule that needs whitespace after the badge then misses it, and the next
  // pass stacks a second one: "(3) (3)", which is where the Sidebar observer
  // converged on a page with no <title> yet.
  it('an EMPTY or whitespace base title is idempotent too', () => {
    expect(withTitleBadge('', 3)).toBe('(3)')
    expect(withTitleBadge('   ', 3)).toBe('(3)')
    expect(withTitleBadge('(3)', 3)).toBe('(3)')
    expect(withTitleBadge(withTitleBadge('', 3), 5)).toBe('(5)')
    expect(withTitleBadge('(3)', 0)).toBe('')
    expect(stripTitleBadge('(99+)')).toBe('')
  })

  // KNOWN LIMIT, deliberately left alone: a page whose real title begins with
  // a bare "(12) " is indistinguishable from our badge and loses it.
  it('cannot tell a legitimate leading "(12) " from its own badge', () => {
    expect(stripTitleBadge('(12) Angry Men')).toBe('Angry Men')
  })
})
