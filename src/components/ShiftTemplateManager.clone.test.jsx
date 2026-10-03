// @vitest-environment jsdom
//
// TPLCLONE.1 — the template manager offers "Copy from another studio" only
// where the route would allow it (same organisation, a manager at both), and
// reports what the copy did.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'

import ShiftTemplateManager from '@/components/ShiftTemplateManager'

const STUDIO_A = { id: 'studio-a', name: 'Studio A', organization_id: 'org-1' }
const STUDIO_B = { id: 'studio-b', name: 'Studio B', organization_id: 'org-1' }
const STUDIO_X = { id: 'studio-x', name: 'Studio X', organization_id: 'org-2' }
const user = (locations, rolesByLocation) => ({
  id: 'u1', role: 'manager', profileRole: 'staff', activeLocation: STUDIO_B, locations, rolesByLocation,
})
const MANAGES_BOTH = user([STUDIO_A, STUDIO_B], { 'studio-a': 'manager', 'studio-b': 'manager' })

const COPIED = {
  id: 'new-1', name: 'Early', start_time: '06:00:00', end_time: '09:00:00', color: '#10B981',
  active: true, max_coaches: 4, min_coaches: 2, days_of_week: [], role_label: null, display_order: 0,
}

function mockApi({ copied = false } = {}) {
  let templates = []
  global.fetch = vi.fn(async (url, opts) => {
    if (String(url).startsWith('/api/schedule/templates/clone')) {
      const body = JSON.parse(opts.body)
      if (body.dry_run) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { dry_run: true, created: [{ source_id: 'src-1', name: 'Early', start_time: '06:00:00', end_time: '09:00:00', days_of_week: [], source_days_of_week: ['mon'] }], skipped: [], generated_blocks: 0 } }) }
      }
      templates = [COPIED]
      return { ok: true, status: 201, json: async () => ({ success: true, data: { dry_run: false, created: [{ id: 'new-1', source_id: 'src-1', name: 'Early', start_time: '06:00:00', end_time: '09:00:00', days_of_week: [], source_days_of_week: ['mon'] }], skipped: [], generated_blocks: 0 } }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: copied ? [COPIED] : templates }) }
  })
}

async function renderFor(u) {
  await act(async () => { render(<ShiftTemplateManager user={u} />) })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ShiftTemplateManager — copy from another studio (TPLCLONE.1)', () => {
  it('offers it to a manager of a sibling studio, in the header and on the empty state', async () => {
    mockApi()
    await renderFor(MANAGES_BOTH)
    expect(screen.getAllByRole('button', { name: 'Copy from another studio' })).toHaveLength(2)
  })

  it('does not offer a studio in another organisation', async () => {
    mockApi()
    await renderFor(user([STUDIO_X, STUDIO_B], { 'studio-x': 'owner', 'studio-b': 'manager' }))
    expect(screen.queryByRole('button', { name: 'Copy from another studio' })).toBeNull()
  })

  it('does not offer a sibling where the caller is only staff', async () => {
    mockApi()
    await renderFor(user([STUDIO_A, STUDIO_B], { 'studio-a': 'staff', 'studio-b': 'manager' }))
    expect(screen.queryByRole('button', { name: 'Copy from another studio' })).toBeNull()
  })

  it('copies, re-reads the list and says what it did', async () => {
    mockApi()
    await renderFor(MANAGES_BOTH)
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy from another studio' })[0])
    await screen.findByRole('button', { name: 'Copy 1 template' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy 1 template' })) })
    await waitFor(() => expect(screen.getByTestId('template-notice').textContent)
      .toBe('Copied 1 template from Studio A.'))
    expect(screen.queryByRole('dialog')).toBeNull()
    // The list was read again and now shows the copy.
    expect(global.fetch.mock.calls.filter(([u]) => String(u).startsWith('/api/schedule/templates?')).length).toBe(2)
    expect(screen.getByText('Early')).toBeTruthy()
    // Weekdays stay behind unless the manager ticks the box.
    const copyBody = global.fetch.mock.calls
      .filter(([u]) => String(u).startsWith('/api/schedule/templates/clone'))
      .map(([, o]) => JSON.parse(o.body))
      .find((b) => !b.dry_run)
    expect(copyBody).toMatchObject({ template_ids: ['src-1'], copy_weekdays: false })
  })
})
