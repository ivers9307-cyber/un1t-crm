// INTEGONE.3 — the Health view's panel (the body of the retired
// /settings/integration-health page): chips per row, the studio picker shows
// only the studios handed in and marks the selected one, the empty state.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/link', () => ({
  default: ({ href, children, className, ...rest }) => <a href={typeof href === 'string' ? href : ''} className={className} {...rest}>{children}</a>,
}))

import IntegrationHealthPanel, { ago } from './IntegrationHealthPanel.jsx'

const ROWS = [
  { key: 'crons', name: 'Scheduled jobs', status: 'ok', detail: 'All on time', lastSuccess: new Date(Date.now() - 5 * 60_000).toISOString() },
  { key: 'wa', name: 'WhatsApp', status: 'warn', detail: 'Quality rating: YELLOW', remedy: 'Check the number.', href: '/settings/integrations-hub?manage=whatsapp&location=loc-a' },
  { key: 'xero', name: 'Xero', status: 'down', detail: 'Token expired' },
  { key: 'x', name: 'Mystery', status: 'something-else', detail: '?' },
]
const LOCS = [{ id: 'loc-a', name: 'Stillorgan' }, { id: 'loc-b', name: 'Hatch Street' }]

describe('IntegrationHealthPanel', () => {
  it('renders each row with the right chip, the overall chip, and a Fix link only where there is a remedy href', () => {
    const html = renderToStaticMarkup(
      <IntegrationHealthPanel rows={ROWS} overall="down" locationName="Stillorgan" locations={LOCS} selectedLocationId="loc-a" />,
    )
    expect(html).toContain('Scheduled jobs')
    expect(html).toMatch(/bg-green-500\/10 text-green-700[^>]*>Healthy/)
    expect(html).toMatch(/bg-amber-500\/10 text-amber-700[^>]*>Degraded/)
    expect(html).toMatch(/bg-red-500\/10 text-red-700[^>]*>Down/)
    expect(html).toMatch(/bg-slate-500\/10 text-slate-700[^>]*>Unknown/) // an unrecognised status degrades to Unknown
    expect(html.match(/Fix →/g)).toHaveLength(1)
    expect(html).toContain('href="/settings/integrations-hub?manage=whatsapp&amp;location=loc-a"')
    expect(html).toContain('· Stillorgan')
    expect(html).toContain('last ok 5m ago')
  })

  it('the picker lists only the studios handed in, as hub links, and marks the selected one', () => {
    const html = renderToStaticMarkup(
      <IntegrationHealthPanel rows={ROWS} overall="ok" locationName="Hatch Street" locations={LOCS} selectedLocationId="loc-b" />,
    )
    expect(html).toContain('href="/settings/integrations-hub?view=health&amp;location=loc-a"')
    expect(html).toContain('href="/settings/integrations-hub?view=health&amp;location=loc-b"')
    expect(html).not.toContain('loc-c')
    // aria-current on the selected studio only
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-current="page"[^>]*>Hatch Street/)
  })

  it('shows no picker for a single studio', () => {
    const html = renderToStaticMarkup(
      <IntegrationHealthPanel rows={ROWS} overall="ok" locations={[LOCS[0]]} selectedLocationId="loc-a" />,
    )
    expect(html).not.toContain('view=health')
  })

  it('no rows reads "No integrations to report."', () => {
    const html = renderToStaticMarkup(<IntegrationHealthPanel rows={[]} overall="unknown" locations={[]} />)
    expect(html).toContain('No integrations to report.')
    expect(html).toMatch(/bg-slate-500\/10 text-slate-700[^>]*>Unknown/)
  })

  it('ago() buckets', () => {
    const now = Date.parse('2026-10-25T12:00:00Z')
    expect(ago(null, now)).toBe('—')
    expect(ago('2026-10-25T11:59:30Z', now)).toBe('just now')
    expect(ago('2026-10-25T11:30:00Z', now)).toBe('30m ago')
    expect(ago('2026-10-25T11:00:00Z', now)).toBe('1h ago')
    expect(ago('2026-10-25T08:00:00Z', now)).toBe('4h ago')
    expect(ago('2026-10-23T12:00:00Z', now)).toBe('2d ago')
  })
})
