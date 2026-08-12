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

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
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
