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
// The board's props are captured so a test can read what the page shipped.
const boardProps = vi.hoisted(() => ({ last: null }))
vi.mock('@/components/KanbanBoard', () => ({ default: (props) => { boardProps.last = props; return <div>{`board:${props.initialStages.map((s) => s.slug).join(',')}`}</div> } }))
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
    expect(html).toContain(`href="/settings/integrations-hub?manage=membership-source&amp;location=${LOC}"`)
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


// HATCHPIPE.4 — funnel and manual columns ship EVERY card on the first load
// (1,000-row .range() pages with an explicit order, looped to the column's
// count); only the off-funnel piles keep the 50-card page + Load more.
describe('/pipeline — whole-column load (HATCHPIPE.4)', () => {
  const OFF = { id: 's2', slug: 'dormant', name: 'Dormant', is_dormant: true, display_order: 2, pipeline_id: 'p1' }
  const deal = (stageId, i) => ({ id: `d${stageId}-${i}`, stage_id: stageId, title: 't', created_at: '2026-10-01T00:00:00Z', contacts: { id: `c${i}`, pipeline_stage_slug: 'new_lead', recent_bookings: [] } })

  // A deals table serving `perStage[stageId]` rows by .range(), recording each
  // read (range bounds + order calls) and each head-count.
  function dbWith({ mode = 'derived', perStage = {}, dealsError = null, countError = null }) {
    const reads = []
    const db = {
      from: (table) => {
        const state = { table, head: false, stageId: null, range: null, orders: [] }
        const chain = {}
        chain.select = (_cols, opts) => { state.head = !!opts?.head; return chain }
        chain.eq = (col, v) => { if (col === 'stage_id') state.stageId = v; return chain }
        chain.in = () => chain
        chain.order = (col, o) => { state.orders.push([col, o?.ascending]); return chain }
        chain.range = (from, to) => { state.range = [from, to]; return chain }
        chain.then = (res, rej) => {
          let out
          if (table === 'pipelines') out = { data: [{ id: 'p1', key: 'funnel', name: 'Funnel', mode }], error: null }
          else if (table === 'pipeline_stages') out = { data: [STAGE, OFF], error: null }
          else if (state.head) out = countError ? { count: null, error: countError } : { count: (perStage[state.stageId] || []).length, error: null }
          else {
            reads.push(state)
            const all = perStage[state.stageId] || []
            out = dealsError ? { data: null, error: dealsError }
              : { data: all.slice(state.range[0], state.range[1] + 1), error: null }
          }
          return Promise.resolve(out).then(res, rej)
        }
        return chain
      },
    }
    return { db, reads }
  }

  beforeEach(() => {
    boardProps.last = null
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
  })

  it('funnel view: ships every card of a column larger than one 1,000-row page, in explicit order', async () => {
    const rows = Array.from({ length: 2300 }, (_, i) => deal('s1', i))
    const { db, reads } = dbWith({ perStage: { s1: rows } })
    createServerClient.mockReturnValue(db)
    renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(boardProps.last.initialDeals).toHaveLength(2300)
    expect(boardProps.last.stageCounts).toEqual({ s1: 2300 })
    // "Load more" shows only while loaded < total; loaded === total here.
    expect(boardProps.last.initialDeals.length).toBe(boardProps.last.stageCounts.s1)
    expect(reads.map((r) => r.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    for (const r of reads) expect(r.orders).toEqual([['created_at', false], ['id', undefined]])
  })

  it('funnel view: a small column is one read of 1,000, not 50', async () => {
    const { db, reads } = dbWith({ perStage: { s1: Array.from({ length: 96 }, (_, i) => deal('s1', i)) } })
    createServerClient.mockReturnValue(db)
    renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(boardProps.last.initialDeals).toHaveLength(96)
    expect(reads.map((r) => r.range)).toEqual([[0, 999]])
  })

  it('manual board: loads whole (even if ?view=dormant)', async () => {
    const { db } = dbWith({ mode: 'manual', perStage: { s1: Array.from({ length: 159 }, (_, i) => deal('s1', i)), s2: [deal('s2', 1), deal('s2', 2)] } })
    createServerClient.mockReturnValue(db)
    renderToStaticMarkup(await Page({ searchParams: { view: 'dormant' } }))
    expect(boardProps.last.initialDeals).toHaveLength(161)
    expect(boardProps.last.stageCounts).toEqual({ s1: 159, s2: 2 })
  })

  it('off-funnel view keeps the 50-card first page and the full count (Load more stays)', async () => {
    const { db, reads } = dbWith({ perStage: { s2: Array.from({ length: 5457 }, (_, i) => deal('s2', i)) } })
    createServerClient.mockReturnValue(db)
    renderToStaticMarkup(await Page({ searchParams: { view: 'dormant' } }))
    expect(boardProps.last.initialDeals).toHaveLength(50)
    expect(boardProps.last.stageCounts).toEqual({ s2: 5457 })
    expect(reads.map((r) => r.range)).toEqual([[0, 49]])
  })

  it('a failed deal read throws instead of rendering an empty column', async () => {
    const { db } = dbWith({ dealsError: { message: 'canceling statement due to statement timeout', code: '57014' } })
    createServerClient.mockReturnValue(db)
    await expect(Page({ searchParams: {} })).rejects.toThrow(/pipeline deals load/)
  })

  it('a failed deal count throws instead of rendering a zero badge', async () => {
    const { db } = dbWith({ countError: { message: 'boom', code: '57014' } })
    createServerClient.mockReturnValue(db)
    await expect(Page({ searchParams: {} })).rejects.toThrow(/pipeline deals count/)
  })
})
