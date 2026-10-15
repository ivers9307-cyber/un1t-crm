// @vitest-environment jsdom
//
// TVSCENE.1 — the idle stage renders ONE scene, chosen by elapsed time, and
// consumes the scene rules from @/lib/tv-scenes rather than restating them.
// The operator cases below are the ones that drifted in Task 1 (a blank 30s
// stage, the same blank for template rows, `<img src="   ">` beside a real
// label), so each is pinned here against what the component actually draws.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { SCENE_DWELL_MS } from '@/lib/tv-scenes'
import IdleStage from './IdleStage.jsx'

const fonts = { display: 'sans-serif', body: 'sans-serif', mono: 'monospace' }
const idle = {
  up_next: [{ starts_at: '2026-10-16T05:00:00Z', starts_at_label: '06:00', class_name: 'BU1LD — Strength', program: 'BU1LD' }],
  earned: [{ display_name: 'Saoirse M.', achievement: '50 classes', tier: 4, earned_at: '2026-10-15T18:00:00Z' }],
  operator: null,
}

afterEach(cleanup)

const at = (ms, over = {}) => render(
  <IdleStage idle={{ ...idle, ...over }} nowMs={1000 + ms} idleSinceMs={1000} fonts={fonts} />,
)

describe('IdleStage', () => {
  it('shows Up next first', () => {
    at(0)
    expect(screen.getByText('06:00')).toBeTruthy()
    expect(screen.getByText('BU1LD — Strength')).toBeTruthy()
  })

  it('advances to Earned after one dwell', () => {
    at(SCENE_DWELL_MS)
    expect(screen.getByText('Saoirse M.')).toBeTruthy()
    expect(screen.getByText('50 classes')).toBeTruthy()
  })

  it('wraps back to Up next after the last eligible scene', () => {
    at(SCENE_DWELL_MS * 2)
    expect(screen.getByText('06:00')).toBeTruthy()
  })

  it('renders null when nothing is eligible, so the caller can fall back', () => {
    const { container } = render(
      <IdleStage idle={{ up_next: [], earned: [], operator: null }} nowMs={1000} idleSinceMs={1000} fonts={fonts} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders null when the payload has no idle block at all', () => {
    const { container } = render(<IdleStage idle={undefined} nowMs={1000} idleSinceMs={1000} fonts={fonts} />)
    expect(container.firstChild).toBeNull()
  })

  // The three-scene order, with the operator card last.
  it('rotates Up next, Earned, then the operator card, skipping a scene with nothing', () => {
    const operator = { source_type: 'template', source_ref: null, label: 'Open day Saturday', template_values: null }
    const full = { ...idle, operator }
    const { rerender } = render(<IdleStage idle={full} nowMs={1000} idleSinceMs={1000} fonts={fonts} />)
    expect(screen.getByText('06:00')).toBeTruthy()

    rerender(<IdleStage idle={full} nowMs={1000 + SCENE_DWELL_MS} idleSinceMs={1000} fonts={fonts} />)
    expect(screen.getByText('Saoirse M.')).toBeTruthy()

    rerender(<IdleStage idle={full} nowMs={1000 + SCENE_DWELL_MS * 2} idleSinceMs={1000} fonts={fonts} />)
    expect(screen.getByText('Open day Saturday')).toBeTruthy()

    // Earned empty: the operator card takes the second slot, nothing blank between.
    const noEarned = { ...full, earned: [] }
    rerender(<IdleStage idle={noEarned} nowMs={1000 + SCENE_DWELL_MS} idleSinceMs={1000} fonts={fonts} />)
    expect(screen.getByText('Open day Saturday')).toBeTruthy()
  })

  // No timer in the rotation: the scene is a function of nowMs, so a later
  // render alone moves it and mounting it schedules nothing.
  it('schedules no timer of its own', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<IdleStage idle={idle} nowMs={1000} idleSinceMs={1000} fonts={fonts} />)
      rerender(<IdleStage idle={idle} nowMs={1000 + SCENE_DWELL_MS} idleSinceMs={1000} fonts={fonts} />)
      expect(screen.getByText('Saoirse M.')).toBeTruthy()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // Constraint 1 — no aggregate studio metrics anywhere on screen.
  it('never renders a count of achievements', () => {
    // Names and achievements carry no digit of their own, so ANY digit on the
    // scene would be a count (5 rows, "5 earned", a total).
    const many = ['Aoife', 'Brian', 'Ciara', 'Dara', 'Eoin'].map((n) => ({
      display_name: `${n} X.`, achievement: 'First class', tier: 1, earned_at: '2026-10-15T18:00:00Z',
    }))
    const { container } = render(
      <IdleStage idle={{ up_next: [], earned: many, operator: null }} nowMs={1000} idleSinceMs={1000} fonts={fonts} />,
    )
    expect(container.textContent).not.toMatch(/\d/)
    expect(container.textContent).not.toMatch(/this month|in total|members|total/i)
  })

  // Constraint: time and name only — never capacity.
  it('never renders capacity or headcount on Up next', () => {
    const { container } = render(
      <IdleStage idle={{ ...idle, earned: [] }} nowMs={1000} idleSinceMs={1000} fonts={fonts} />,
    )
    expect(container.textContent).not.toMatch(/spaces|places|booked|\bfull\b|\d+\s*\/\s*\d+/i)
  })

  it('draws time and name only, even if a row carries capacity fields', () => {
    const row = { ...idle.up_next[0], capacity: 14, booked: 11, spots_left: 3, waitlist: 2 }
    const { container } = render(
      <IdleStage idle={{ up_next: [row], earned: [], operator: null }} nowMs={1000} idleSinceMs={1000} fonts={fonts} />,
    )
    expect(container.textContent).toBe('Up next06:00BU1LD — Strength')
  })
})

// The operator card. IdleStage branches on operatorImageRef and the shared
// label rule; it never looks at source_type or source_ref itself.
describe('IdleStage operator scene', () => {
  const IMG = 'https://proj.supabase.co/storage/v1/object/public/tv-content/offer.png'
  const onlyOperator = (operator) => render(
    <IdleStage idle={{ up_next: [], earned: [], operator }} nowMs={1000} idleSinceMs={1000} fonts={fonts} />,
  )

  it.each(['storage', 'url'])('draws a %s image with exactly the string it was handed', (source_type) => {
    const { container } = onlyOperator({ source_type, source_ref: IMG, label: 'Spring offer', template_values: null })
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe(IMG)
    expect(img.getAttribute('alt')).toBe('Spring offer')
  })

  it('never puts surrounding whitespace in src', () => {
    const { container } = onlyOperator({ source_type: 'storage', source_ref: `   ${IMG}  `, label: null, template_values: null })
    expect(container.querySelector('img').getAttribute('src')).toBe(IMG)
  })

  it('draws the label, not <img src="   ">, when a whitespace ref sits beside a real label', () => {
    const { container } = onlyOperator({ source_type: 'storage', source_ref: '   ', label: 'Open day Saturday', template_values: null })
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('Open day Saturday')).toBeTruthy()
  })

  it('draws a template row as its label only, whatever its ref looks like', () => {
    const { container } = onlyOperator({ source_type: 'template', source_ref: IMG, label: 'Bank holiday hours', template_values: {} })
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('Bank holiday hours')).toBeTruthy()
  })

  it('treats a whitespace-only label as no label: an image still draws, with empty alt', () => {
    const { container } = onlyOperator({ source_type: 'url', source_ref: IMG, label: '   ', template_values: null })
    const img = container.querySelector('img')
    expect(img.getAttribute('src')).toBe(IMG)
    expect(img.getAttribute('alt')).toBe('')
  })

  it.each([
    ['a whitespace label on a template row', { source_type: 'template', source_ref: null, label: '   ', template_values: null }],
    ['template_values alone', { source_type: 'template', source_ref: null, label: null, template_values: { a: 1 } }],
    ['a whitespace ref and a whitespace label', { source_type: 'storage', source_ref: '   ', label: '   ', template_values: null }],
  ])('draws nothing, and so yields to the caller, for %s', (_name, operator) => {
    const { container } = onlyOperator(operator)
    expect(container.firstChild).toBeNull()
  })
})
