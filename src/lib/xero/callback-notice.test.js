// CHANNELREAD.1 — the Xero OAuth callback's outcome, as the operator reads it.
// The callback redirects with a CODE (never free text); this module is the
// one place that turns a code into copy. Unknown codes get a generic line,
// and nothing from the URL is ever echoed back to the page.

import { describe, it, expect } from 'vitest'
import {
  XERO_CALLBACK_PARAMS,
  XERO_CALLBACK_ERRORS,
  XERO_GENERIC_ERROR,
  xeroCallbackNotice,
  hasXeroCallbackParams,
  withoutXeroCallbackParams,
} from './callback-notice.js'

const qs = (s) => new URLSearchParams(s)

describe('xeroCallbackNotice', () => {
  it('no callback params → null', () => {
    expect(xeroCallbackNotice(qs('tab=xero'))).toBeNull()
    expect(xeroCallbackNotice(null)).toBeNull()
  })

  it('every known error code maps to its own plain, non-generic copy with no em-dash', () => {
    const texts = new Set()
    for (const code of Object.values(XERO_CALLBACK_ERRORS)) {
      const n = xeroCallbackNotice(qs(`${XERO_CALLBACK_PARAMS.error}=${code}`))
      expect(n.tone).toBe('error')
      expect(n.text).not.toBe(XERO_GENERIC_ERROR)
      expect(n.text).not.toContain('—')
      expect(n.text).not.toContain(code)
      texts.add(n.text)
    }
    // invalid_state and state_mismatch share copy on purpose; the rest differ.
    expect(texts.size).toBe(Object.keys(XERO_CALLBACK_ERRORS).length - 1)
  })

  it.each([
    ['not_permitted', 'Only an owner of this location can connect Xero, so nothing was changed.'],
    ['declined', 'Xero did not grant access, so nothing was changed. Try connecting again if you meant to connect.'],
    ['missing_code', 'Xero did not send back what was needed to finish connecting, so nothing was changed. Try connecting again.'],
    ['state_mismatch', 'The Xero sign-in could not be matched to this browser, so nothing was changed. Start the connection again from this page.'],
    ['invalid_state', 'The Xero sign-in could not be matched to this browser, so nothing was changed. Start the connection again from this page.'],
    ['no_tenants', 'This Xero login does not give access to any organisation, so nothing was changed.'],
    ['taken_read_failed', 'Could not check which Xero organisations are already connected, so nothing was changed. Try connecting again.'],
    ['all_taken', 'Every Xero organisation this login gives access to is already connected to another location, so nothing was changed. Each location needs its own Xero organisation.'],
    ['save_failed', 'The Xero connection could not be saved, so nothing was changed. Try connecting again.'],
    ['xero_error', 'Xero did not connect: something went wrong talking to Xero, so nothing was changed. Try connecting again.'],
  ])('%s → its copy', (code, text) => {
    expect(xeroCallbackNotice(qs(`xero_error=${code}`))).toEqual({ tone: 'error', text })
  })

  it('an unknown error code → the generic line, never the raw value', () => {
    const n = xeroCallbackNotice(qs('xero_error=%3Cimg%20src%3Dx%3E'))
    expect(n).toEqual({ tone: 'error', text: XERO_GENERIC_ERROR })
    expect(XERO_GENERIC_ERROR).toBe('Xero did not connect, so nothing was changed. Try connecting again.')
  })

  it('success → a short confirmation', () => {
    expect(xeroCallbackNotice(qs('xero_connected=1'))).toEqual({ tone: 'success', text: 'Xero connected.' })
  })

  it('success on a login that grants several orgs → says how many and asks for a check', () => {
    expect(xeroCallbackNotice(qs('xero_connected=1&xero_orgs=3'))).toEqual({
      tone: 'success',
      text: 'Xero connected. This login gives access to 3 organisations and one was picked for this location, so check it is the right one.',
    })
  })

  it('a non-numeric or silly org count is ignored, never echoed', () => {
    expect(xeroCallbackNotice(qs('xero_connected=1&xero_orgs=lots')).text).toBe('Xero connected.')
    expect(xeroCallbackNotice(qs('xero_connected=1&xero_orgs=1')).text).toBe('Xero connected.')
    expect(xeroCallbackNotice(qs('xero_connected=1&xero_orgs=99999')).text).toBe('Xero connected.')
  })

  it('an error wins over a connected flag', () => {
    expect(xeroCallbackNotice(qs('xero_connected=1&xero_error=declined')).tone).toBe('error')
  })
})

describe('the URL clean-up helpers', () => {
  it('hasXeroCallbackParams sees any of the three params', () => {
    expect(hasXeroCallbackParams(qs('tab=xero'))).toBe(false)
    expect(hasXeroCallbackParams(qs('tab=xero&xero_error=declined'))).toBe(true)
    expect(hasXeroCallbackParams(qs('xero_orgs=2'))).toBe(true)
  })

  it('withoutXeroCallbackParams keeps every other param', () => {
    expect(withoutXeroCallbackParams(qs('tab=xero&xero_connected=1&xero_orgs=2'))).toBe('tab=xero')
    expect(withoutXeroCallbackParams(qs('xero_error=declined'))).toBe('')
  })
})
