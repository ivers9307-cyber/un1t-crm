// TRIALSTUDIO.11 — /start and /start/<studio> redirect to /trial.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }) }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, notFound: vi.fn() }))
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => { throw new Error('loaded before redirect') }) }))

import StartPage from './page'
import StudioStartPage from './[path]/page'

describe('/start redirects', () => {
  beforeEach(() => { mocks.redirect.mockClear() })

  it('/start goes to /trial with Stillorgan preselected and the query kept', async () => {
    await expect(StartPage({ searchParams: Promise.resolve({ utm_campaign: 'x' }) })).rejects.toThrow(/^NEXT_REDIRECT:\/trial\?studio=stillorgan&utm_campaign=x$/)
    expect(mocks.redirect).toHaveBeenCalledWith('/trial?studio=stillorgan&utm_campaign=x')
  })

  it('/start/hatch-street goes to /trial with Hatch preselected and the query kept', async () => {
    await expect(StudioStartPage({ searchParams: Promise.resolve({ utm_campaign: 'x' }), params: Promise.resolve({ path: 'hatch-street' }) })).rejects.toThrow(/^NEXT_REDIRECT:\/trial\?studio=hatch&utm_campaign=x$/)
    expect(mocks.redirect).toHaveBeenCalledWith('/trial?studio=hatch&utm_campaign=x')
  })

  it('/start/stillorgan goes to /trial with Stillorgan preselected', async () => {
    await expect(StudioStartPage({ searchParams: Promise.resolve({ fbclid: 'y' }), params: Promise.resolve({ path: 'stillorgan' }) })).rejects.toThrow(/^NEXT_REDIRECT:\/trial\?studio=stillorgan&fbclid=y$/)
    expect(mocks.redirect).toHaveBeenCalledWith('/trial?studio=stillorgan&fbclid=y')
  })
})
