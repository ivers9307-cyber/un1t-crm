// W1.M3a — the pipeline board is NOT gated (a lead-only gym needs
// new_lead → dormant); a derived board at a studio with no membership
// source carries one note above it, because the classifier's membership
// and credit stages cannot move there. A configured studio and a manual
// board see no note.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn((u) => { throw new Error(`NEXT_REDIRECT:${u}`) }) }))
vi.mock('@/lib/membership/state-for-page', async (importOriginal) => ({ ...(await importOriginal()), membershipStateForPage: vi.fn() }))
vi.mock('@/lib/activity-write-gate', () => ({ canWriteActivitiesAt: () => true }))
vi.mock('@/components/KanbanBoard', () => ({ default: ({ initialStages }) => <div>{`board:${initialStages.map((s) => s.slug).join(',')}`}</div> }))
vi.mock('@/components/PipelineViewSwitcher', () => ({ default: () => <div>switcher</div> }))

import Page from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { membershipStateForPage } from '@/lib/membership/state-for-page'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }
const STAGE = { id: 's1', slug: 'new_lead', name: 'New lead', is_dormant: false, display_order: 1, pipeline_id: 'p1' }

// Every chain resolves by table: pipelines → the board rows, pipeline_stages
// → one live stage, deals → an empty page / a zero count.
function dbFor({ mode }) {
  const resultFor = (table) => {
    if (table === 'pipelines') return { data: [{ id: 'p1', key: 'funnel', name: 'Funnel', mode }], error: null }
    if (table === 'pipeline_stages') return { data: [STAGE], error: null }
    return { data: [], error: null, count: 0 }
  }
  return {
    from: (table) => {
      const chain = {}
      for (const m of ['select', 'eq', 'in', 'order', 'range']) chain[m] = () => chain
      chain.then = (res, rej) => Promise.resolve(resultFor(table)).then(res, rej)
      return chain
    },
  }
}

const NOTE = /Stages that depend on memberships and credits will not move without a membership source/

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' }, activeLocation: { id: LOC, name: 'Studio' } })
  createServerClient.mockReturnValue(dbFor({ mode: 'derived' }))
})

describe('/pipeline — membership source note (W1.M3a)', () => {
  it('configured: the board, no note', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    const html = renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(html).toContain('board:new_lead')
    expect(html).not.toMatch(NOTE)
  })

  it('none, derived board: the note above the board, and the board still renders', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'No membership source', capabilities: {} })
    const html = renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(html).toMatch(NOTE)
    expect(html).toContain('board:new_lead')
    expect(html.indexOf('Stages that depend')).toBeLessThan(html.indexOf('board:new_lead'))
    expect(html).toContain(`href="/settings/locations/${LOC}?section=integrations&amp;tab=glofox"`)
  })

  it('none, MANUAL board: no note (nothing is classifier-driven there)', async () => {
    createServerClient.mockReturnValue(dbFor({ mode: 'manual' }))
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'No membership source', capabilities: {} })
    const html = renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(html).not.toMatch(NOTE)
    expect(html).toContain('board:new_lead')
  })

  it('unknown: no note (the note is only for a KNOWN absence), board renders', async () => {
    membershipStateForPage.mockResolvedValue({ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: {} })
    const html = renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(html).not.toMatch(NOTE)
    expect(html).toContain('board:new_lead')
  })
})
