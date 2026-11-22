import { describe, it, expect, vi } from 'vitest'

vi.mock('./log.js', () => ({ logError: vi.fn() }))
const { getEmailLogoUrl } = await import('./email-logo.js')
const { logError } = await import('./log.js')

const dbReturning = (result) => {
  const calls = []
  const chain = {
    select: (c) => { calls.push(['select', c]); return chain },
    eq: (k, v) => { calls.push(['eq', k, v]); return chain },
    limit: async () => result,
  }
  return { db: { from: (t) => { calls.push(['from', t]); return chain } }, calls }
}

describe('getEmailLogoUrl (EMAILBAR.1)', () => {
  it('returns the studio\'s https email logo, read by location', async () => {
    const { db, calls } = dbReturning({ data: [{ email_logo_url: 'https://cdn.test/white.png' }], error: null })
    await expect(getEmailLogoUrl(db, 'loc-1')).resolves.toBe('https://cdn.test/white.png')
    expect(calls).toEqual([['from', 'company_settings'], ['select', 'email_logo_url'], ['eq', 'location_id', 'loc-1']])
  })

  it('is null when unset, when there is no row, and for a URL that is not https', async () => {
    for (const data of [[{ email_logo_url: null }], [], null, [{ email_logo_url: 'http://cdn.test/x.png' }], [{ email_logo_url: 42 }]]) {
      await expect(getEmailLogoUrl(dbReturning({ data, error: null }).db, 'loc-1')).resolves.toBeNull()
    }
  })

  it('fails soft: an error or a throw is null and is logged', async () => {
    await expect(getEmailLogoUrl(dbReturning({ data: null, error: { code: '42703' } }).db, 'loc-1')).resolves.toBeNull()
    await expect(getEmailLogoUrl({ from: () => { throw new Error('down') } }, 'loc-1')).resolves.toBeNull()
    expect(logError).toHaveBeenCalledTimes(2)
  })

  it('is null without a client or a location', async () => {
    await expect(getEmailLogoUrl(null, 'loc-1')).resolves.toBeNull()
    await expect(getEmailLogoUrl({}, '')).resolves.toBeNull()
  })
})
