// CARDLENS.8 — the studios strip under the contact header: one tile per studio
// the person has a relationship with, each on its own platform, and the
// switcher for the studio the page acts at (or All studios).
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import StudioStrip from './StudioStrip.jsx'

const S = 'a0000000-0000-4000-8000-00000000000a'
const H = 'b0000000-0000-4000-8000-00000000000b'
const m = (id, name, platform, extra = {}) => ({
  locationId: id, name, platform, primary: false, kind: 'member', status: 'active', plan: null,
  creditsLine: null, attended30d: null, lastAttendedAt: null, ltvCents: null, owedCents: 0,
  overdue: false, amountUnreported: false, syncedAt: null, ...extra,
})
const MEMBERSHIPS = [
  m(S, 'UN1T Stillorgan', 'glofox', { primary: true, plan: 'Unlimited monthly', attended30d: 9 }),
  m(H, 'UN1T Hatch Street', 'un1t_online', { kind: 'client', plan: '10-class pack', attended30d: 3, overdue: true, owedCents: 4500 }),
]
const OPTIONS = [
  { locationId: S, name: 'UN1T Stillorgan', source: 'glofox', primary: true },
  { locationId: H, name: 'UN1T Hatch Street', source: 'un1t_online', primary: false },
]
const html = (props) => renderToStaticMarkup(<StudioStrip memberships={MEMBERSHIPS} options={OPTIONS} actingId={H} lensAll={false} {...props} />)

describe('StudioStrip', () => {
  it('one tile per studio with its platform, plan and attendance', () => {
    const h = html()
    expect(h).toContain('UN1T Stillorgan')
    expect(h).toContain('UN1T Hatch Street')
    expect(h).toContain('Glofox')
    expect(h).toContain('un1t.online')
    expect(h).toContain('Unlimited monthly')
    expect(h).toContain('10-class pack')
    expect(h).toContain('Primary')
  })

  it('an overdue studio says what it owes', () => {
    expect(html()).toContain('€45 overdue')
  })

  it('tiles are ?studio= links where the viewer can act, and the acting tile is marked', () => {
    const h = html()
    expect(h).toContain(`href="?studio=${S}"`)
    expect(h).toMatch(new RegExp(`aria-current="true"[^>]*href="\\?studio=${H}"|href="\\?studio=${H}"[^>]*aria-current="true"`))
  })

  it('a studio the viewer cannot act at is a plain tile, not a link', () => {
    const h = html({ options: [OPTIONS[1]] })
    expect(h).not.toContain(`href="?studio=${S}"`)
    expect(h).toContain('UN1T Stillorgan')
  })

  it('offers All studios, and says where actions go', () => {
    const h = html()
    expect(h).toContain('href="?studio=all"')
    // CARDLENS.11 — never claims a WhatsApp number the studio may not have.
    expect(h).toContain('Messages, notes and tasks are for UN1T Hatch Street; bookings go through un1t.online.')
    expect(h).not.toContain(' number')
  })

  it('under All studios, says actions need a studio', () => {
    const h = html({ lensAll: true })
    expect(h).toMatch(/aria-current="true"[^>]*href="\?studio=all"|href="\?studio=all"[^>]*aria-current="true"/)
    expect(h).toContain('Viewing all studios. Pick a studio to message, book or add a note.')
  })

  it('renders nothing for a one-studio person', () => {
    expect(renderToStaticMarkup(<StudioStrip memberships={[MEMBERSHIPS[0]]} options={[OPTIONS[0]]} actingId={S} lensAll={false} />)).toBe('')
  })

  // CARDLENS.11 — switching studio keeps the rest of the page's query.
  it('keeps other query parameters on every link', () => {
    const h = html({ query: { tab: 'timeline', studio: S, multi: ['a', 'b'] } })
    expect(h).toContain(`href="?tab=timeline&amp;multi=a&amp;studio=${H}"`)
    expect(h).toContain('href="?tab=timeline&amp;multi=a&amp;studio=all"')
  })

  it('an overdue in another currency says so', () => {
    const h = html({ memberships: [MEMBERSHIPS[0], { ...MEMBERSHIPS[1], owedCents: null, amountUnreported: true, amountNotEur: true }] })
    expect(h).toContain('Overdue · amount not in EUR')
  })
})
