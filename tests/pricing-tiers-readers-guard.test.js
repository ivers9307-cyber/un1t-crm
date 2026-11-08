// TIERS.1 — every reader that prices an event or labels its price must select
// race_events.pricing_tiers, or the tiers silently do nothing there: the
// browse cards' "From €X" (eventPriceLabel reads e.pricing_tiers), Mia's
// approval door (registerSoloEventEntry → applyTierPricing) and the series
// page. A select that forgets the column is the bug this pins.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8')

describe('pricing_tiers reaches every reader that needs it', () => {
  it.each([
    ['src/app/h/[slug]/page.js', /const EVENT_COLS = '[^']*\bpricing_tiers\b/],
    ['src/components/landing-page/StudioEventsPage.jsx', /\bpricing_tiers\b/],
    ['src/lib/event-series.js', /SERIES_DATE_COLS = '[^']*\bpricing_tiers\b/],
    ['src/app/api/agent/membership-requests/[id]/route.js', /\bpricing_tiers\b/],
  ])('%s selects pricing_tiers', (file, re) => {
    expect(read(file)).toMatch(re)
  })
  it('the membership-requests door also reads entry_policy and capacity_mode (the tier count and wave gate need the event policy)', () => {
    const src = read('src/app/api/agent/membership-requests/[id]/route.js')
    expect(src).toMatch(/\bentry_policy\b/)
    expect(src).toMatch(/\bcapacity_mode\b/)
  })
})
