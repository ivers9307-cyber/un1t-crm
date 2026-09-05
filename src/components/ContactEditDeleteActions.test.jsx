// @vitest-environment jsdom
//
// IMPACTCAT.1 — the delete dialog must not contradict itself.
//
// The impact preview can now say "some dependent records could not be counted"
// (partial), and it separately says "No dependent rows. Safe to delete." when
// total_rows is 0. Both were reachable at once: until migration 538 is applied
// every preview falls back to the 21 hand-listed pairs and sets partial, so a
// contact with nothing in THOSE tables rendered the caution directly above an
// assertion that deleting is safe — while ~60 other tables had gone uncounted.
//
// "Safe to delete" is an assertion and needs a complete count behind it. That
// is the whole of what this file pins; the bucketing itself is covered in
// src/lib/contact-merge.test.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ContactEditDeleteActions from './ContactEditDeleteActions'

// One shared push so a test can say WHEN navigation happened relative to what
// the operator was shown (MAIL-GDPR.1 review fix 3).
const { push } = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children }) => children }))

const contact = { id: 'c1', first_name: 'Ann', name: 'Ann Byrne', email: 'ann@example.com' }

function impactPayload(overrides = {}) {
  return {
    success: true,
    data: {
      cascade_on_delete: [], keep_on_delete: [], redact_on_delete: [], block_delete: [],
      total_rows: 0, partial: false, ...overrides,
    },
  }
}

async function openDialog(payload) {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => payload }))
  render(<ContactEditDeleteActions contact={contact} canEdit canDelete />)
  fireEvent.click(screen.getByRole("button", { name: /delete/i }))
  await waitFor(() => expect(global.fetch).toHaveBeenCalled())
}

describe('ContactEditDeleteActions — the impact preview never contradicts itself', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup(); delete global.fetch })

  it('says "Safe to delete" only when the count was COMPLETE', async () => {
    await openDialog(impactPayload({ total_rows: 0, partial: false }))
    await waitFor(() => expect(screen.getByText(/safe to delete/i)).toBeTruthy())
    expect(screen.queryByText(/could not be counted/i)).toBeNull()
  })

  it('withholds "Safe to delete" when the preview is partial, even at zero rows', async () => {
    await openDialog(impactPayload({ total_rows: 0, partial: true }))
    await waitFor(() => expect(screen.getByText(/could not be counted/i)).toBeTruthy())
    // The contradiction: a caution that we could not look, above a claim that
    // there is nothing to lose.
    expect(screen.queryByText(/safe to delete/i)).toBeNull()
  })

  it('surfaces a blocker and withholds the type-to-confirm input', async () => {
    await openDialog(impactPayload({
      total_rows: 1,
      block_delete: [{ table: 'person_groups', column: 'primary_contact_id', label: 'person groups (primary)', count: 1 }],
    }))
    await waitFor(() => expect(screen.getByText(/person groups \(primary\)/i)).toBeTruthy())
    expect(screen.getByText(/blocking/i)).toBeTruthy()
    // person_groups.primary_contact_id is RESTRICT NOT NULL — the DELETE would
    // fail outright, so the operator must not be offered the confirm box.
    expect(screen.queryByText(/to confirm:/i)).toBeNull()
  })

  it('offers the confirm input when nothing blocks', async () => {
    await openDialog(impactPayload({
      total_rows: 3,
      cascade_on_delete: [{ table: 'notes', column: 'contact_id', label: 'notes', count: 3 }],
    }))
    await waitFor(() => expect(screen.getByText(/to confirm:/i)).toBeTruthy())
  })
})

// DELBLOCK.1 — the impact fetch that opened this dialog is a snapshot, and the
// DELETE route re-checks at click time. So a 409 is reachable with an empty
// `Blocking` section on screen: somebody added a person_group in between. It
// must not read as a generic "Delete failed" — the operator needs to know both
// what blocked it and, crucially, that nothing was scrubbed or deleted.
describe('ContactEditDeleteActions — a 409 refusal from DELETE', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup(); delete global.fetch })

  it('names the blocking rows and says nothing was destroyed', async () => {
    const blocker = { table: 'offer_purchases', column: 'contact_id', label: 'offer purchases', count: 2 }
    global.fetch = vi.fn(async (_url, opts) => (
      opts?.method === 'DELETE'
        ? {
            ok: false,
            status: 409,
            json: async () => ({
              success: false,
              error: 'Cannot delete this contact: 2 offer purchases. Reassign or remove those first.',
              data: { block_delete: [blocker] },
            }),
          }
        : { ok: true, json: async () => impactPayload({ total_rows: 0, partial: false }) }
    ))
    render(<ContactEditDeleteActions contact={contact} canEdit canDelete />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    await waitFor(() => expect(screen.getByText(/to confirm:/i)).toBeTruthy())

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ann' } })
    fireEvent.click(screen.getByRole('button', { name: /permanently delete/i }))

    await waitFor(() => expect(screen.getByText(/reassign or remove those first/i)).toBeTruthy())
    expect(screen.getByRole('listitem').textContent).toMatch(/2 offer purchases/i)
    expect(screen.getByText(/nothing was deleted or redacted/i)).toBeTruthy()
  })
})

// MAIL-GDPR.1 (review fix 3) — the DELETE route reports a partial mail scrub as
// `data.scrub_warnings`, and this dialog used to router.push('/contacts')
// without reading `data`, so the warning reached nobody. The delete has
// already happened by then, so the notice must never read as a failure or
// block anything: it says what was deleted, what could not be scrubbed, and
// offers the way out.
describe('ContactEditDeleteActions — a partial mail scrub on a successful DELETE', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup(); delete global.fetch })

  async function deleteWith(deleteBody) {
    global.fetch = vi.fn(async (_url, opts) => (
      opts?.method === 'DELETE'
        ? { ok: true, status: 200, json: async () => deleteBody }
        : { ok: true, json: async () => impactPayload({ total_rows: 0, partial: false }) }
    ))
    render(<ContactEditDeleteActions contact={contact} canEdit canDelete />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    await waitFor(() => expect(screen.getByText(/to confirm:/i)).toBeTruthy())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ann' } })
    fireEvent.click(screen.getByRole('button', { name: /permanently delete/i }))
  }

  it('a clean delete navigates straight away, as before', async () => {
    await deleteWith({ success: true })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/contacts'))
    expect(screen.queryByText(/mail scrub/i)).toBeNull()
  })

  it('shows the warning BEFORE navigating, says the delete itself succeeded, and navigates on Continue', async () => {
    await deleteWith({
      success: true,
      data: { scrub_warnings: [
        { table: 'email_inbox_messages', op: 'update', message: 'connection reset' },
        { table: 'storage.email-attachments', op: 'remove', message: 'storage down' },
      ] },
    })
    await waitFor(() => expect(screen.getByText(/2 mail scrub steps failed/i)).toBeTruthy())
    expect(screen.getByText(/email_inbox_messages, storage\.email-attachments/)).toBeTruthy()
    // Not a failure: the contact is gone and the copy must say so.
    expect(screen.getByText(/was deleted/i)).toBeTruthy()
    expect(screen.queryByText(/delete failed/i)).toBeNull()
    expect(push).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(push).toHaveBeenCalledWith('/contacts')
  })
})
