// UN1TWRITE.17 — /legal/un1t/[slug]/[doc]: the studio's un1t.online terms or
// waiver, as text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const NOT_FOUND = new Error('NEXT_NOT_FOUND')
vi.mock('next/navigation', () => ({ notFound: () => { throw NOT_FOUND } }))

let row
let readArgs
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      const b = {
        select: () => b,
        eq: (c, v) => { readArgs = { table, c, v }; return b },
        maybeSingle: async () => row,
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
import { readUn1tLegalDocs } from '@/lib/un1t-online-legal'

const hatch = (over = {}) => ({
  data: {
    location_id: 'HATCH',
    blocks: [{ type: 'class_funnel', legal_unavailable_message: '' }],
    locations: { name: 'Hatch Street', membership_source: 'un1t_online' },
    ...over,
  },
  error: null,
})

async function render(slug, doc) {
  const el = await Page({ params: Promise.resolve({ slug, doc }) })
  return renderToStaticMarkup(el)
}

beforeEach(() => {
  vi.clearAllMocks()
  row = hatch()
  docs = {
    terms: { content: 'Rule one.\n<script>alert(1)</script>', updatedAt: '2026-09-01T10:00:00Z' },
    waiver: { content: 'Waiver words', updatedAt: null },
    version: 'v',
  }
})

describe('/legal/un1t/[slug]/[doc]', () => {
  it('renders the studio name and the document as text, never as HTML', async () => {
    const html = await render('hatch-street', 'terms')
    expect(readArgs).toEqual({ table: 'landing_page_settings', c: 'public_path', v: 'hatch-street' })
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
    row = hatch({ blocks: [{ type: 'class_funnel', legal_unavailable_message: 'Back soon.' }] })
    expect(await render('hatch-street', 'terms')).toContain('Back soon.')
  })

  it('404s for an unknown slug, a non-un1t studio, an unknown doc or a read error', async () => {
    row = { data: null, error: null }
    await expect(render('nowhere', 'terms')).rejects.toBe(NOT_FOUND)
    row = hatch({ locations: { name: 'Stillorgan', membership_source: 'glofox' } })
    await expect(render('stillorgan', 'terms')).rejects.toBe(NOT_FOUND)
    row = hatch()
    await expect(render('hatch-street', 'privacy')).rejects.toBe(NOT_FOUND)
    row = { data: null, error: { code: 'XX' } }
    await expect(render('hatch-street', 'terms')).rejects.toBe(NOT_FOUND)
    expect(readUn1tLegalDocs).not.toHaveBeenCalled()
  })
})
