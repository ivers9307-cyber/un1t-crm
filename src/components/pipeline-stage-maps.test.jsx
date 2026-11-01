// PIPE3.9 — every stage the two Stillorgan claim boards declare has a colour,
// a label and a chip wherever a slug is shown, so a new slug never renders as
// a raw string or a grey dot.
import { describe, it, expect, vi } from 'vitest'
import { getBoardModule } from '@shared/pipelines/index.js'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/pipeline',
}))
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
