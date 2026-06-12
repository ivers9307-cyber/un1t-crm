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

// BRIEFING.2 — the "Studio pulse" performance strip.

import { shapePulseMetrics } from './morning-briefing'

describe('shapePulseMetrics', () => {
  const bundle = {
    counts: {
      monthly_recurring: 191, class_packs: 470, payg: 418,
      total_members: 1079, active_recurring: 180, dead_packs: 120,
    },
    radar: { paused: 9, overdue: 6, overdueValueCents: 124000 },
    prevMembership: {
      snapshot_date: '2026-06-01',
      monthly_recurring: 187, class_packs: 472, payg: 418, total_members: 1075,
    },
    prevChurn: { paused: 6, overdue: 7, captured_at: '2026-05-25T06:00:00Z' },
  }

  it('computes per-metric deltas against the right snapshot', () => {
    const m = Object.fromEntries(shapePulseMetrics(bundle).map((x) => [x.key, x]))
    expect(m.members).toMatchObject({ value: 191, delta: 4, since: '1 Jun' })
    expect(m.members.sub).toContain('180 active')
    expect(m.packs).toMatchObject({ value: 470, delta: -2 })
    expect(m.packs.sub).toContain('350 with credits')
    expect(m.payg).toMatchObject({ value: 418, delta: 0 })
    expect(m.paused).toMatchObject({ value: 9, delta: 3, since: '25 May' })
    expect(m.overdue).toMatchObject({ value: 6, delta: -1 })
    expect(m.overdue.sub).toContain('€1,240')
    expect(m.total).toMatchObject({ value: 1079, delta: 4 })
  })

  it('returns null deltas when a comparator snapshot is missing', () => {
    const m = Object.fromEntries(
      shapePulseMetrics({ ...bundle, prevMembership: null, prevChurn: null })
        .map((x) => [x.key, x]))
    expect(m.members.delta).toBe(null)
    expect(m.members.since).toBe(null)
    expect(m.paused.delta).toBe(null)
  })

  it('returns [] when live counts are unavailable', () => {
    expect(shapePulseMetrics(null)).toEqual([])
    expect(shapePulseMetrics({ counts: null, radar: null })).toEqual([])
  })
})

describe('buildMorningBriefingEmail with a pulse strip', () => {
  const pulse = [
    { key: 'members', label: 'Members (recurring)', value: 191, sub: '180 active subscriptions', delta: 4, since: '1 Jun' },
    { key: 'paused', label: 'Paused', value: 9, delta: -3, since: '25 May' },
    { key: 'payg', label: 'Pay-as-you-go', value: 418, delta: 0, since: '1 Jun' },
  ]

  it('renders the strip above the triage rows with deltas and since-labels', () => {
    const { html } = buildMorningBriefingEmail(ROWS, { ...OPTS, pulse })
    expect(html).toContain('Studio pulse')
    expect(html).toContain('Members (recurring)')
    expect(html).toContain('191')
    expect(html).toContain('▲ 4 since 1 Jun')
    expect(html).toContain('▼ 3 since 25 May')
    expect(html.indexOf('Studio pulse')).toBeLessThan(html.indexOf('Open issues'))
  })

  it('shows a flat marker for zero deltas and skips the chip when delta is null', () => {
    const { html } = buildMorningBriefingEmail([], {
      ...OPTS,
      pulse: [
        { key: 'payg', label: 'Pay-as-you-go', value: 418, delta: 0, since: '1 Jun' },
        { key: 'total', label: 'Total members', value: 1079, delta: null, since: null },
      ],
    })
    expect(html).toContain('— flat since 1 Jun')
    expect(html).not.toContain('since null')
  })

  it('renders no strip when pulse is missing or empty', () => {
    const { html } = buildMorningBriefingEmail(ROWS, OPTS)
    expect(html).not.toContain('Studio pulse')
    const { html: h2 } = buildMorningBriefingEmail(ROWS, { ...OPTS, pulse: [] })
    expect(h2).not.toContain('Studio pulse')
  })

  it('keeps the subject triage-focused (pulse never leaks in)', () => {
    const { subject } = buildMorningBriefingEmail(ROWS, { ...OPTS, pulse })
    expect(subject).not.toContain('191')
    expect(subject).toContain('2 open issues')
  })
})
