// UN1TWRITE.17 — /legal/un1t/[slug]/[doc]: the studio's un1t.online terms or
// waiver, as text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const NOT_FOUND = new Error('NEXT_NOT_FOUND')
vi.mock('next/navigation', () => ({ notFound: () => { throw NOT_FOUND } }))

// PAGES.1 — the page is a kind='studio' landing_pages row, its studio row
// carries the location embed. `page` / `studios` are what the two reads answer.
let page
let studios
let reads
vi.mock('next/headers', () => ({ headers: async () => new Map([['host', 'un1tdublin.com']]) }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      const filters = []
      const b = {
        select: () => b,
        eq: (c, v) => { filters.push([c, v]); return b },
        order: () => { reads.push({ table, filters }); return Promise.resolve(studios) },
        maybeSingle: async () => { reads.push({ table, filters }); return page },
      }
      return b
    },
  }),
}))
let docs
vi.mock('@/lib/un1t-online-legal', async (importOriginal) => ({
  ...(await importOriginal()),
  readUn1tLegalDocs: vi.fn(async () => docs),
}))

import Page from './page'
import { UN1T_GROUP_ORG_ID } from '@/lib/brands'
import { readUn1tLegalDocs } from '@/lib/un1t-online-legal'

const hatchPage = (over = {}) => ({
  data: { id: 'P1', organization_id: UN1T_GROUP_ORG_ID, slug: 'hatch-street', kind: 'studio', scope: 'one', primary_location_id: 'HATCH', chrome: {}, publish_state: 'live', ...over },
  error: null,
})
const hatchStudios = (locations = { name: 'Hatch Street', membership_source: 'un1t_online' }) => ({
  data: [{ page_id: 'P1', location_id: 'HATCH', enabled: true, locations }],
  error: null,
})

async function render(slug, doc) {
  const el = await Page({ params: Promise.resolve({ slug, doc }) })
  return renderToStaticMarkup(el)
}

beforeEach(() => {
  vi.clearAllMocks()
  reads = []
  page = hatchPage()
  studios = hatchStudios()
  docs = {
    terms: { content: 'Rule one.\n<script>alert(1)</script>', updatedAt: '2026-09-01T10:00:00Z' },
    waiver: { content: 'Waiver words', updatedAt: null },
    version: 'v',
  }
})

describe('/legal/un1t/[slug]/[doc]', () => {
  it('renders the studio name and the document as text, never as HTML', async () => {
    const html = await render('hatch-street', 'terms')
    // The studio page at that slug in the HOST's organisation (un1tdublin.com: UN1T Group).
    expect(reads[0]).toEqual({ table: 'landing_pages', filters: [['organization_id', UN1T_GROUP_ORG_ID], ['slug', 'hatch-street']] })
    expect(reads.map((r) => r.table)).not.toContain('landing_page_settings')
    expect(readUn1tLegalDocs).toHaveBeenCalledWith(expect.anything(), 'HATCH')
    expect(html).toContain('Hatch Street')
    expect(html).toContain('Rule one.')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('white-space:pre-wrap')
    // A link to the other document.
    expect(html).toContain('href="/legal/un1t/hatch-street/waiver"')
  })

  it('renders the waiver and links back to the terms', async () => {
    const html = await render('hatch-street', 'waiver')
    expect(html).toContain('Waiver words')
    expect(html).toContain('href="/legal/un1t/hatch-street/terms"')
  })

  it('a failed read shows the operator message (default when blank)', async () => {
    docs = { terms: null, waiver: null, version: null }
    expect(await render('hatch-street', 'terms')).toContain('This document could not be loaded right now. Please try again shortly.')
    // The operator wording is the page's chrome.un1t_terms (a blank key is its default).
    page = hatchPage({ chrome: { un1t_terms: { legal_unavailable_message: 'Back soon.', terms_link_label: 'house rules' } } })
    const html = await render('hatch-street', 'terms')
    expect(html).toContain('Back soon.')
    expect(html).toContain('House rules')
  })

  it('404s for an unknown slug, a campaign page, a non-un1t studio, an unknown doc or a read error', async () => {
    page = { data: null, error: null }
    await expect(render('nowhere', 'terms')).rejects.toBe(NOT_FOUND)
    page = hatchPage({ kind: 'campaign' })
    await expect(render('hatch-street', 'terms')).rejects.toBe(NOT_FOUND)
    page = hatchPage()
    studios = hatchStudios({ name: 'Stillorgan', membership_source: 'glofox' })
    await expect(render('stillorgan', 'terms')).rejects.toBe(NOT_FOUND)
    studios = hatchStudios()
    await expect(render('hatch-street', 'privacy')).rejects.toBe(NOT_FOUND)
    page = { data: null, error: { code: 'XX' } }
    await expect(render('hatch-street', 'terms')).rejects.toBe(NOT_FOUND)
    page = hatchPage()
    studios = { data: null, error: { code: 'XX' } }
    await expect(render('hatch-street', 'terms')).rejects.toBe(NOT_FOUND)
    // A slug that cannot be a page slug is never looked up.
    reads = []
    await expect(render('Hatch Street!', 'terms')).rejects.toBe(NOT_FOUND)
    expect(reads).toEqual([])
    expect(readUn1tLegalDocs).not.toHaveBeenCalled()
  })
})
