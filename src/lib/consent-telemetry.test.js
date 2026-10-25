import { describe, it, expect, vi } from 'vitest'
import { consentPathFor, reportConsent, CONSENT_STEPS } from './consent-telemetry.js'

describe('CONSENTRATE.1 — consent telemetry', () => {
  it('maps page paths to the landing public_path the endpoint segments by', () => {
    expect(consentPathFor('/hatch-street')).toBe('hatch-street')
    expect(consentPathFor('/welcome/hatch-street')).toBe('hatch-street')
    expect(consentPathFor('/start/hatch-street')).toBe('hatch-street')
    expect(consentPathFor('/hatch-street/events')).toBe('hatch-street')
    expect(consentPathFor('/stillorgan')).toBe('stillorgan')
    expect(consentPathFor('/')).toBe('stillorgan')
    expect(consentPathFor('/start')).toBe('stillorgan')
    expect(consentPathFor('/welcome')).toBe('stillorgan')
    expect(consentPathFor('')).toBe('stillorgan')
  })
  it('posts one funnel-event row with the step, the toggles and no PII', () => {
    const fetchFn = vi.fn(() => Promise.resolve({ ok: true }))
    expect(reportConsent('consent_accept', { analytics: true, marketing: true }, { fetchFn, pathname: '/hatch-street' })).toBe(true)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('/api/public/funnel-event')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ location_path: 'hatch-street', funnel: 'consent', step: 'consent_accept', meta: { analytics: true, marketing: true, page: '/hatch-street' } })
    expect(typeof body.session_id).toBe('string')
    expect(Object.keys(body).sort()).toEqual(['funnel', 'location_path', 'meta', 'session_id', 'step'])
  })
  it('refuses an unknown step and survives a fetch that throws', () => {
    const fetchFn = vi.fn(() => Promise.resolve({ ok: true }))
    expect(reportConsent('consent_banana', {}, { fetchFn })).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
    const boom = vi.fn(() => { throw new Error('offline') })
    expect(reportConsent('consent_reject', {}, { fetchFn: boom, pathname: '/' })).toBe(false)
  })
  it('every step it sends is one the endpoint accepts', async () => {
    const { VALID_STEPS } = await import('./funnel-events.js')
    for (const s of CONSENT_STEPS) expect(VALID_STEPS).toContain(s)
  })
})
