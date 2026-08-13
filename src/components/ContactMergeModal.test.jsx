// @vitest-environment jsdom
//
// MERGEPREV.1 — the merge preview must promise exactly what the merge does.
//
// The modal used to keep its own copy of the field rule, commented as
// "Mirrors src/lib/contact-merge.js#pickMergedFields". It had drifted both
// ways: it previewed `pipeline_stage_slug`, which the merge does not write,
// and it omitted five fields the merge does. Nothing compared the two copies,
// so neither drift was visible.
//
// The load-bearing test here is the FIRST one: it imports the real
// pickMergedFields and asserts the modal renders a row for every field it
// returns and none that it doesn't. That is the assertion a future edit to
// either side has to keep passing, which is the whole point of deleting the
// second copy.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import ContactMergeModal from './ContactMergeModal'
import { pickMergedFields } from '@/lib/contact-merge'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

// The survivor is deliberately missing `phone` and `label` so the
// fill-from-loser branch is exercised, and both carry a DIFFERENT
// pipeline_stage_slug so a leaked stage preview would be unmistakable.
const survivor = {
  id: 'c1', name: 'Ann Byrne', first_name: 'Ann', last_name: 'Byrne',
  email: 'ann@example.com', phone: null, label: null,
  glofox_member_id: 'GF-1', trial_credits_remaining: 2,
  lead_source: 'walk-in', pipeline_stage_slug: 'member', created_at: '2026-01-01',
}
const loser = {
  id: 'c2', name: 'A Byrne', first_name: 'A', last_name: 'Byrne',
  email: 'a.byrne@example.com', phone: '+353871234567', label: 'VIP',
  glofox_member_id: 'GF-2', trial_credits_remaining: 0,
  lead_source: 'classpass', pipeline_stage_slug: 'cold_lead', created_at: '2026-02-01',
}

async function openConfirmStep() {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, data: { cascade_on_delete: [], keep_on_delete: [], redact_on_delete: [], block_delete: [], total_rows: 0, partial: false } }),
  }))
  render(<ContactMergeModal contactIds={['c1', 'c2']} contacts={[survivor, loser]} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /continue/i }))
  await waitFor(() => expect(screen.getByText(/after merge/i)).toBeTruthy())
}

describe('ContactMergeModal — the preview matches the merge (MERGEPREV.1)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup(); delete global.fetch })

  it('renders a row for every field pickMergedFields returns, and no others', async () => {
    await openConfirmStep()
    const list = screen.getByText(/after merge/i).parentElement
    const rendered = Array.from(list.querySelectorAll('li')).map(li => li.textContent)

    const merged = pickMergedFields(survivor, loser)
    const expected = Object.entries(merged).filter(([, v]) => v !== null && v !== undefined && v !== '')

    // Every field the merge writes is shown...
    expect(rendered).toHaveLength(expected.length)
    for (const [field, value] of expected) {
      expect(
        rendered.some(t => t.includes(String(value))),
        `no row rendered the merged value for ${field}`,
      ).toBe(true)
    }
  })

  it('never previews a merged Stage — it is trigger-derived, not merged', async () => {
    await openConfirmStep()
    const list = screen.getByText(/after merge/i).parentElement
    const rows = Array.from(list.querySelectorAll('li')).map(li => li.textContent).join(' ')

    // Neither contact's stage may appear as an outcome row. The trigger sets
    // the survivor's stage from the most recent open deal across BOTH, which
    // is frequently the loser's — the opposite of "survivor wins unless empty".
    // Match the ROW LABEL, not a bare word: "Glofox member ID" legitimately
    // contains "member", which is what made the first version of this
    // assertion fail for the wrong reason.
    expect(rows).not.toMatch(/Stage:/)
    expect(rows).not.toContain('cold_lead')
    // …and the operator is told what actually decides it.
    expect(screen.getByText(/recalculated after the merge from the combined deals/i)).toBeTruthy()
  })

  it('fills an empty survivor field from the loser, matching the merge rule', async () => {
    await openConfirmStep()
    // survivor.phone is null, loser has one → the loser's wins.
    expect(screen.getByText(/\+353871234567/)).toBeTruthy()
    // survivor.email is set → survivor wins, loser's must not appear.
    expect(screen.queryByText(/a\.byrne@example\.com/)).toBeNull()
  })

  it('still shows each contact\'s OWN current stage in the picker — that part is factual', () => {
    render(<ContactMergeModal contactIds={['c1', 'c2']} contacts={[survivor, loser]} onClose={vi.fn()} />)
    expect(screen.getByText(/Stage: member/)).toBeTruthy()
    expect(screen.getByText(/Stage: cold_lead/)).toBeTruthy()
  })
})
