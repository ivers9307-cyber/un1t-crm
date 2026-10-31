// @vitest-environment jsdom
//
// PAGES.1 (Task 18b): BlockRenderer threads pageId to every edit-mode upload
// site (hero tools, pillar photos, gallery, logo), beside locationId.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const seen = vi.hoisted(() => ({ hero: [], image: [], logo: [] }))
vi.mock('./HeroMediaTools', () => ({ default: (p) => { seen.hero.push({ pageId: p.pageId, locationId: p.locationId }); return null } }))
vi.mock('./EditableImage', () => ({ default: (p) => { seen.image.push({ pageId: p.pageId, locationId: p.locationId }); return null } }))
vi.mock('./LogoSwapper', () => ({ default: (p) => { seen.logo.push({ pageId: p.pageId, locationId: p.locationId }); return null } }))

import BlockRenderer, { SiteHeader } from './BlockRenderers.jsx'
import { newBlockOfType } from '@/lib/landing-page-blocks'

beforeEach(() => { seen.hero = []; seen.image = []; seen.logo = [] })

describe('BlockRenderer pageId threading', () => {
  it.each(['hero', 'pillars', 'gallery'])('%s passes pageId to its upload sites', (type) => {
    const block = newBlockOfType(type, { brand: 'UN1T' })
    renderToStaticMarkup(<BlockRenderer block={block} onEdit={() => {}} pageId="p-1" locationId={null} />)
    const all = [...seen.hero, ...seen.image]
    expect(all.length).toBeGreaterThan(0)
    for (const s of all) expect(s).toEqual({ pageId: 'p-1', locationId: null })
  })

  it('SiteHeader passes pageId to the logo swapper', () => {
    renderToStaticMarkup(<SiteHeader logoUrl="" onChangeLogo={() => {}} pageId="p-1" />)
    expect(seen.logo).toEqual([{ pageId: 'p-1', locationId: null }])
  })
})
