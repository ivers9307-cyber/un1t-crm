// @vitest-environment jsdom
//
// QUICKEMAIL-RETIRE.1 — the quick composer is WhatsApp only. Email is written
// in the full editor; the composer offers a link to /communications/new-email
// to anyone who holds email, and nothing else of email remains here.
// (Its old blank-email guards, COMMSFIX.D.2b/D.2c/D.4a, went with the email
// half; the full editor's own guards live in useUnlayerEditor.test.jsx.)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

vi.mock('@/components/AudienceBuilder', () => ({
  default: () => <div data-testid="audience-builder" />,
}))
vi.mock('./ContactMultiSelect', () => ({ default: () => <div /> }))

import UnifiedSendComposer from './UnifiedSendComposer.jsx'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, count: 0, reachable: 0, segments: [] }) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('UnifiedSendComposer — WhatsApp only', () => {
  it('has no email channel, subject or designer', () => {
    render(<UnifiedSendComposer locationId="loc-1" canEmail templates={[]} />)
    expect(screen.queryByPlaceholderText('Email subject')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Email$/ })).toBeNull()
    expect(screen.queryByText(/open the full editor/i)).toBeNull()
    expect(screen.getByText('Approved template')).toBeTruthy()
  })

  it('links an email holder to the New email page', () => {
    render(<UnifiedSendComposer locationId="loc-1" canEmail templates={[]} />)
    expect(screen.getByRole('link', { name: /start a new email/i }).getAttribute('href')).toBe('/communications/new-email')
  })

  it('shows no email link without the email permission', () => {
    render(<UnifiedSendComposer locationId="loc-1" templates={[]} />)
    expect(screen.queryByRole('link', { name: /start a new email/i })).toBeNull()
  })
})

// ── COPYCLAIM.1 — no unevidenced performance claims in composer copy ──
//
// The resend panel's helper text used to read "A fresh subject usually lifts
// second-send opens." Nothing in this estate supports that: nine campaigns,
// with open rates that track content type rather than wording. It is the
// exact claim src/lib/copy-assist.js refuses to make ("It does not predict or
// rank what will perform ... Claiming otherwise would be fabrication") — so
// the composer should not make it in a label either.
//
// A source scan rather than a render, because the offending strings sit in
// panels that need several pieces of state to appear, and the point is that
// none of the composer's copy should carry a claim like this.

describe('composer helper copy makes no unevidenced performance claim', () => {
  const CLAIMS = [
    /\b(usually|typically|generally|on average)\b[^.]{0,60}\b(lift|lifts|boost|boosts|increase|increases|improve|improves)\b/i,
    /\b(lifts|boosts|increases|improves)\b[^.]{0,40}\b(opens|open rates?|clicks|click rates?|replies|conversions?)\b/i,
    /\b(higher|better|more)\b[^.]{0,30}\b(open rates?|click rates?)\b[^.]{0,30}\b(when|if)\b/i,
  ]

  it.each([
    'UnifiedSendComposer.jsx',
    'CopyAssist.jsx',
  ])('%s', async (file) => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const src = readFileSync(path.join(process.cwd(), 'src/components/communications', file), 'utf8')
    const offenders = src
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => CLAIMS.some((re) => re.test(line)))
      .map(([n, line]) => `${n}: ${line.trim()}`)
    expect(offenders).toEqual([])
  })
})
