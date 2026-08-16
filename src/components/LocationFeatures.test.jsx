// @vitest-environment jsdom
//
// BUNDLES.5 final-review fix 2 — "toggle silent flip". Component-level
// wiring tests: a bundle-denied fine-grained toggle must be rendered
// disabled (with an explanatory note) and must be un-clickable — no
// fetch call at all — and an ordinary (non-bundle-denied) toggle must
// still write the RAW flip, not the bundle-aware composite. The pure
// logic itself (rawFeatureOn / nextRawFeatureValue / isBundleDenied /
// bundleDenialNote) is unit-tested directly in feature-toggle-ui.test.js
// — this file only proves the two are wired together correctly.
//
// Several permission keys (e.g. 'pipeline', 'contacts') exist on BOTH
// the Web features and Mobile features lists (a mobile key with a web
// webEquivalent shares the same label), so queries are scoped to the
// Web features section specifically to avoid ambiguous matches — not
// a workaround for this fix, just this repo's normal web/mobile
// parity shape.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

import LocationFeatures from './LocationFeatures.jsx'

let calls = []
beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
    return { ok: true, json: async () => ({ success: true, data: {} }) }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// Both the outer widget <details> and the nested "Advanced" <details>
// start collapsed — open them so their content is in the accessible
// tree for getByRole/getByLabelText queries.
function openAllDetails(container) {
  container.querySelectorAll('details').forEach((d) => { d.open = true })
}

function webFeaturesSection(container) {
  const heading = within(container).getByText('Web features')
  return heading.closest('section')
}

// The row containing a given label's text, hint, denial note and
// toggle button — scopes a query to just that one row so a shared
// denial note text ("Off via Sales bundle") on a NEIGHBOURING
// also-denied row can't cause an ambiguous match. Structure:
// <row><textWrapper><label/>[hint][note]</textWrapper><button/></row>
// — the label div IS the text match, so two parentElement hops reach
// the row (label → textWrapper → row).
function rowFor(section, label) {
  return within(section).getByText(label).parentElement.parentElement
}

describe('LocationFeatures — bundle-denied rows are disabled, not silently flippable', () => {
  it('a fine-grained key denied by its bundle renders disabled with a denial note, and cannot be clicked', () => {
    const location = { id: 'loc-1', features: { bundle_sales: false } }
    const { container } = render(<LocationFeatures location={location} />)
    openAllDetails(container)

    const web = webFeaturesSection(container)
    const row = rowFor(web, 'Pipeline & Deals')
    const toggle = within(row).getByRole('button', { name: 'Pipeline & Deals toggle' })
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(within(row).getByText(/Off via Sales bundle/)).toBeTruthy()

    fireEvent.click(toggle)
    expect(calls).toHaveLength(0)
  })

  it('a fine-grained key whose bundle is ON renders enabled, and clicking WRITES the raw flip (not the composite)', () => {
    const location = { id: 'loc-1', features: {} }
    const { container } = render(<LocationFeatures location={location} />)
    openAllDetails(container)

    const web = webFeaturesSection(container)
    const toggle = within(web).getByRole('button', { name: 'Pipeline & Deals toggle' })
    expect(toggle.disabled).toBe(false)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(toggle)
    expect(calls).toHaveLength(1)
    // Raw flip: unset (on) → explicit false. Never `true` (what a
    // composite-based flip would have silently written in the denied
    // case above — this pins the ordinary case stays correct too).
    expect(calls[0].body.features.pipeline).toBe(false)
  })

  it('an individually-off key with its bundle ON still flips normally (ordinary case, unaffected by this fix)', () => {
    const location = { id: 'loc-1', features: { contacts: false } }
    const { container } = render(<LocationFeatures location={location} />)
    openAllDetails(container)

    const web = webFeaturesSection(container)
    const toggle = within(web).getByRole('button', { name: 'Contacts toggle' })
    expect(toggle.disabled).toBe(false)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle)
    expect(calls).toHaveLength(1)
    expect(calls[0].body.features.contacts).toBe(true)
  })

  it('a bundle toggle itself (e.g. Sales) is never disabled by this mechanism — there is no meta-bundle', () => {
    const location = { id: 'loc-1', features: { bundle_sales: false } }
    const { container } = render(<LocationFeatures location={location} />)
    openAllDetails(container)

    const bundleToggle = screen.getByRole('button', { name: 'Sales toggle' })
    expect(bundleToggle.disabled).toBe(false)
  })
})
