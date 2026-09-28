// @vitest-environment jsdom
//
// PASSCODEREAD.1 — the one-time Glofox password must survive the refresh that
// follows a desk create. The Create-in-Glofox button lives inside the card's
// "not linked" branch; the moment the refresh lands the contact has a
// glofox_member_id, the card switches to its linked branch and the button
// unmounts. The password was held in the button, so it vanished about a
// second after it appeared, and it is stored nowhere (mig 651). These tests
// drive the REAL card through that re-render.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import GlofoxProfileCard from './GlofoxProfileCard'

const UNLINKED = {
  id: 'c-1',
  first_name: 'Synth',
  last_name: 'Member',
  email: 'synth@example.test',
  glofox_member_id: null,
}
const LINKED = { ...UNLINKED, glofox_member_id: 'gx-new', glofox_membership_status: 'trial' }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  refresh.mockReset()
})

function stubCreate(result) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, result }) })))
}

describe('GlofoxProfileCard — the one-time password outlives the refresh (PASSCODEREAD.1)', () => {
  it('keeps the password on screen after the card re-renders linked, until it is dismissed', async () => {
    stubCreate({ status: 'created', glofox_member_id: 'gx-new', passcode: 'SYNTH-PC-1' })
    const { rerender } = render(<GlofoxProfileCard contact={UNLINKED} />)
    fireEvent.click(screen.getByRole('button', { name: /create in glofox/i }))
    await screen.findByText(/SYNTH-PC-1/)
    expect(refresh).toHaveBeenCalled()

    // The refresh lands: same card, now linked. The button is gone.
    rerender(<GlofoxProfileCard contact={LINKED} />)
    expect(screen.queryByRole('button', { name: /create in glofox/i })).toBeNull()
    expect(screen.getByText(/ID: gx-new/)).toBeTruthy()
    const msg = screen.getByText(/SYNTH-PC-1/)
    expect(msg.textContent).toMatch(/not saved/i)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByText(/SYNTH-PC-1/)).toBeNull()
  })

  it('shows the password on needs_review too (member created, trial not attached)', async () => {
    stubCreate({
      status: 'needs_review',
      glofox_member_id: 'gx-new',
      passcode: 'SYNTH-PC-2',
      error: 'Trial membership purchase failed: synthetic',
    })
    const { rerender } = render(<GlofoxProfileCard contact={UNLINKED} />)
    fireEvent.click(screen.getByRole('button', { name: /create in glofox/i }))
    const msg = await screen.findByText(/SYNTH-PC-2/)
    expect(msg.textContent).toMatch(/Trial membership purchase failed: synthetic/)
    expect(msg.textContent).toMatch(/not saved/i)
    expect(msg.textContent).not.toMatch(/—/)

    rerender(<GlofoxProfileCard contact={LINKED} />)
    expect(screen.getByText(/SYNTH-PC-2/)).toBeTruthy()
  })
})
