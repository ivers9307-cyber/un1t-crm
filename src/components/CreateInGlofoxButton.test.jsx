// @vitest-environment jsdom
//
// PASSCODEREAD.1 — the manual "Create in Glofox" button is the ONLY place a
// new member's initial Glofox password is ever shown: once, to the staff
// member who pressed it. It used to say the password "will be emailed via the
// welcome sequence", which was never true (no welcome sequence was switched
// on) and is now impossible (passwords are not stored, mig 651).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import CreateInGlofoxButton from './CreateInGlofoxButton'

const CONTACT = { id: 'c-1', first_name: 'Synth', last_name: 'Member', email: 'synth@example.test' }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubCreate(result) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, result }) })))
}

describe('CreateInGlofoxButton — the one-time password (PASSCODEREAD.1)', () => {
  it('shows the password once and says it is not saved or emailed', async () => {
    stubCreate({ status: 'created', glofox_member_id: 'gx-1', passcode: 'SYNTH-PC-1' })
    render(<CreateInGlofoxButton contact={CONTACT} />)
    fireEvent.click(screen.getByRole('button'))
    const msg = await screen.findByText(/SYNTH-PC-1/)
    expect(msg.textContent).toMatch(/not saved/i)
    expect(msg.textContent).toMatch(/nothing emails it/i)
    expect(msg.textContent).not.toMatch(/welcome sequence/i)
  })

  it('says plainly "Created in Glofox." when no password came back', async () => {
    stubCreate({ status: 'created', glofox_member_id: 'gx-1' })
    render(<CreateInGlofoxButton contact={CONTACT} />)
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText('Created in Glofox.')).toBeTruthy()
  })
})

// GLOFOXWRITEJUDGE.1 — Glofox refused the new account because the email already
// has one, and the push could not link it. Nothing was created, so the old
// "Partial success, operator review required." was wrong.
describe('CreateInGlofoxButton — email already has a Glofox account (GLOFOXWRITEJUDGE.1)', () => {
  it('not linked: says nothing was created and where to look', async () => {
    stubCreate({ status: 'needs_review', reason: 'email_in_use_not_linked', error: 'Glofox says this email already has an account, but the search cannot see it.' })
    render(<CreateInGlofoxButton contact={CONTACT} />)
    fireEvent.click(screen.getByRole('button'))
    const msg = await screen.findByText(/^Not created:/)
    expect(msg.textContent).toBe('Not created: this email already has a Glofox account we could not match. Check the Review tab.')
    expect(msg.textContent).not.toMatch(/Partial success/)
    expect(msg.textContent).not.toMatch(/—/)
  })

  it('found but the link could not be saved: says so, nothing created', async () => {
    stubCreate({ status: 'needs_review', reason: 'email_in_use_link_failed', glofox_member_id: 'gx-old', error: 'x' })
    render(<CreateInGlofoxButton contact={CONTACT} />)
    fireEvent.click(screen.getByRole('button'))
    const msg = await screen.findByText(/^Not created:/)
    expect(msg.textContent).toBe('Not created: this email already has a Glofox account, but saving the link to it failed. Check the Review tab.')
    expect(msg.textContent).not.toMatch(/—/)
  })

  it('any other needs_review keeps its wording (unchanged)', async () => {
    stubCreate({ status: 'needs_review', error: 'Trial membership purchase failed: X' })
    render(<CreateInGlofoxButton contact={CONTACT} />)
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText(/^Partial success, operator review required\. Trial membership purchase failed: X$/)).toBeTruthy()
  })
})
