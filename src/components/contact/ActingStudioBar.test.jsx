// CARDLENS.6 — the studio bar on the contact page: which studio the page acts
// at, and links to switch. Nothing for a person the viewer shares one studio with.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ActingStudioBar from './ActingStudioBar.jsx'

const S = 'a0000000-0000-4000-8000-00000000000a'
const H = 'b0000000-0000-4000-8000-00000000000b'
const OPTIONS = [
  { locationId: S, name: 'UN1T Stillorgan', source: 'glofox', primary: true },
  { locationId: H, name: 'UN1T Hatch Street', source: 'un1t_online', primary: false },
]

describe('ActingStudioBar', () => {
  it('links each studio with ?studio= and marks the acting one', () => {
    const html = renderToStaticMarkup(<ActingStudioBar options={OPTIONS} actingId={H} />)
    expect(html).toContain(`href="?studio=${S}"`)
    expect(html).toContain(`href="?studio=${H}"`)
    expect(html).toMatch(new RegExp(`href="\\?studio=${H}"[^>]*aria-current="true"|aria-current="true"[^>]*href="\\?studio=${H}"`))
  })

  it('says where messages, bookings and notes go at that studio', () => {
    const html = renderToStaticMarkup(<ActingStudioBar options={OPTIONS} actingId={H} />)
    expect(html).toContain('Acting at UN1T Hatch Street')
    expect(html).toContain('Messages go from the UN1T Hatch Street number, bookings through un1t.online, notes file at UN1T Hatch Street.')
    const still = renderToStaticMarkup(<ActingStudioBar options={OPTIONS} actingId={S} />)
    expect(still).toContain('bookings through Glofox')
  })

  it('renders nothing with one studio or none', () => {
    expect(renderToStaticMarkup(<ActingStudioBar options={[OPTIONS[0]]} actingId={S} />)).toBe('')
    expect(renderToStaticMarkup(<ActingStudioBar options={[]} actingId={null} />)).toBe('')
  })
})
