// BRIEFING.1 — tests for the morning-briefing email renderer. Pure:
// (feed rows from shared/today-feed.js, opts) → { subject, html }.
// The cron fetches + assembles; this just renders, mirroring the
// churn-radar-digest.js convention.

import { describe, it, expect } from 'vitest'
import { buildMorningBriefingEmail } from './morning-briefing'

const OPTS = {
  locationName: 'UN1T Stillorgan',
  dateLabel: 'Friday 12 June',
  appUrl: 'https://crm.un1tdublin.com',
}

const ROWS = [
  { id: 'issues', label: 'Open issues', count: 2, href: '/issues' },
  {
    id: 'churn', label: 'High-risk members', count: 4,
    detail: '▲ 2 since last snapshot',
    items: [{ label: 'Mark D' }, { label: 'Aoife L' }],
    href: '/dashboard/churn-radar',
  },
  {
    id: 'lowfill', label: 'Low-fill classes today', count: 1,
    items: [{ label: 'UN1T Strength', sublabel: '18:00 · 4/16 booked' }],
    href: '/communications/inbox',
  },
]

describe('buildMorningBriefingEmail', () => {
  it('summarises the top rows in the subject', () => {
    const { subject } = buildMorningBriefingEmail(ROWS, OPTS)
    expect(subject).toContain('UN1T Stillorgan')
    expect(subject).toContain('2 open issues')
    expect(subject).toContain('4 high-risk members')
  })

  it('renders every row with count, detail, items, and an absolute link', () => {
    const { html } = buildMorningBriefingEmail(ROWS, OPTS)
    expect(html).toContain('Open issues')
    expect(html).toContain('▲ 2 since last snapshot')
    expect(html).toContain('Mark D')
    expect(html).toContain('18:00 · 4/16 booked')
    expect(html).toContain('https://crm.un1tdublin.com/issues')
    expect(html).toContain('https://crm.un1tdublin.com/dashboard/churn-radar')
    expect(html).toContain('Friday 12 June')
  })

  it('sends an explicit all-clear when nothing needs attention', () => {
    const { subject, html } = buildMorningBriefingEmail([], OPTS)
    expect(subject.toLowerCase()).toContain('all clear')
    expect(html.toLowerCase()).toContain('nothing needs attention')
  })

  it('escapes HTML in user-derived strings', () => {
    const rows = [{
      id: 'tasks', label: 'Tasks due', count: 1,
      items: [{ label: 'Call <script>alert(1)</script> Bob' }],
      href: '/activities',
    }]
    const { html } = buildMorningBriefingEmail(rows, OPTS)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('caps the subject at the first two rows', () => {
    const { subject } = buildMorningBriefingEmail(ROWS, OPTS)
    expect(subject).not.toContain('Low-fill')
  })
})
