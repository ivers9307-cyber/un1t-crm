// @vitest-environment jsdom
//
// ROSTER-FIX.6b — the template form is a dialog, its pencil and bin say
// which template they act on, and a backdrop click cannot throw the form away.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

import ShiftTemplateManager from '@/components/ShiftTemplateManager'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

const TEMPLATES = [{
  id: 't1', name: 'Morning', start_time: '09:00', end_time: '12:00',
  color: '#3B82F6', active: true, max_coaches: 3, min_coaches: 1,
  days_of_week: ['mon', 'tue'], role_label: null,
}]

async function renderManager() {
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: TEMPLATES }) }))
  await act(async () => { render(<ShiftTemplateManager user={MANAGER} />) })
}

afterEach(cleanup)

describe('ShiftTemplateManager accessibility (ROSTER-FIX.6b)', () => {
  it('opens the editor as a labelled dialog and returns focus to the pencil', async () => {
    await renderManager()
    const trigger = screen.getByRole('button', { name: 'Edit the Morning template' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toBe('Edit Shift Template')
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('refuses a backdrop click so a half-filled template survives a stray click', async () => {
    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.mouseDown(dialog.parentElement)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('names the row icons after their template', async () => {
    await renderManager()
    expect(screen.getByRole('button', { name: 'Edit the Morning template' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deactivate the Morning template' })).toBeTruthy()
  })

  it('leaves no unnamed button on the page', async () => {
    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    for (const btn of screen.getAllByRole('button')) {
      const name = (btn.getAttribute('aria-label') || btn.textContent || '').trim()
      expect(name.length, btn.outerHTML.slice(0, 160)).toBeGreaterThan(0)
    }
  })
})
