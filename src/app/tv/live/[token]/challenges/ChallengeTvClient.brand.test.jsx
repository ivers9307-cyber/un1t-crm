// @vitest-environment jsdom
//
// W1.S1b — the challenge board names its points metric from the studio's
// short brand in the poll payload (`brand.short_name` → "GA Points"), never a
// literal gym.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

vi.mock('@/fonts/repset', () => ({
  repsetDisplay: { variable: 'f-d' },
  repsetBody: { variable: 'f-b' },
  repsetMono: { variable: 'f-m' },
}))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('orientation=landscape') }))

import ChallengeTvClient from './ChallengeTvClient.jsx'

function stubFetch(body) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ChallengeTvClient — "{Brand} Points" (W1.S1b)', () => {
  it('labels a points challenge from brand.short_name', async () => {
    stubFetch({
      ok: true,
      brand: { name: 'Gym A North', short_name: 'GA' },
      location: { name: 'Gym A North' },
      challenges: [{
        id: 'c1', mode: 'collective', name: 'October push', metric: 'points', endsOn: '2026-10-31',
        collective: { total: 10, target: 100, pct: 0.1 },
      }],
      gymBoard: [],
    })
    render(<ChallengeTvClient endpoint="/api/public/tv-challenges/tok" device={null} />)
    // The metric kicker reads exactly the brand's points name…
    expect(await screen.findByText('GA Points')).toBeTruthy()
    // …and the header's metric suffix carries it too; nothing else names points.
    expect(document.body.textContent).toContain('· GA Points')
    expect(document.body.textContent).not.toMatch(/UN1T/)
  })
})
