// PIPE3.9 — the Funnel / Off funnel row is drawn only when the board has an
// off-funnel pile. The €39 Trial and Programmes boards are derived but have
// no dormant stages (the piles are shared with the acquisition board), so
// their tab offers no second view, like a manual board.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/pipeline',
}))

const { default: PipelineViewSwitcher } = await import('./PipelineViewSwitcher.jsx')
const BOARDS = [{ key: 'acquisition', name: 'Acquisition' }, { key: 'paid_trial', name: '€39 Trial' }]

describe('PipelineViewSwitcher — the view row', () => {
  it('a derived board with dormant stages draws Funnel and Off funnel', () => {
    const html = renderToStaticMarkup(<PipelineViewSwitcher pipelines={BOARDS} activePipelineKey="acquisition" view="active" activeCount={3} dormantCount={9} hasDormant />)
    expect(html).toContain('Off funnel')
    expect(html).toContain('Funnel')
  })
  it('a derived board with NO dormant stages draws the board tabs but no view row', () => {
    const html = renderToStaticMarkup(<PipelineViewSwitcher pipelines={BOARDS} activePipelineKey="paid_trial" view="active" activeCount={3} dormantCount={0} hasDormant={false} />)
    expect(html).toContain('€39 Trial')
    expect(html).not.toContain('Off funnel')
  })
  it('a manual board draws no view row either (unchanged)', () => {
    const html = renderToStaticMarkup(<PipelineViewSwitcher pipelines={BOARDS} activePipelineKey="acquisition" isManual view="active" activeCount={3} dormantCount={0} />)
    expect(html).not.toContain('Off funnel')
  })
  it('hasDormant defaults to true, so every existing caller is unchanged', () => {
    const html = renderToStaticMarkup(<PipelineViewSwitcher pipelines={[]} activePipelineKey="acquisition" view="active" activeCount={1} dormantCount={2} />)
    expect(html).toContain('Off funnel')
  })
})
