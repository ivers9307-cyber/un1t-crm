// @vitest-environment jsdom
//
// EMAIL-CONTACT-CHIP — Task 1 (membership-stage chip beside the sender) and
// Task 2 ("Add to contacts" on an unlinked thread).
//
// jsdom has no layout engine: these assert STRUCTURE (text content, element
// presence, the class recipe as a string) — never pixels or actual rendered
// colour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import ConversationThread from './ConversationThread.jsx'

function fetchMock(linkContactImpl) {
  return vi.fn((url, opts) => {
    if (typeof url === 'string' && url.includes('/link-contact')) {
      return linkContactImpl(url, opts)
    }
    // Any incidental fetch this pane makes on mount — never resolves, same
    // idiom as the composer-reset suite: nothing under test here depends on
    // one settling. (It used to catch the signature hint's own
    // /api/me/preferences; MAIL-READER.1 removed that hint from every
    // composer, so the composer no longer asks for anything on mount.)
    return new Promise(() => {})
  })
}

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const noop = () => {}

function threadProps(conversation) {
  return {
    hasSelection: true,
    conversation,
    messages: [],
    replyRecipients: null,
    loading: false,
    error: null,
    currentUserId: 'staff-1',
    onBack: noop,
    onStatusChange: noop,
    statusSaving: false,
    onSend: noop,
    sending: false,
  }
}

const BASE_TICKET = { id: 'conversation-a', subject: 'Membership freeze', requester_email: 'alice@example.com', status: 'open' }

describe('ConversationThread — membership-stage chip', () => {
  it('renders the human label, never the raw slug', () => {
    vi.stubGlobal('fetch', fetchMock(() => new Promise(() => {})))
    const conversation = { ...BASE_TICKET, contact: { id: 'c1', name: 'Alice', first_name: 'Alice', email: 'alice@example.com', pipeline_stage_slug: 'new_lead' } }
    render(<ConversationThread {...threadProps(conversation)} />)

    expect(screen.getByText('New Lead')).toBeTruthy()
    // The raw slug must never appear anywhere on the page.
    expect(screen.queryByText('new_lead')).toBeNull()
  })

  it('renders no chip when pipeline_stage_slug is null', () => {
    vi.stubGlobal('fetch', fetchMock(() => new Promise(() => {})))
    const conversation = { ...BASE_TICKET, contact: { id: 'c1', name: 'Alice', first_name: 'Alice', email: 'alice@example.com', pipeline_stage_slug: null } }
    const { container } = render(<ConversationThread {...threadProps(conversation)} />)

    expect(screen.getByRole('link', { name: 'View contact' })).toBeTruthy()
    // No stray chip for a stage that isn't there — scoped to the chip's own
    // three colour recipes rather than to page text, since the subject line
    // itself ("Membership freeze") would otherwise false-positive a bare
    // word search.
    expect(container.querySelector('.bg-emerald-500\\/10, .bg-amber-500\\/10, .bg-gray-500\\/10')).toBeNull()
  })

  it('picks the member-ish colour recipe for a member-ish slug', () => {
    vi.stubGlobal('fetch', fetchMock(() => new Promise(() => {})))
    const conversation = { ...BASE_TICKET, contact: { id: 'c1', name: 'Alice', pipeline_stage_slug: 'member' } }
    render(<ConversationThread {...threadProps(conversation)} />)
    const chip = screen.getByText('Member')
    expect(chip.className).toContain('bg-emerald-500/10')
    expect(chip.className).toContain('text-emerald-700')
  })

  it('picks the lead-ish colour recipe for a lead-ish slug', () => {
    vi.stubGlobal('fetch', fetchMock(() => new Promise(() => {})))
    const conversation = { ...BASE_TICKET, contact: { id: 'c1', name: 'Alice', pipeline_stage_slug: 'trial_done' } }
    render(<ConversationThread {...threadProps(conversation)} />)
    const chip = screen.getByText('Trial Done')
    expect(chip.className).toContain('bg-amber-500/10')
    expect(chip.className).toContain('text-amber-700')
  })

  it('picks the neutral colour recipe for a cold/dormant slug', () => {
    vi.stubGlobal('fetch', fetchMock(() => new Promise(() => {})))
    const conversation = { ...BASE_TICKET, contact: { id: 'c1', name: 'Alice', pipeline_stage_slug: 'dormant' } }
    render(<ConversationThread {...threadProps(conversation)} />)
    const chip = screen.getByText('Dormant')
    expect(chip.className).toContain('bg-gray-500/10')
    expect(chip.className).toContain('text-gray-700')
  })

  // 🔴 Recorded trap: glofox_membership_status is never 'active' in prod.
  // The chip must read pipeline_stage_slug, and must not even glance at a
  // glofox_membership_status sitting on the same contact.
  it('never reads glofox_membership_status', () => {
    vi.stubGlobal('fetch', fetchMock(() => new Promise(() => {})))
    const conversation = { ...BASE_TICKET, contact: { id: 'c1', name: 'Alice', pipeline_stage_slug: null, glofox_membership_status: 'active' } }
    render(<ConversationThread {...threadProps(conversation)} />)
    expect(screen.queryByText(/active/i)).toBeNull()
  })
})

describe('ConversationThread — Add to contacts', () => {
  it('shows the button only when unlinked AND requester_email is present', () => {
    vi.stubGlobal('fetch', fetchMock(() => new Promise(() => {})))
    render(<ConversationThread {...threadProps({ ...BASE_TICKET, contact: null, requester_email: 'alice@example.com' })} />)
    expect(screen.getByRole('button', { name: 'Add to contacts' })).toBeTruthy()
  })

  it('falls back to the plain "not linked" text when there is no requester_email', () => {
    vi.stubGlobal('fetch', fetchMock(() => new Promise(() => {})))
    render(<ConversationThread {...threadProps({ ...BASE_TICKET, contact: null, requester_email: null })} />)
    expect(screen.queryByRole('button', { name: 'Add to contacts' })).toBeNull()
    expect(screen.getByText('Not linked to a contact')).toBeTruthy()
  })

  it('does not show the button once a contact is already linked', () => {
    vi.stubGlobal('fetch', fetchMock(() => new Promise(() => {})))
    const conversation = { ...BASE_TICKET, contact: { id: 'c1', name: 'Alice', pipeline_stage_slug: null } }
    render(<ConversationThread {...threadProps(conversation)} />)
    expect(screen.queryByRole('button', { name: 'Add to contacts' })).toBeNull()
  })

  it('POSTs to the link-contact route and swaps to View contact + chip, without a full reload', async () => {
    const post = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: { contact: { id: 'new-contact-1', name: 'Alice', first_name: 'Alice', email: 'alice@example.com', pipeline_stage_slug: 'new_lead' } },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock(post))

    render(<ConversationThread {...threadProps({ ...BASE_TICKET, contact: null, requester_email: 'alice@example.com' })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add to contacts' }))

    expect(post).toHaveBeenCalledWith(
      '/api/email/mail/conversation-a/link-contact',
      expect.objectContaining({ method: 'POST' })
    )

    await waitFor(() => expect(screen.getByRole('link', { name: 'View contact' })).toBeTruthy())
    expect(screen.getByRole('link', { name: 'View contact' }).getAttribute('href')).toBe('/contacts/new-contact-1')
    expect(screen.getByText('New Lead')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add to contacts' })).toBeNull()
  })

  it('shows an inline error and leaves the button in place when the route refuses', async () => {
    const post = vi.fn(() => Promise.resolve({
      ok: false,
      json: () => Promise.resolve({ success: false, error: 'Could not link a contact. Nothing was changed — try again.' }),
    }))
    vi.stubGlobal('fetch', fetchMock(post))

    render(<ConversationThread {...threadProps({ ...BASE_TICKET, contact: null, requester_email: 'alice@example.com' })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add to contacts' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toContain('Could not link a contact')
    expect(screen.getByRole('button', { name: 'Add to contacts' })).toBeTruthy()
  })

  it('resets the local link state when the operator switches conversations', async () => {
    const post = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: { contact: { id: 'new-contact-1', name: 'Alice', pipeline_stage_slug: 'new_lead' } },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock(post))

    const TICKET_A = { ...BASE_TICKET, id: 'conversation-a', contact: null, requester_email: 'alice@example.com' }
    const TICKET_B = { id: 'conversation-b', subject: 'Billing question', requester_email: 'bob@example.com', status: 'open', contact: null }

    const { rerender } = render(<ConversationThread {...threadProps(TICKET_A)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add to contacts' }))
    await waitFor(() => expect(screen.getByRole('link', { name: 'View contact' })).toBeTruthy())

    // Switching to a DIFFERENT, still-unlinked conversation must not carry conversation
    // A's just-linked contact onto conversation B's header.
    rerender(<ConversationThread {...threadProps(TICKET_B)} />)
    expect(screen.queryByRole('link', { name: 'View contact' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add to contacts' })).toBeTruthy()
  })
})
