// RUNWAY.1 — the chip's contract: nothing when ready, the right week in the
// link, and the severity visible in the markup. Rendered to static markup in
// the node environment (no jsdom), like KanbanBoard.test.jsx.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }) => <a href={typeof href === 'string' ? href : '#'} {...rest}>{children}</a>,
}))

import RosterRunwayChip from './RosterRunwayChip'

const RUNWAY = {
  weekStart: '2026-09-28', daysAway: 9, severity: 'amber',
  blocks: 34, staffed: 0, underMin: 0, published: 0, unstaffed: 34, unpublished: 34,
}

describe('RosterRunwayChip', () => {
  it('renders nothing when the studio is ready', () => {
    expect(renderToStaticMarkup(<RosterRunwayChip runway={null} />)).toBe('')
  })

  it('links to THAT week on the manager calendar and says what is missing', () => {
    const html = renderToStaticMarkup(<RosterRunwayChip runway={RUNWAY} locationName="Studio North" />)
    expect(html).toContain('href="/schedule?view=week&amp;week=2026-09-28"')
    expect(html).toContain('Studio North: week of 28 Sep is not ready')
    expect(html).toContain('Starts in 9 days: 34 of 34 shifts have no coach, not published.')
    expect(html).toContain('data-severity="amber"')
    expect(html).toContain('text-amber-700')
    expect(html).not.toContain('text-red-700')
  })

  it('is red inside five days, and drops the studio name when there is only one', () => {
    const html = renderToStaticMarkup(<RosterRunwayChip runway={{ ...RUNWAY, daysAway: 4, severity: 'red' }} />)
    expect(html).toContain('data-severity="red"')
    expect(html).toContain('text-red-700')
    expect(html).toContain('Week of 28 Sep is not ready')
  })
})
