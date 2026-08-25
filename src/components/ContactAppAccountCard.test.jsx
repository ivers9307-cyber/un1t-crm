// @vitest-environment jsdom
//
// REPSET-P5 — App account card (admin contact-linking tool).
//
// The card is only rendered for master/owner (the page gates it), so these
// tests pin the flows, not the gate:
//   - linked state renders the SERVER-masked email + Unlink
//   - unlink sends DELETE with the explicit confirm field
//   - link dialog: exact-email search → masked match (+ staff chip for the
//     dual case) → Confirm sends POST { userId, confirm: true }
//   - a search miss offers no Confirm button
//   - server 409 (already linked elsewhere) is surfaced, not swallowed

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ContactAppAccountCard from './ContactAppAccountCard'

const okJson = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) })

function mockFetchRoutes(routes) {
  // routes: array of { match: (url, init) => bool, reply: response-like | fn }
  global.fetch = vi.fn(async (url, init = {}) => {
    for (const r of routes) {
      if (r.match(String(url), init)) return typeof r.reply === 'function' ? r.reply(url, init) : r.reply
    }
    throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`)
  })
}

const stateUnlinked = { linked: false, account: null }
const stateLinked = { linked: true, account: { userId: 'u1', maskedEmail: 'sa•••@example.com', staff: null } }
const stateLinkedStaff = { linked: true, account: { userId: 'u1', maskedEmail: 'sa•••@example.com', staff: { fullName: 'Sarah Byrne', role: 'head_coach' } } }

const isState = (url, init) => url.includes('/api/contacts/c1/link-account') && !url.includes('email=') && (!init.method || init.method === 'GET')

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); delete global.fetch })

describe('ContactAppAccountCard — linked state', () => {
  it('shows the masked email and an Unlink action', async () => {
    mockFetchRoutes([{ match: isState, reply: okJson(stateLinked) }])
    render(<ContactAppAccountCard contactId="c1" contactName="Sarah Byrne" />)
    await waitFor(() => expect(screen.getByText('sa•••@example.com')).toBeTruthy())
    expect(screen.getByRole('button', { name: /unlink/i })).toBeTruthy()
  })

  it('marks the dual case with a Staff chip', async () => {
    mockFetchRoutes([{ match: isState, reply: okJson(stateLinkedStaff) }])
    render(<ContactAppAccountCard contactId="c1" contactName="Sarah Byrne" />)
    await waitFor(() => expect(screen.getByText(/staff/i)).toBeTruthy())
  })

  it('unlink asks for confirmation, then sends DELETE with confirm:true and reloads', async () => {
    let deleted = false
    mockFetchRoutes([
      {
        match: (url, init) => init.method === 'DELETE' && url.includes('/link-account'),
        reply: (url, init) => {
          deleted = true
          expect(JSON.parse(init.body)).toEqual({ confirm: true })
          return okJson({ linked: false })
        },
      },
      { match: (url) => isState(url, {}) || true, reply: () => okJson(deleted ? stateUnlinked : stateLinked) },
    ])
    render(<ContactAppAccountCard contactId="c1" contactName="Sarah Byrne" />)
    await waitFor(() => expect(screen.getByRole('button', { name: /unlink/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /unlink/i }))
    // Confirm dialog — the destructive step is deliberate, never one-click.
    const confirmBtn = await screen.findByRole('button', { name: /^unlink account$/i })
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(deleted).toBe(true))
    await waitFor(() => expect(screen.getByText(/no app account linked/i)).toBeTruthy())
  })
})

describe('ContactAppAccountCard — link flow', () => {
  const searchHit = { found: true, userId: 'u1', maskedEmail: 'sa•••@example.com', staff: null }
  const searchStaffHit = { ...searchHit, staff: { fullName: 'Sarah Byrne', role: 'head_coach' } }
  const searchMiss = { found: false }

  async function openDialogAndSearch(searchReply, postReply = null) {
    const calls = { post: null }
    mockFetchRoutes([
      {
        match: (url, init) => init.method === 'POST' && url.includes('/link-account'),
        reply: (url, init) => {
          calls.post = JSON.parse(init.body)
          return postReply || okJson(stateLinked)
        },
      },
      { match: (url) => url.includes('email='), reply: okJson({ ...stateUnlinked, search: searchReply }) },
      { match: () => true, reply: okJson(stateUnlinked) },
    ])
    render(<ContactAppAccountCard contactId="c1" contactName="Sarah Byrne" />)
    await waitFor(() => expect(screen.getByRole('button', { name: /link app account/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /link app account/i }))
    const input = await screen.findByPlaceholderText(/email/i)
    fireEvent.change(input, { target: { value: 'sarah@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /find/i }))
    return calls
  }

  it('search hit shows the masked match and Confirm sends POST { userId, confirm: true }', async () => {
    const calls = await openDialogAndSearch(searchHit)
    await waitFor(() => expect(screen.getByText('sa•••@example.com')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /confirm link/i }))
    await waitFor(() => expect(calls.post).toEqual({ userId: 'u1', confirm: true }))
  })

  it('search hit on a staff auth user shows the Staff chip (the whole point of the tool)', async () => {
    await openDialogAndSearch(searchStaffHit)
    await waitFor(() => expect(screen.getByText(/staff/i)).toBeTruthy())
  })

  it('search miss shows "no app account" and offers NO confirm button (never creates users)', async () => {
    await openDialogAndSearch(searchMiss)
    await waitFor(() => expect(screen.getByText(/no app account/i)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /confirm link/i })).toBeNull()
  })

  it('surfaces a server 409 instead of swallowing it', async () => {
    const conflict = {
      ok: false,
      status: 409,
      json: async () => ({ success: false, error: 'This app account is already linked to another contact' }),
    }
    await openDialogAndSearch(searchHit, conflict)
    await waitFor(() => expect(screen.getByText('sa•••@example.com')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /confirm link/i }))
    await waitFor(() => expect(screen.getByText(/already linked to another contact/i)).toBeTruthy())
  })
})
