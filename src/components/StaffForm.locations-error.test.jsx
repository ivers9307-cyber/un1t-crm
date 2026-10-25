// STAFFFORMSETTINGS.1 (review N1) — when the studios read fails, the page
// still renders the form (never louder than the old silent empty list), but
// StaffForm says so: with no studios listed, an edit could be saved without
// the person's assignments ever having been shown.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

const { default: StaffForm } = await import('./StaffForm.jsx')

const NOTICE = /Couldn(?:'|&#x27;)t load studios\. Reload before editing\./

describe('StaffForm — failed studios read (STAFFFORMSETTINGS.1 N1)', () => {
  it('shows a small notice when the page says the studios did not load, and still renders the form', () => {
    const html = renderToStaticMarkup(<StaffForm locations={[]} locationsLoadFailed callerIsMaster />)
    expect(html).toMatch(NOTICE)
    expect(html).toContain('<form')
    expect(html).toContain('Account Details')
  })

  it('shows no notice on a good read', () => {
    const html = renderToStaticMarkup(<StaffForm locations={[]} callerIsMaster />)
    expect(html).not.toMatch(NOTICE)
    expect(html).toContain('<form')
  })
})
