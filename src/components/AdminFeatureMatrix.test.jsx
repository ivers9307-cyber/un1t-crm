// @vitest-environment jsdom
//
// BUNDLES.5 final-review fix 2 — "toggle silent flip", matrix half.
// Same contract as LocationFeatures.test.jsx: a bundle-denied cell
// renders disabled and un-clickable, an ordinary cell still writes the
// raw flip. The matrix defaults to the bundles-only view (Task 3), so
// these tests open "Show all feature keys" first to reach the
// fine-grained Web features grid.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

import AdminFeatureMatrix from './AdminFeatureMatrix.jsx'

const ORG = { id: 'org-1', name: 'UN1T Group' }

let calls = []
beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
    return { ok: true, json: async () => ({ success: true, data: {} }) }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderMatrix(locations) {
  const utils = render(
    <AdminFeatureMatrix organizations={[ORG]} locationsByOrg={{ [ORG.id]: locations }} />
  )
  // Reveal the fine-grained Web/Mobile sections (bundles-only is the default).
  fireEvent.click(screen.getByRole('button', { name: /show all feature keys/i }))
  return utils
}

function webFeaturesSection(container) {
  const heading = within(container).getByText('Web features')
  return heading.closest('section')
}

describe('AdminFeatureMatrix — bundle-denied cells are disabled, not silently flippable', () => {
  it('a cell denied by its bundle renders disabled with a denial title, and cannot be clicked', () => {
    const loc = { id: 'loc-1', name: 'Stillorgan', features: { bundle_sales: false } }
    const { container } = renderMatrix([loc])
    const web = webFeaturesSection(container)

    const cell = within(web).getByRole('button', { name: 'Stillorgan — Pipeline & Deals toggle' })
    expect(cell.disabled).toBe(true)
    expect(cell.getAttribute('aria-pressed')).toBe('false')
    expect(cell.getAttribute('title')).toMatch(/Off via Sales bundle/)

    fireEvent.click(cell)
    expect(calls).toHaveLength(0)
  })

  it('a cell whose bundle is ON renders enabled, and clicking WRITES the raw flip (not the composite)', () => {
    const loc = { id: 'loc-1', name: 'Stillorgan', features: {} }
    const { container } = renderMatrix([loc])
    const web = webFeaturesSection(container)

    const cell = within(web).getByRole('button', { name: 'Stillorgan — Pipeline & Deals toggle' })
    expect(cell.disabled).toBe(false)
    expect(cell.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(cell)
    expect(calls).toHaveLength(1)
    expect(calls[0].body.features.pipeline).toBe(false)
  })

  it('different locations are independent — one bundle-off location does not disable another location\'s cell', () => {
    const locs = [
      { id: 'loc-1', name: 'Stillorgan', features: { bundle_sales: false } },
      { id: 'loc-2', name: 'Hatch Street', features: {} },
    ]
    const { container } = renderMatrix(locs)
    const web = webFeaturesSection(container)

    const denied = within(web).getByRole('button', { name: 'Stillorgan — Pipeline & Deals toggle' })
    const enabled = within(web).getByRole('button', { name: 'Hatch Street — Pipeline & Deals toggle' })
    expect(denied.disabled).toBe(true)
    expect(enabled.disabled).toBe(false)
  })

  it('bundle columns themselves are never disabled by this mechanism', () => {
    // Bundles-only default view — no need to expand "Advanced".
    const loc = { id: 'loc-1', name: 'Stillorgan', features: { bundle_sales: false } }
    render(<AdminFeatureMatrix organizations={[ORG]} locationsByOrg={{ [ORG.id]: [loc] }} />)
    const cell = screen.getByRole('button', { name: 'Stillorgan — Sales toggle' })
    expect(cell.disabled).toBe(false)
  })
})
