// TRIALFIRST.1 — the editor preview hands the studio's trial card (disabled)
// to the first hero, as the public page does, and tells every block a trial is
// shown so the lead form previews as the compact strip.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const seen = vi.hoisted(() => ({ calls: [] }))
vi.mock('./BlockRenderers', () => ({
  default: (p) => { seen.calls.push({ id: p.block.id, trial: p.trial, trialShown: p.trialShown }); return null },
  SiteHeader: () => null,
  SiteFooter: () => null,
}))

import EditModeOverlay from './EditModeOverlay.jsx'

const blocks = [
  { id: 'h', type: 'hero' },
  { id: 'l', type: 'lead_form' },
  { id: 'h2', type: 'hero' },
]
const trialPreview = { studio: { key: 'stillorgan', sellable: false }, returnPath: '/stillorgan', resumePurchaseId: null, cancelled: false, hatchTerms: null, preview: true }

beforeEach(() => { seen.calls = [] })

describe('EditModeOverlay trial preview (TRIALFIRST.1)', () => {
  it('gives the card to the first hero only and trialShown to every block', () => {
    renderToStaticMarkup(<EditModeOverlay initialBlocks={blocks} trialPreview={trialPreview} />)
    expect(seen.calls).toEqual([
      { id: 'h', trial: trialPreview, trialShown: true },
      { id: 'l', trial: null, trialShown: true },
      { id: 'h2', trial: null, trialShown: true },
    ])
  })

  it('without a trial preview nothing changes', () => {
    renderToStaticMarkup(<EditModeOverlay initialBlocks={blocks} />)
    expect(seen.calls.every((c) => c.trial === null && c.trialShown === false)).toBe(true)
    expect(seen.calls).toHaveLength(3)
  })
})
