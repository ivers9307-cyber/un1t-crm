// src/components/schedule/RosterToolbar.test.jsx
// @vitest-environment jsdom
//
// ROSTERLOOK.1 — structure, order, names and wiring of the one toolbar row.
// 🔴 NOT proof that it IS one row, or that it wraps sanely at 390px: jsdom has
// no layout engine (memory `jsdom-cannot-see-layout`). The class pins below
// stop the wrapping classes being dropped; the browser task proves the layout.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import RosterToolbar from '@/components/schedule/RosterToolbar'
import { rosterToolbarModel } from '@/lib/roster-card-model'

afterEach(() => cleanup())

function setup(over = {}, modelOver = {}) {
  const handlers = {
    onPrev: vi.fn(), onNext: vi.fn(), onToday: vi.fn(),
    onViewMode: vi.fn(), onViewType: vi.fn(),
    onSelectToggle: vi.fn(), onCopyWeek: vi.fn(), onCopyMonth: vi.fn(), onPublish: vi.fn(),
  }
  const model = rosterToolbarModel({ isManager: true, viewType: 'week', ...modelOver })
  render(
    <RosterToolbar
      viewType="week"
      periodLabel="21 Sep – 27 Sep 2026"
      viewMode="all"
      model={model}
      publishing={false}
      statusChip={<span data-testid="publication-status">Published</span>}
      {...handlers}
      {...over}
    />,
  )
  return handlers
}

describe('RosterToolbar', () => {
  it('two wrapping groups in one wrapping row: navigation first, actions second', () => {
    setup()
    const row = screen.getByTestId('schedule-toolbar')
    const nav = screen.getByTestId('schedule-toolbar-nav')
    const actions = screen.getByTestId('schedule-toolbar-actions')
    expect(Array.from(row.children)).toEqual([nav, actions])
    for (const el of [row, nav, actions]) expect(el.className).toMatch(/\bflex-wrap\b/)
    // The phone menu positions against the actions group.
    expect(actions.className).toMatch(/\brelative\b/)
  })

  it('left group, in order: previous, the period, next, Today, the publish-state chip', () => {
    setup()
    const nav = screen.getByTestId('schedule-toolbar-nav')
    const prev = within(nav).getByRole('button', { name: 'Previous week' })
    const label = within(nav).getByText('21 Sep – 27 Sep 2026')
    const next = within(nav).getByRole('button', { name: 'Next week' })
    const today = within(nav).getByRole('button', { name: 'Today' })
    const chip = within(nav).getByTestId('publication-status')
    const order = [prev, label, next, today, chip]
    for (let i = 0; i < order.length - 1; i++) {
      expect(order[i].compareDocumentPosition(order[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(label.className).toMatch(/whitespace-nowrap/)
    // The chip's SLOT keeps it on one line, whatever element the chip becomes.
    expect(chip.parentElement.className).toMatch(/whitespace-nowrap/)
  })

  it('month view renames the arrows', () => {
    setup({ viewType: 'month', periodLabel: 'September 2026' })
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next month' })).toBeTruthy()
  })

  it('the arrows and Today call straight through', () => {
    const h = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(h.onPrev).toHaveBeenCalledTimes(1)
    expect(h.onNext).toHaveBeenCalledTimes(1)
    expect(h.onToday).toHaveBeenCalledTimes(1)
  })

  it('both toggles say which side is on (aria-pressed), and report the other side', () => {
    const h = setup()
    expect(screen.getByRole('button', { name: 'All staff' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'My shifts' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Week' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'My shifts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    expect(h.onViewMode).toHaveBeenCalledWith('my')
    expect(h.onViewType).toHaveBeenCalledWith('month')
  })

  it('exactly ONE primary button, Publish, and it is the last control in the row', () => {
    const h = setup()
    const actions = screen.getByTestId('schedule-toolbar-actions')
    const publish = screen.getByRole('button', { name: 'Publish' })
    expect(actions.lastElementChild).toBe(publish)
    expect(publish.className).toMatch(/whitespace-nowrap/)
    expect(actions.querySelectorAll('.bg-blue-600')).toHaveLength(1)
    fireEvent.click(publish)
    expect(h.onPublish).toHaveBeenCalledTimes(1)
  })

  it('Publish is disabled and says so while publishing; absent in month view', () => {
    setup({ publishing: true })
    expect(screen.getByRole('button', { name: 'Publishing...' }).disabled).toBe(true)
    cleanup()
    setup({ viewType: 'month' }, { viewType: 'month' })
    expect(screen.queryByRole('button', { name: /^Publish/ })).toBeNull()
  })

  it('the five secondary actions are in More, not on the row, and each reaches its handler', () => {
    const h = setup()
    expect(screen.queryByText('Copy last week')).toBeNull()
    const pick = (role, name) => {
      fireEvent.click(screen.getByRole('button', { name: 'More' }))
      fireEvent.click(screen.getByRole(role, { name }))
    }
    pick('menuitemcheckbox', 'Select multiple')
    pick('menuitem', 'Copy last week')
    pick('menuitem', 'Copy last month')
    expect(h.onSelectToggle).toHaveBeenCalledTimes(1)
    expect(h.onCopyWeek).toHaveBeenCalledTimes(1)
    expect(h.onCopyMonth).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('menuitem', { name: 'Time off' }).getAttribute('href')).toBe('/schedule/time-off')
    expect(screen.getByRole('menuitem', { name: 'Manage templates' }).getAttribute('href')).toBe('/settings/shifts')
  })

  it('a coach: Time off is a plain link on the row; no More, no Publish', () => {
    setup({}, { isManager: false })
    expect(screen.getByRole('link', { name: 'Time off' }).getAttribute('href')).toBe('/schedule/time-off')
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Publish/ })).toBeNull()
  })

  // 🔴 The coach boundary: not "hidden in a closed menu", ABSENT.
  it('a coach: none of the manager actions exist anywhere in the toolbar', () => {
    // No chip either: the calendar builds it for a manager only, and the
    // fixture's "Published" would otherwise answer the Publish match below.
    setup({ statusChip: null }, { isManager: false })
    const row = screen.getByTestId('schedule-toolbar')
    expect(row.querySelector('[aria-haspopup="menu"]')).toBeNull()
    expect(row.textContent).not.toMatch(/Select multiple|Copy last week|Copy last month|Manage templates|Publish/)
    expect(row.querySelector('a[href="/settings/shifts"]')).toBeNull()
  })

  it('renders without a chip (a coach, or a period with nothing to say)', () => {
    setup({ statusChip: null })
    expect(screen.queryByTestId('publication-status')).toBeNull()
  })
})
