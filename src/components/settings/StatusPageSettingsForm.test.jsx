// @vitest-environment jsdom
//
// SETTINGSWIPE.1 — on a failed GET this form rendered the EMPTY form with Save
// and "Reset to defaults" enabled (the error line under it). Save then dropped
// the saved copy. Now: Could not load + Try again, no form, no Save/Reset.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import StatusPageSettingsForm from './StatusPageSettingsForm.jsx'

const NOTE = 'Could not load the status page copy just now, so nothing is shown and nothing can be changed here until it loads.'
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
function mockFetch(...answers) {
  let i = 0
  global.fetch = vi.fn(async () => {
    const a = answers[Math.min(i++, answers.length - 1)]
    if (a instanceof Error) throw a
    return a
  })
}
afterEach(() => { cleanup(); delete global.fetch })

describe('StatusPageSettingsForm — a failed read (SETTINGSWIPE.1)', () => {
  it('shows Could not load, no Save and no Reset', async () => {
    mockFetch(reply(500, { success: false, code: 'settings_unreadable' }))
    render(<StatusPageSettingsForm />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset to defaults' })).toBeNull()
  })

  it('Try again with a good read shows the form', async () => {
    mockFetch(new TypeError('Failed to fetch'), reply(200, { success: true, overrides: {}, defaults: {}, publicPath: null }))
    render(<StatusPageSettingsForm />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy())
  })
})
