// W1.M3a — the pipeline board is NOT gated (a lead-only gym needs
// new_lead → dormant); a derived board at a studio with no membership
// source carries one note above it, because the classifier's membership
// and credit stages cannot move there. A configured studio and a manual
// board see no note.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  // The route's create gate, as auth.js has it: master, or owner AT the studio.
  guardMasterOrOwner: (user, loc) => (user.profileRole === 'master' || user.rolesByLocation?.[loc] === 'owner' ? null : { status: 403 }),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn((u) => { throw new Error(`NEXT_REDIRECT:${u}`) }) }))
vi.mock('@/lib/membership/state-for-page', async (importOriginal) => ({ ...(await importOriginal()), membershipStateForPage: vi.fn() }))
vi.mock('@/lib/activity-write-gate', () => ({ canWriteActivitiesAt: () => true }))
// The board's props are captured so a test can read what the page shipped.
const boardProps = vi.hoisted(() => ({ last: null }))
vi.mock('@/components/KanbanBoard', () => ({ default: (props) => { boardProps.last = props; return <div>{`board:${props.initialStages.map((s) => s.slug).join(',')}`}</div> } }))
vi.mock('@/components/PipelineViewSwitcher', () => ({ default: () => <div>switcher</div> }))
vi.mock('@/components/StageFollowupCoverage', () => ({ default: (props) => <div>{`coverage:${props.pipelineId}:${props.canEditSequences}`}</div> }))
vi.mock('@/lib/sequence-access', () => ({ canBuildSequencesAt: vi.fn(() => false) }))
// HATCHCARD.1 — the signals read is mocked; the rest of the module is real.
vi.mock('@/lib/pipeline-card-signals', async (importOriginal) => ({ ...(await importOriginal()), loadUn1tCardSignals: vi.fn() }))

import Page from './page.js'
import KanbanBoard from '@/components/KanbanBoard'   // the mock above; its identity finds the board element
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { membershipStateForPage } from '@/lib/membership/state-for-page'
import { loadUn1tCardSignals } from '@/lib/pipeline-card-signals'
import { canBuildSequencesAt } from '@/lib/sequence-access'

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

// BOARDKEY.1 — switching boards (or views) is a client-side router.push, so
// the page re-renders with the NEW board's stages but React keeps the same
// KanbanBoard instance, whose column state was seeded once from the first
// board. The new stage ids had no entries: every column read "Load more
// (0 of N)" until a full page load (the €39 Trial board at Hatch, 2 Nov
// 2026). The board element must carry a key that changes with the board and
// the view, so React remounts it with the server's fresh first page.
describe('/pipeline — the board remounts per pipeline and view (BOARDKEY.1)', () => {
  const P1 = { id: 'p1', key: 'acquisition', name: 'Acquisition', mode: 'derived', module: 'acquisition_un1t' }
  const P2 = { id: 'p2', key: 'paid_trial', name: '€39 Trial', mode: 'derived', module: 'paid_trial_un1t' }
  const S1 = { id: 's1', slug: 'new_lead', name: 'New Leads', is_dormant: false, display_order: 301, pipeline_id: 'p1' }
  const S1D = { id: 's1d', slug: 'dormant', name: 'Dormant', is_dormant: true, display_order: 309, pipeline_id: 'p1' }
  const S2 = { id: 's2', slug: 'paid_trial_new_lead', name: 'New Leads', is_dormant: false, display_order: 601, pipeline_id: 'p2' }

  function dbTwoBoards() {
    return {
      from: (table) => {
        const state = { pipelineId: null }
        const chain = {}
        for (const m of ['select', 'in', 'order', 'range']) chain[m] = () => chain
        chain.eq = (col, v) => { if (col === 'pipeline_id') state.pipelineId = v; return chain }
        chain.then = (res, rej) => {
          let out
          if (table === 'pipelines') out = { data: [P1, P2], error: null }
          else if (table === 'pipeline_stages') out = { data: [S1, S1D, S2].filter((s) => s.pipeline_id === state.pipelineId), error: null }
          else out = { data: [], error: null, count: 0 }
          return Promise.resolve(out).then(res, rej)
        }
        return chain
      },
    }
  }

  // The KanbanBoard element in the page's tree (the module is mocked above,
  // so its type is the mock's default export).
  function findBoard(node) {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) { for (const n of node) { const f = findBoard(n); if (f) return f }; return null }
    if (node.type === KanbanBoard) return node
    return findBoard(node.props?.children)
  }

  beforeEach(() => {
    createServerClient.mockReturnValue(dbTwoBoards())
    membershipStateForPage.mockResolvedValue({ source: 'un1t_online', state: 'configured', label: 'un1t.online', capabilities: CAPS })
  })

  it('two boards get two different keys, each naming its pipeline', async () => {
    const acq = findBoard(await Page({ searchParams: { pipeline: 'acquisition' } }))
    const paid = findBoard(await Page({ searchParams: { pipeline: 'paid_trial' } }))
    expect(acq).toBeTruthy(); expect(paid).toBeTruthy()
    expect(typeof acq.key).toBe('string'); expect(acq.key).toContain('p1')
    expect(typeof paid.key).toBe('string'); expect(paid.key).toContain('p2')
    expect(acq.key).not.toBe(paid.key)
    // and the paid board was seeded with its own stages, not the first board's
    expect(paid.props.initialStages.map((s) => s.slug)).toEqual(['paid_trial_new_lead'])
  })

  it('the active and dormant views of one board get different keys', async () => {
    const active = findBoard(await Page({ searchParams: { pipeline: 'acquisition' } }))
    const dormant = findBoard(await Page({ searchParams: { pipeline: 'acquisition', view: 'dormant' } }))
    expect(active.key).not.toBe(dormant.key)
  })
})

// HATCHCARD.1 — a un1t.online board's live columns carry each card's signals,
// read once for the page from the board studio's own rows. A Glofox board and
// the off-funnel view are untouched; a failed signals read renders the board
// without them (decoration, never a blank board).
describe('/pipeline — un1t card signals (HATCHCARD.1)', () => {
  const SIG = { classes_attended: 2, credits_left: 1, credits_unlimited: false, next_class_at: null, last_class_days: 4, last_class_warm: false, wa_state: 'no_reply', wa_days: 5 }
  const stages = [
    { id: 'sN', slug: 'new_lead', name: 'New Leads', is_dormant: false, display_order: 301, pipeline_id: 'p1' },
    { id: 'sC', slug: 'converted', name: 'Converted', is_dormant: false, display_order: 305, pipeline_id: 'p1' },
    { id: 'sD', slug: 'dormant', name: 'Dormant', is_dormant: true, display_order: 309, pipeline_id: 'p1' },
  ]
  const dealsByStage = {
    sN: [{ id: 'd1', stage_id: 'sN', title: 'Ann', created_at: '2026-10-20T00:00:00Z', contacts: { id: 'c1', name: 'Ann', pipeline_stage_slug: 'new_lead' } }],
    sC: [{ id: 'd2', stage_id: 'sC', title: 'Bo', created_at: '2026-10-20T00:00:00Z', contacts: { id: 'c2', name: 'Bo', pipeline_stage_slug: 'converted' } }],
    sD: [{ id: 'd3', stage_id: 'sD', title: 'Cy', created_at: '2026-10-20T00:00:00Z', contacts: { id: 'c3', name: 'Cy', pipeline_stage_slug: 'dormant' } }],
  }
  function dbFor(module, { board_type, stageOverride } = {}) {
    return {
      from: (table) => {
        const st = { stageId: null, head: false }
        const chain = {}
        chain.select = (_c, o) => { st.head = !!o?.head; return chain }
        chain.eq = (c, v) => { if (c === 'stage_id') st.stageId = v; return chain }
        for (const m of ['in', 'order', 'range']) chain[m] = () => chain
        chain.then = (res, rej) => {
          let out
          if (table === 'pipelines') out = { data: [{ id: 'p1', key: 'acquisition', name: 'Acquisition', mode: 'derived', module, board_type: board_type ?? null }], error: null }
          else if (table === 'pipeline_stages') out = { data: stageOverride || stages, error: null }
          else if (st.head) out = { count: (dealsByStage[st.stageId] || []).length, error: null }
          else out = { data: dealsByStage[st.stageId] || [], error: null }
          return Promise.resolve(out).then(res, rej)
        }
        return chain
      },
    }
  }
  beforeEach(() => {
    boardProps.last = null
    loadUn1tCardSignals.mockReset()
    loadUn1tCardSignals.mockResolvedValue({ signals: new Map([['c1', SIG]]) })
    membershipStateForPage.mockResolvedValue({ source: 'un1t_online', state: 'configured', label: 'un1t.online', capabilities: CAPS })
  })

  it('a un1t board: reads signals once, for the live funnel columns only, and attaches them', async () => {
    createServerClient.mockReturnValue(dbFor('acquisition_un1t'))
    renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(loadUn1tCardSignals).toHaveBeenCalledTimes(1)
    const [, args] = loadUn1tCardSignals.mock.calls[0]
    expect(args.locationId).toBe(LOC)
    expect(args.contactIds).toEqual(['c1'])          // Converted (c2) carries none
    const byId = Object.fromEntries(boardProps.last.initialDeals.map((d) => [d.id, d]))
    expect(byId.d1.signals).toEqual(SIG)
  })

  it('a configured board reads signals for the stages whose ROLE is live funnel', async () => {
    const roleStages = [
      { id: 'sN', slug: 'my_first', name: 'First', is_dormant: false, stage_role: 'first_class', display_order: 301, pipeline_id: 'p1' },
      { id: 'sC', slug: 'my_bought', name: 'Bought', is_dormant: false, stage_role: 'converted', display_order: 305, pipeline_id: 'p1' },
    ]
    createServerClient.mockReturnValue(dbFor('acquisition_un1t', { board_type: 'offer', stageOverride: roleStages }))
    renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(loadUn1tCardSignals).toHaveBeenCalledTimes(1)
    expect(loadUn1tCardSignals.mock.calls[0][1].contactIds).toEqual(['c1'])
    const byId = Object.fromEntries(boardProps.last.initialDeals.map((d) => [d.id, d]))
    expect(byId.d1.showSignals).toBe(true)
    expect(byId.d1.classesOf3).toBe(true)   // acquisition_un1t
    expect(byId.d1.signals).toEqual(SIG)
  })

  it('a Glofox board: no signals read, no signals key on any card', async () => {
    createServerClient.mockReturnValue(dbFor('acquisition'))
    renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(loadUn1tCardSignals).not.toHaveBeenCalled()
    expect(boardProps.last.initialDeals.every((d) => !('signals' in d))).toBe(true)
  })

  it('the off-funnel view of a un1t board: no signals read', async () => {
    createServerClient.mockReturnValue(dbFor('acquisition_un1t'))
    renderToStaticMarkup(await Page({ searchParams: { view: 'dormant' } }))
    expect(loadUn1tCardSignals).not.toHaveBeenCalled()
  })

  it('a failed signals read renders the board without them, never throws', async () => {
    createServerClient.mockReturnValue(dbFor('acquisition_un1t'))
    loadUn1tCardSignals.mockResolvedValue({ error: { message: 'boom' } })
    const html = renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(html).toContain('board:')
    expect(boardProps.last.initialDeals.every((d) => !('signals' in d))).toBe(true)
  })
})

// PIPEBUILD.1f — the follow-up coverage strip: a derived board, for someone who
// can build sequences or manages the studio, and nobody else.
describe('/pipeline — follow-up coverage strip (PIPEBUILD.1f)', () => {
  const asRole = (role) => getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'staff', rolesByLocation: { [LOC]: role }, activeLocation: { id: LOC, name: 'Studio' } })
  beforeEach(() => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
  })

  it('rendersCoverageForManagers', async () => {
    asRole('manager')
    canBuildSequencesAt.mockReturnValue(false)
    const html = renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(html).toContain('coverage:p1:false')
    expect(html.indexOf('coverage:')).toBeLessThan(html.indexOf('switcher'))
    canBuildSequencesAt.mockReturnValue(true)
    expect(renderToStaticMarkup(await Page({ searchParams: {} }))).toContain('coverage:p1:true')
  })

  it('hidesCoverageForStaff', async () => {
    asRole('staff')
    canBuildSequencesAt.mockReturnValue(false)
    expect(renderToStaticMarkup(await Page({ searchParams: {} }))).not.toContain('coverage:')
  })

  it('hidesCoverageOnManualBoards', async () => {
    asRole('owner')
    createServerClient.mockReturnValue(dbFor({ mode: 'manual' }))
    expect(renderToStaticMarkup(await Page({ searchParams: {} }))).not.toContain('coverage:')
  })
})


// PIPEBUILD.5p — the board header links into the builder: "New pipeline" for
// whoever may create a board here, and the active board's settings for
// managers and up ("Edit pipeline" on an offer board, the read-only list for a
// built-in one). Staff see neither.
describe('/pipeline — builder links (PIPEBUILD.5p)', () => {
  function dbBoards(rows) {
    return {
      from: (table) => {
        const chain = {}
        for (const m of ['select', 'eq', 'in', 'order', 'range']) chain[m] = () => chain
        const out = table === 'pipelines' ? { data: rows, error: null }
          : table === 'pipeline_stages' ? { data: [STAGE], error: null }
          : { data: [], error: null, count: 0 }
        chain.then = (res, rej) => Promise.resolve(out).then(res, rej)
        return chain
      },
    }
  }
  const asRole = (role, profileRole = 'staff') => getCurrentUser.mockResolvedValue({
    id: 'u1', profileRole, rolesByLocation: role ? { [LOC]: role } : {}, activeLocation: { id: LOC, name: 'Studio' },
  })
  const BUILT_IN = { id: 'p1', key: 'funnel', name: 'Funnel', mode: 'derived', module: 'acquisition', board_type: null }
  const OFFER = { id: 'p9', key: 'o_reset', name: 'Reset', mode: 'derived', module: 'offer', board_type: 'offer' }

  beforeEach(() => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
  })

  it('owner on an offer board: New pipeline and Edit pipeline (that board)', async () => {
    asRole('owner')
    createServerClient.mockReturnValue(dbBoards([OFFER]))
    const html = renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(html).toContain('href="/settings/pipelines/new"')
    expect(html).toContain('New pipeline')
    expect(html).toContain('href="/settings/pipelines/p9"')
    expect(html).toContain('Edit pipeline')
  })

  it('owner on a built-in board: the settings list, never an edit link for code', async () => {
    asRole('owner')
    createServerClient.mockReturnValue(dbBoards([BUILT_IN]))
    const html = renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(html).toContain('href="/settings/pipelines"')
    expect(html).toContain('Pipeline settings')
    expect(html).not.toContain('Edit pipeline')
    expect(html).not.toContain('href="/settings/pipelines/p1"')
  })

  it('manager: the settings link, no New pipeline (creating is owner-only)', async () => {
    asRole('manager')
    createServerClient.mockReturnValue(dbBoards([OFFER]))
    const html = renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(html).toContain('href="/settings/pipelines/p9"')
    expect(html).not.toContain('New pipeline')
  })

  it('staff: neither link', async () => {
    asRole('staff')
    createServerClient.mockReturnValue(dbBoards([OFFER]))
    const html = renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(html).not.toContain('/settings/pipelines')
  })

  it('master with no role here: both links', async () => {
    asRole(null, 'master')
    createServerClient.mockReturnValue(dbBoards([OFFER]))
    const html = renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(html).toContain('New pipeline')
    expect(html).toContain('Edit pipeline')
  })

  it('no board yet: an owner still gets New pipeline', async () => {
    asRole('owner')
    createServerClient.mockReturnValue(dbBoards([]))
    const html = renderToStaticMarkup(await Page({ searchParams: {} }))
    expect(html).toContain('No pipeline is configured')
    expect(html).toContain('href="/settings/pipelines/new"')
  })
})
