// @vitest-environment jsdom
// PIPE3.9 — every stage the two Stillorgan claim boards declare has a colour,
// a label and a chip wherever a slug is shown, so a new slug never renders as
// a raw string or a grey dot.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getBoardModule } from '@shared/pipelines/index.js'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/pipeline',
}))
// PIPEBUILD.2d — the hook is mocked; each test sets what it returns.
let mockStages = { stages: null, bySlug: new Map(), error: false }
vi.mock('@/lib/use-studio-stages', () => ({ useStudioStages: () => mockStages }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
const loaded = (stages) => ({ stages, bySlug: new Map(stages.map((s) => [s.slug, s])), error: false })
const CUSTOM = { slug: 'vip_intro', name: 'VIP intro', color: '#112233', board_name: 'VIP board', stage_role: null }
afterEach(() => { cleanup(); mockStages = { stages: null, bySlug: new Map(), error: false } })

vi.mock('./DealCard', () => ({ default: () => null }))
vi.mock('./contact/ContactDrawer', () => ({ default: () => null }))

const { stageColors } = await import('./KanbanBoard.jsx')
const { STAGE_LABELS: AUDIENCE_LABELS } = await import('./AudienceBuilder.jsx')
const { STAGE_LABELS: RECLASSIFY_LABELS } = await import('./PipelineReclassifyTab.jsx')
const { statusBadge } = await import('./ContactsTable.jsx')

const NEW_SLUGS = [
  ...getBoardModule('paid_trial').stages.map((s) => s.slug),
  ...getBoardModule('programmes').stages.map((s) => s.slug),
]

describe('REBOOK.1 — the Hatch board\'s Rebook column', () => {
  const rebook = getBoardModule('acquisition_un1t').stages.find((s) => s.slug === 'rebook')
  it('has a Kanban colour matching its module row, labels, and a light-card chip', () => {
    expect(stageColors.rebook).toBe(rebook.color)
    expect(AUDIENCE_LABELS.rebook).toMatch(/^Rebook/)
    expect(RECLASSIFY_LABELS.rebook).toBe('Rebook')
    expect(statusBadge.rebook).toMatch(/^bg-[a-z]+-500\/20 text-[a-z]+-700$/)
  })
})

describe('the eight new stage slugs', () => {
  it('are the two modules\' slugs', () => {
    expect(NEW_SLUGS).toEqual([
      'paid_trial_new_lead', 'paid_trial_first_class', 'paid_trial_day_7', 'paid_trial_done', 'paid_trial_converted',
      'programme_lead', 'programme_first_class', 'programme_converted',
    ])
  })
  it('each has a Kanban colour that matches its module row', () => {
    for (const mod of ['paid_trial', 'programmes']) {
      for (const s of getBoardModule(mod).stages) expect(stageColors[s.slug], s.slug).toBe(s.color)
    }
  })
  it('each has an audience label and a reclassify label naming its board', () => {
    for (const slug of NEW_SLUGS) {
      expect(AUDIENCE_LABELS[slug], slug).toMatch(/^(€39 trial|Programme): /)
      expect(RECLASSIFY_LABELS[slug], slug).toMatch(/^(€39 Trial|Programmes) — /)
    }
  })
  it('each has a contacts-list chip in the light-card recipe (bg-*-500/20 + text-*-700)', () => {
    for (const slug of NEW_SLUGS) expect(statusBadge[slug], slug).toMatch(/^bg-[a-z]+-500\/20 text-[a-z]+-700$/)
  })
})

describe('PIPEBUILD.2d — stage display from data', () => {
  it('kanbanUsesStageColor', async () => {
    const { default: KanbanBoard } = await import('./KanbanBoard.jsx')
    const stages = [
      { id: 's1', slug: 'vip_intro', name: 'VIP intro', color: '#112233' },
      { id: 's2', slug: 'new_lead', name: 'New lead', color: null },
      { id: 's3', slug: 'mystery', name: 'Mystery' },
    ]
    const html = renderToStaticMarkup(<KanbanBoard initialStages={stages} initialDeals={[]} stageCounts={{}} locationId="l-1" />)
    expect(html).toContain('background-color:#112233')
    expect(html).toContain(`background-color:${stageColors.new_lead}`)
    expect(html).toContain('background-color:#6B7280')
  })

  it('audienceOffersStudioStages', async () => {
    mockStages = loaded([CUSTOM, { slug: 'member', name: 'Member', board_name: 'Main' }])
    const { default: AudienceBuilder } = await import('./AudienceBuilder.jsx')
    const filter = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'new_lead' }] }
    render(<AudienceBuilder filter={filter} onChange={() => {}} locationId="l-1" />)
    const select = screen.getByLabelText('Value')
    const opts = Array.from(select.querySelectorAll('option'))
    expect(opts.slice(0, 2).map((o) => o.value)).toEqual(['new_lead', 'rebook'])
    expect(opts.filter((o) => o.value === 'member')).toHaveLength(1)
    expect(opts[opts.length - 1].value).toBe('vip_intro')
    expect(opts[opts.length - 1].textContent).toBe('VIP board: VIP intro')
  })

  it('knownSlugsUnchangedWhileLoading', async () => {
    const { default: AudienceBuilder } = await import('./AudienceBuilder.jsx')
    const { default: ContactsTable } = await import('./ContactsTable.jsx')
    const filter = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'new_lead' }] }
    render(<AudienceBuilder filter={filter} onChange={() => {}} locationId="l-1" />)
    const opts = Array.from(screen.getByLabelText('Value').querySelectorAll('option'))
    expect(opts.map((o) => o.value)).toEqual(['new_lead', 'rebook', 'first_class', 'second_class', 'trial_done', 'converted', 'member', 'pack_member', 'classpass', 'cold_lead', 'dormant'])
    expect(opts[0].textContent).toBe('New lead')
    cleanup()
    const contact = { id: 'c1', name: 'Pat', location_id: 'l-1', tags: [], studio_stage_slug: 'new_lead' }
    render(<ContactsTable contacts={[contact]} locationId="l-1" crossoverContext={{}} />)
    expect(screen.getAllByText('new lead')[0].className).toContain(statusBadge.new_lead)
  })

  it('unknownSlugUsesStageNameWhenLoaded', async () => {
    mockStages = loaded([CUSTOM])
    const { default: ContactsTable } = await import('./ContactsTable.jsx')
    const { default: PipelineReclassifyTab } = await import('./PipelineReclassifyTab.jsx')
    const contact = { id: 'c1', name: 'Pat', location_id: 'l-1', tags: [], studio_stage_slug: 'vip_intro' }
    render(<ContactsTable contacts={[contact]} locationId="l-1" crossoverContext={{}} />)
    const chip = screen.getAllByText('VIP intro')[0]
    expect(chip.className).toContain('bg-slate-500/10 text-slate-700')
    cleanup()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, movement_matrix: { vip_intro: { new_lead: 2 } }, samples: [] }),
    })))
    render(<PipelineReclassifyTab locationId="l-1" />)
    fireEvent.click(screen.getByRole('button', { name: /preview/i }))
    await waitFor(() => expect(screen.getAllByText('VIP intro').length).toBeGreaterThan(0))
    vi.unstubAllGlobals()
  })

  it('goalPickerOffersStudioStages', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: true,
      json: async () => (String(url).includes('stage-coverage')
        ? { success: true, data: { boards: [{ name: 'VIP board', stages: [{ slug: 'vip_intro', name: 'VIP intro' }, { slug: 'member', name: 'Member' }] }] } }
        : { success: true, segments: [] }),
    })))
    const { default: SequenceSettings } = await import('./sequences/SequenceSettings.jsx')
    const { container, getByText } = render(
      <SequenceSettings sequence={{ id: 'seq-1', location_id: 'loc-1', name: 'X', status: 'draft', goal_config: { type: 'pipeline_stage', value: 'new_lead' } }} />,
    )
    fireEvent.click(getByText('Settings & trigger'))
    await waitFor(() => {
      const values = Array.from(container.querySelectorAll('option')).map((o) => o.value)
      expect(values).toContain('vip_intro')
    })
    const goal = Array.from(container.querySelectorAll('select')).find((sel) => Array.from(sel.options).some((o) => o.value === 'dormant' && sel.options[0].value === 'new_lead'))
    const labels = Array.from(goal.options).map((o) => o.textContent)
    expect(labels.filter((l) => l === 'member')).toHaveLength(1)
    expect(labels).toContain('VIP board · VIP intro')
    vi.unstubAllGlobals()
  })
})
